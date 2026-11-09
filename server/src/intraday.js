// Intraday signals computed against the live price, from today's regular-session 1-minute bars.
// These change minute to minute, unlike the daily-bar signals in analysis.js.

import { ema, rsi, last } from './indicators.js';
import { clamp, pct, f2, signal, aggregate } from './scoring.js';
import { getChart } from './yahoo.js';

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
  const price = last(bars).close;
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
  const rvol = d5 ? relativeVolume(bars, d5.bars, q.gmtOffset, sess.start, Math.min(now, sess.end)) : null;
  const dayMove = pct(price, bars[0].open);
  if (rvol != null) {
    const dir = Math.sign(dayMove || 0);
    const score = rvol >= 1.2 ? dir * clamp((rvol - 1) / 1.5) : 0;
    out.push(
      signal(
        'Intraday',
        'Relative volume',
        score,
        1.5,
        `${rvol.toFixed(2)}× normal`,
        rvol >= 1.5
          ? `Heavy volume (${rvol.toFixed(1)}× usual for this time of day) is backing today's ${dir >= 0 ? 'rise' : 'drop'}.`
          : rvol < 0.7
          ? 'Light volume: moves on low participation are less reliable.'
          : 'Volume is about normal for this time of day.',
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

  // 4. Short-term trend: EMA 9 vs 21 on 1-minute closes
  const closes = bars.map((b) => b.close);
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

  return {
    available: true,
    isLive,
    price,
    score: aggregate(out),
    signals: out,
    vwap: vw?.vwap ?? null,
    rvol,
    dayMovePct: dayMove,
    minutesIntoSession: elapsedMin,
  };
}
