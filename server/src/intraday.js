// Intraday signals computed against the live price, from today's regular-session 1-minute bars.
// These change minute to minute, unlike the daily-bar signals in analysis.js.

import { ema, rsi, last } from './indicators.js';
import { clamp, pct, f2, signal, aggregate } from './scoring.js';
import { getChart, getExtendedSession } from './yahoo.js';

const MIN = 60;

/** Volume-weighted average price and the volume-weighted std dev around it. */
function vwapStats(bars) {
  let pv = 0, v = 0;
  for (const b of bars) {
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * b.volume;
    v += b.volume;
  }
  if (!v) return null;
  const vwap = pv / v;
  let varSum = 0;
  for (const b of bars) varSum += b.volume * ((b.high + b.low + b.close) / 3 - vwap) ** 2;
  return { vwap, sd: Math.sqrt(varSum / v) };
}

/** Group 5-minute bars of previous sessions by trading day (exchange-local date). */
function priorSessions(bars5m, offset, todayStart) {
  const days = new Map();
  for (const b of bars5m) {
    if (b.time >= todayStart) continue;
    const day = Math.floor((b.time + offset) / 86400);
    if (!days.has(day)) days.set(day, []);
    days.get(day).push(b);
  }
  return [...days.values()];
}

/**
 * Relative volume: today's cumulative volume vs. the average cumulative volume of the
 * previous sessions at the same minute of the day (accounts for the U-shaped volume curve).
 */
function relativeVolume(todayBars, bars5m, offset, sessionStart, now) {
  const elapsed = now - sessionStart;
  const todayVol = todayBars.reduce((s, b) => s + b.volume, 0);
  const prior = priorSessions(bars5m, offset, sessionStart)
    .map((day) => {
      const open = day[0].time;
      return day.filter((b) => b.time - open < elapsed).reduce((s, b) => s + b.volume, 0);
    })
    .filter((v) => v > 0);
  if (!prior.length || !todayVol) return null;
  return todayVol / (prior.reduce((a, b) => a + b, 0) / prior.length);
}

export async function intradaySignals(symbol) {
  const [d1, d5] = await Promise.all([getChart(symbol, '1d'), getChart(symbol, '5d', { ttlMs: 60_000 }).catch(() => null)]);
  const q = d1.quote;
  const sess = q.session;
  if (!sess) return { available: false, reason: 'No trading-session data for this symbol.' };

  const now = Math.floor(Date.now() / 1000);
  const bars = d1.bars.filter((b) => b.time >= sess.start && b.time < sess.end);
  const elapsedMin = Math.floor((Math.min(now, sess.end) - sess.start) / MIN);
  if (bars.length < 5) {
    return {
      available: false,
      reason: now < sess.start ? 'Regular session has not opened yet.' : 'Not enough trading today for intraday signals.',
    };
  }
  const isLive = q.marketState === 'REGULAR';
  // Session the signals describe. Outside 9:30-16:00 the regular-session indicators (VWAP,
  // opening range, RSI…) are measured against the latest extended-hours price, so the read
  // reflects where the stock is trading *now*, not where it closed.
  const session = q.marketState === 'PRE' ? 'pre' : q.marketState === 'POST' ? 'post' : q.marketState === 'REGULAR' ? 'regular' : 'closed';
  const extPrice = (session === 'pre' || session === 'post') && q.extPrice != null ? q.extPrice : null;
  const regularClose = last(bars).close;
  const price = extPrice ?? regularClose;
  const traded = bars.filter((b) => b.volume > 0);
  const out = [];

  // 1. VWAP — the average price paid today. Institutions benchmark against it.
  const vw = vwapStats(traded.length >= 5 ? traded : bars);
  if (vw && vw.sd > 0) {
    const dev = (price - vw.vwap) / vw.sd;
    const extended = Math.abs(dev) > 2;
    const score = extended ? Math.sign(dev) * 0.3 : clamp(dev / 1.5) * 0.85;
    out.push(
      signal(
        'Intraday',
        'VWAP',
        score,
        2,
        `${f2(vw.vwap)} (${dev >= 0 ? '+' : ''}${dev.toFixed(1)}σ)`,
        extended
          ? `Price is stretched ${dev > 0 ? 'above' : 'below'} VWAP (over 2σ). Chasing here is risky; pullbacks toward VWAP are common.`
          : `Price is ${dev >= 0 ? 'above' : 'below'} VWAP, so ${dev >= 0 ? 'buyers' : 'sellers'} are in control today.`,
      ),
    );
  }

  // 2. Relative volume at this time of day
  // Regular-session only: compares today's 9:30-16:00 volume with past sessions'. After the
  // close it describes the finished session (labelled as such), since extended-hours volume
  // isn't in the minute bars.
  const rvol = d5 ? relativeVolume(bars, d5.bars, q.gmtOffset, sess.start, Math.min(now, sess.end)) : null;
  const dayMove = pct(regularClose, bars[0].open);
  if (rvol != null) {
    const dir = Math.sign(dayMove || 0);
    const score = rvol >= 1.2 ? dir * clamp((rvol - 1) / 1.5) : 0;
    const when = session === 'regular' ? 'for this time of day' : 'for a full session';
    out.push(
      signal(
        'Intraday',
        session === 'regular' ? 'Relative volume' : "Today's volume",
        score,
        1.5,
        `${rvol.toFixed(2)}× normal`,
        rvol >= 1.5
          ? `Heavy volume (${rvol.toFixed(1)}× usual ${when}) ${session === 'regular' ? 'is backing' : 'backed'} today's ${dir >= 0 ? 'rise' : 'drop'}.`
          : rvol < 0.7
          ? `Light volume ${when}: moves on low participation are less reliable.`
          : `Volume ${session === 'regular' ? 'is' : 'was'} about normal ${when}.`,
      ),
    );
  }

  // 3. Opening-range breakout (first 15 minutes)
  const orBars = bars.filter((b) => b.time < sess.start + 15 * MIN);
  if (elapsedMin >= 20 && orBars.length >= 3) {
    const orH = Math.max(...orBars.map((b) => b.high));
    const orL = Math.min(...orBars.map((b) => b.low));
    let score, detail;
    if (price > orH) {
      score = 0.75;
      detail = `Broke above the opening-range high (${f2(orH)}), a common intraday continuation signal.`;
    } else if (price < orL) {
      score = -0.75;
      detail = `Broke below the opening-range low (${f2(orL)}), a common intraday breakdown signal.`;
    } else {
      score = ((price - orL) / (orH - orL || 1) - 0.5) * 0.4;
      detail = `Still inside the first 15 minutes' range (${f2(orL)}–${f2(orH)}), so no breakout yet.`;
    }
    out.push(signal('Intraday', 'Opening range', score, 1.5, `${f2(orL)}–${f2(orH)}`, detail));
  }

  // 4. Short-term trend: EMA 9 vs 21 on 1-minute closes (extended-hours closes appended, so
  // the trend keeps updating after 16:00 / before 9:30).
  const extBars = extPrice != null ? d1.bars.filter((b) => (session === 'post' ? b.time >= sess.end : b.time < sess.start)) : [];
  const closes = [...bars, ...(session === 'post' ? extBars : [])].map((b) => b.close);
  const e9 = last(ema(closes, 9)), e21 = last(ema(closes, 21));
  if (e9 != null && e21 != null) {
    const spread = ((e9 - e21) / price) * 100;
    out.push(
      signal(
        'Intraday',
        'Short-term trend',
        clamp(spread / 0.25),
        1,
        `EMA9 ${e9 > e21 ? '>' : '<'} EMA21`,
        `The 1-minute trend is ${e9 > e21 ? 'up' : 'down'} (fast average ${e9 > e21 ? 'above' : 'below'} slow).`,
      ),
    );
  }

  // 5. Intraday RSI on 5-minute closes (mean-reversion at extremes)
  const c5 = [];
  for (let i = 4; i < closes.length; i += 5) c5.push(closes[i]);
  if (closes.length % 5) c5.push(last(closes));
  const r5 = last(rsi(c5, 14));
  if (r5 != null) {
    const score = r5 > 75 ? -0.6 : r5 < 25 ? 0.6 : ((r5 - 50) / 25) * 0.4;
    out.push(
      signal(
        'Intraday',
        'Intraday RSI (5m)',
        score,
        0.75,
        r5.toFixed(1),
        r5 > 75 ? 'Overbought on the 5-minute chart; short-term pullback risk.' : r5 < 25 ? 'Oversold on the 5-minute chart; bounce potential.' : 'Intraday momentum is not at an extreme.',
      ),
    );
  }

  // 6. Extended-hours move (pre-market or after hours), with its volume from Nasdaq.
  let ext = null;
  if (extPrice != null) {
    // After hours: vs the official close (meta price), not the last 1-minute bar's close.
    const ref = session === 'post' ? q.price ?? regularClose : q.prevClose;
    const chg = ref ? ((extPrice - ref) / ref) * 100 : 0;
    const info = await getExtendedSession(q.symbol, session);
    // Yardstick: average regular-session volume per day over the last 5 sessions. Extended
    // hours usually trade 2-5% of that; 10%+ is unusual and usually news-driven.
    const avgDaily = d5 ? d5.bars.reduce((s, b) => s + b.volume, 0) / Math.max(1, new Set(d5.bars.map((b) => Math.floor((b.time + q.gmtOffset) / 86400))).size) : null;
    const volPct = info?.volume && avgDaily ? (info.volume / avgDaily) * 100 : null;
    // A move only means something with real participation, and a tiny move means little
    // however heavy the volume. Scale by both.
    const conviction = volPct == null ? 0.5 : clamp(volPct / 5, 0.2, 1);
    const sizeWord = Math.abs(chg) < 0.25 ? 'flat' : Math.abs(chg) < 1 ? 'small' : Math.abs(chg) < 3 ? 'notable' : 'large';
    const label = session === 'post' ? 'After-hours move' : 'Pre-market move';
    ext = { session, price: extPrice, ref, changePct: chg, volume: info?.volume ?? null, volPctOfDay: volPct, high: info?.high ?? null, low: info?.low ?? null };
    out.push(
      signal(
        'Intraday',
        label,
        clamp(chg / 2) * conviction,
        1.5,
        `${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%${info?.volume ? ` · vol ${fmtCompact(info.volume)}` : ''}`,
        (sizeWord === 'flat'
          ? `${session === 'post' ? 'Since the 4:00 PM close' : 'Versus yesterday’s close'} the price is essentially unchanged (${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)`
          : `${session === 'post' ? 'Since the 4:00 PM close' : 'Versus yesterday’s close'} the stock is ${chg >= 0 ? 'up' : 'down'} ${Math.abs(chg).toFixed(2)}%, a ${sizeWord} move`) +
          (volPct == null
            ? '. Volume for this session isn’t available, so treat any move with caution.'
            : volPct < 1
            ? ` on thin volume (${volPct.toFixed(1)}% of a normal day), so it may not hold at the open.`
            : sizeWord === 'flat'
            ? ` on ${volPct.toFixed(1)}% of a normal day’s volume, so no directional signal.`
            : ` on ${volPct.toFixed(1)}% of a normal day’s volume, ${volPct >= 5 ? 'heavy for extended hours, so more likely to carry into the next session' : 'which is moderate'}.`),
      ),
    );
  }

  return {
    available: true,
    isLive,
    session,
    price,
    score: aggregate(out),
    signals: out,
    vwap: vw?.vwap ?? null,
    rvol,
    dayMovePct: dayMove,
    minutesIntoSession: elapsedMin,
    extended: ext,
  };
}

const fmtCompact = (v) => new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(v);
