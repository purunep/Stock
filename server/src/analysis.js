// Rule-based buy/sell scoring. Combines daily-chart technical indicators with Wall Street
// analyst consensus into one score from -100 (strong sell) to +100 (strong buy).
//
// Every signal returns a score in [-1, 1] and has a weight. The overall score is the
// weighted average x 100. This is a transparent heuristic, NOT financial advice.

import { sma, rsi, macd, bollinger, atr, last } from './indicators.js';
import { getChart, getAnalyst } from './yahoo.js';
import { clamp, pct, f2, signal, aggregate } from './scoring.js';
import { intradaySignals } from './intraday.js';
import { buildSamples, hitRate } from './backtest.js';
import { alignmentFor } from './alignment.js';

/** Index of the most recent sign change of (a - b) within the last `lookback` bars, or -1. */
function lastCross(a, b, lookback) {
  for (let i = a.length - 1; i > 0 && i >= a.length - lookback; i--) {
    if (a[i] == null || b[i] == null || a[i - 1] == null || b[i - 1] == null) continue;
    const now = a[i] - b[i], prev = a[i - 1] - b[i - 1];
    if (now > 0 && prev <= 0) return { index: i, dir: 'up', ago: a.length - 1 - i };
    if (now < 0 && prev >= 0) return { index: i, dir: 'down', ago: a.length - 1 - i };
  }
  return null;
}

function technicalSignals(bars) {
  const closes = bars.map((b) => b.close);
  const price = last(closes);
  const n = closes.length;
  const out = [];

  // 1. Trend vs. moving averages
  const s50 = sma(closes, 50), s200 = sma(closes, 200);
  const m50 = last(s50), m200 = last(s200);
  if (m50 != null) {
    const d50 = pct(price, m50);
    const d200 = m200 != null ? pct(price, m200) : null;
    let score = clamp(d50 / 8) * 0.5 + (d200 != null ? clamp(d200 / 15) * 0.5 : clamp(d50 / 8) * 0.5);
    const where =
      d200 == null
        ? `${d50 >= 0 ? 'above' : 'below'} its 50-day average`
        : d50 >= 0 && d200 >= 0
        ? 'above both its 50- and 200-day averages (uptrend)'
        : d50 < 0 && d200 < 0
        ? 'below both its 50- and 200-day averages (downtrend)'
        : `${d50 >= 0 ? 'above' : 'below'} its 50-day but ${d200 >= 0 ? 'above' : 'below'} its 200-day average (mixed)`;
    out.push(
      signal(
        'Technical',
        'Price trend',
        score,
        2,
        `${d50 >= 0 ? '+' : ''}${d50.toFixed(1)}% vs 50D${d200 != null ? `, ${d200 >= 0 ? '+' : ''}${d200.toFixed(1)}% vs 200D` : ''}`,
        `Price is ${where}.`,
      ),
    );
  }

  // 2. Golden / death cross
  if (m50 != null && m200 != null) {
    const cross = lastCross(s50, s200, 30);
    const above = m50 > m200;
    let score = above ? 0.5 : -0.5;
    let detail = above ? '50-day average is above the 200-day (long-term bullish structure).' : '50-day average is below the 200-day (long-term bearish structure).';
    if (cross) {
      score = cross.dir === 'up' ? 1 : -1;
      detail = `${cross.dir === 'up' ? 'Golden' : 'Death'} cross ${cross.ago} trading day${cross.ago === 1 ? '' : 's'} ago — the 50-day crossed ${cross.dir === 'up' ? 'above' : 'below'} the 200-day.`;
    }
    out.push(signal('Technical', '50/200-day cross', score, 1, above ? '50D > 200D' : '50D < 200D', detail));
  }

  // 3. RSI(14) — momentum with overbought/oversold extremes
  const r = last(rsi(closes, 14));
  if (r != null) {
    let score, detail;
    if (r >= 70) {
      score = -0.6 - (r - 70) / 75;
      detail = 'Overbought — the rally may be stretched and due for a pullback.';
    } else if (r <= 30) {
      score = 0.6 + (30 - r) / 75;
      detail = 'Oversold — selling may be exhausted; rebound potential.';
    } else if (r >= 50) {
      score = ((r - 50) / 20) * 0.4;
      detail = 'Positive momentum without being overbought.';
    } else {
      score = -((50 - r) / 20) * 0.4;
      detail = 'Weak momentum but not yet oversold.';
    }
    out.push(signal('Technical', 'RSI (14)', score, 1.5, r.toFixed(1), detail));
  }

  // 4. MACD (12, 26, 9)
  const m = macd(closes);
  const ml = last(m.line), ms = last(m.signal), mh = last(m.hist);
  if (ml != null && ms != null) {
    const prevHist = m.hist[n - 2];
    const cross = lastCross(m.line, m.signal, 5);
    const norm = clamp(mh / (price * 0.01)); // histogram relative to 1% of price
    let score = norm * 0.6 + (mh > 0 ? 0.2 : -0.2) + (prevHist != null ? (mh > prevHist ? 0.2 : -0.2) : 0);
    let detail = `MACD is ${ml > ms ? 'above' : 'below'} its signal line and the histogram is ${prevHist != null && mh > prevHist ? 'rising' : 'falling'}.`;
    if (cross) {
      score = cross.dir === 'up' ? Math.max(score, 0.7) : Math.min(score, -0.7);
      detail = `${cross.dir === 'up' ? 'Bullish' : 'Bearish'} MACD crossover ${cross.ago === 0 ? 'today' : `${cross.ago} day${cross.ago === 1 ? '' : 's'} ago`}.`;
    }
    out.push(signal('Technical', 'MACD', score, 1.5, `${f2(ml)} / ${f2(ms)}`, detail));
  }

  // 5. Bollinger Bands (20, 2) — position within the band
  const bb = bollinger(closes, 20, 2);
  const up = last(bb.upper), lo = last(bb.lower);
  if (up != null && lo != null && up > lo) {
    const b = (price - lo) / (up - lo); // %B: 0 = lower band, 1 = upper band
    let score, detail;
    if (b > 1) {
      score = -0.8;
      detail = 'Trading above the upper band — statistically extended.';
    } else if (b < 0) {
      score = 0.8;
      detail = 'Trading below the lower band — statistically oversold.';
    } else {
      score = (0.5 - b) * 0.6;
      detail = `Within the bands, ${b > 0.5 ? 'closer to the upper' : 'closer to the lower'} band.`;
    }
    out.push(signal('Technical', 'Bollinger %B', score, 0.75, (b * 100).toFixed(0) + '%', detail));
  }

  // 6. Rate of change — 1 month and 3 months
  const r21 = n > 21 ? pct(price, closes[n - 22]) : null;
  const r63 = n > 63 ? pct(price, closes[n - 64]) : null;
  if (r21 != null) {
    const score = clamp(r21 / 10) * 0.5 + (r63 != null ? clamp(r63 / 20) * 0.5 : clamp(r21 / 10) * 0.5);
    out.push(
      signal(
        'Technical',
        'Momentum',
        score,
        1.25,
        `1M ${r21 >= 0 ? '+' : ''}${r21.toFixed(1)}%${r63 != null ? `, 3M ${r63 >= 0 ? '+' : ''}${r63.toFixed(1)}%` : ''}`,
        score > 0.15 ? 'Price has been rising over recent months.' : score < -0.15 ? 'Price has been falling over recent months.' : 'Little net movement over recent months.',
      ),
    );
  }

  // 7. Volume confirmation — is recent volume backing the move?
  const vols = bars.map((b) => b.volume || 0);
  const v20 = last(sma(vols, 20));
  const v5 = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  if (v20 && v5 && n > 5) {
    const ratio = v5 / v20;
    const move = pct(price, closes[n - 6]);
    const dir = Math.sign(move);
    const score = ratio > 1.15 ? dir * clamp((ratio - 1) / 1) : 0;
    out.push(
      signal(
        'Technical',
        'Volume',
        score,
        0.5,
        `${ratio.toFixed(2)}× avg`,
        ratio > 1.15
          ? `Above-average volume is confirming the ${dir >= 0 ? 'up' : 'down'} move over the last week.`
          : 'Volume is near average — no strong confirmation either way.',
      ),
    );
  }

  return { signals: out, levels: keyLevels(bars, { m50, m200 }) };
}

function keyLevels(bars, { m50, m200 }) {
  const recent = bars.slice(-20);
  return {
    support: Math.min(...recent.map((b) => b.low)),
    resistance: Math.max(...recent.map((b) => b.high)),
    sma50: m50,
    sma200: m200,
  };
}

function analystSignals(a, price) {
  if (!a) return [];
  const out = [];
  if (a.recommendationMean != null) {
    // Yahoo scale: 1 strong buy, 2 buy, 3 hold, 4 sell, 5 strong sell
    const score = (3 - a.recommendationMean) / 1.5;
    const label =
      a.recommendationMean <= 1.5 ? 'Strong Buy' : a.recommendationMean <= 2.5 ? 'Buy' : a.recommendationMean <= 3.5 ? 'Hold' : a.recommendationMean <= 4.5 ? 'Sell' : 'Strong Sell';
    out.push(
      signal(
        'Analysts',
        'Analyst consensus',
        score,
        2.5,
        `${label} (${a.recommendationMean.toFixed(2)})`,
        `Average rating from ${a.analystCount ?? 'several'} analysts on a 1 (strong buy) to 5 (strong sell) scale.`,
      ),
    );
  }
  if (a.targetMean != null && price) {
    const up = pct(a.targetMean, price);
    out.push(
      signal(
        'Analysts',
        'Price target',
        clamp(up / 20),
        2,
        `${up >= 0 ? '+' : ''}${up.toFixed(1)}% to ${a.targetMean.toFixed(2)}`,
        `Mean 12-month target ${a.targetMean.toFixed(2)} (range ${f2(a.targetLow)}–${f2(a.targetHigh)}) implies ${up >= 0 ? 'upside' : 'downside'} of ${Math.abs(up).toFixed(1)}%.`,
      ),
    );
  }
  return out;
}

/**
 * Concrete price levels for the current price, sized by ATR (typical daily range).
 * - Buy/Strong Buy : enter near the current price, stop 1.5 ATR below, target = nearest of
 *                    analyst target / 20-day resistance at least 1.5 ATR away (else +3 ATR).
 * - Sell/Strong Sell: exit/avoid; a short-side view has stop 1.5 ATR above, target = nearest of
 *                    analyst target / 20-day support at least 1.5 ATR below (else -3 ATR).
 * - Hold           : wait for a pullback to support; target = resistance; stop below support.
 */
function tradePlan(score, price, a, levels, analyst) {
  if (a == null || !price) return null;
  const round = (v) => Math.round(v * 100) / 100;
  let bias, entry, stop, target, note;

  // Levels closer than 1.5 ATR aren't worth targeting; fall back to a 3 ATR move.
  if (score >= 15) {
    bias = 'long';
    entry = price;
    stop = price - 1.5 * a;
    const up = [analyst?.targetMean, levels.resistance].filter((t) => t != null && t >= price + 1.5 * a);
    target = up.length ? Math.min(...up) : price + 3 * a;
    note = 'Buy around the current price. Exit if it falls to the stop level.';
  } else if (score <= -15) {
    bias = 'short';
    entry = price;
    stop = price + 1.5 * a;
    const down = [analyst?.targetMean, levels.support].filter((t) => t != null && t <= price - 1.5 * a);
    target = down.length ? Math.max(...down) : price - 3 * a;
    note = 'Avoid buying. Holders may consider selling; a short-side view is invalidated above the stop level.';
  } else {
    bias = 'neutral';
    entry = Math.min(price, Math.max(levels.support, price - a));
    stop = entry - 1.5 * a;
    target = levels.resistance > price ? levels.resistance : price + 2 * a;
    note = 'No clear edge. Consider waiting for a dip to the entry level, or for a break above resistance.';
  }

  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  return {
    bias,
    reference: round(price),
    entry: round(entry),
    stop: round(stop),
    target: round(target),
    atr: round(a),
    riskReward: risk ? Math.round((reward / risk) * 10) / 10 : null,
    note,
  };
}

const VERDICTS = [
  { min: 45, label: 'Strong Buy', key: 'strong-buy' },
  { min: 15, label: 'Buy', key: 'buy' },
  { min: -15, label: 'Hold', key: 'hold' },
  { min: -45, label: 'Sell', key: 'sell' },
  { min: -Infinity, label: 'Strong Sell', key: 'strong-sell' },
];

const verdictFor = (score) => VERDICTS.find((v) => score >= v.min);

function agreementOf(signals, score) {
  const dir = Math.sign(score);
  const totalW = signals.reduce((s, x) => s + x.weight, 0);
  const agreeW = signals
    .filter((x) => (dir === 0 ? x.stance === 'neutral' : Math.sign(x.score) === dir && x.stance !== 'neutral'))
    .reduce((s, x) => s + x.weight, 0);
  return totalW ? agreeW / totalW : 0;
}

/**
 * Probability label combining the historical hit rate with how well the
 * daily and intraday views agree. Never claims "high" without both.
 */
function probabilityOf(hist, liveScore, dailyScore, intraday, earningsSoon, align) {
  const dir = liveScore >= 15 ? 1 : liveScore <= -15 ? -1 : 0;
  if (!hist) return { level: 'Unknown', direction: dir, reason: 'Not enough price history to measure a hit rate.' };

  // Map the direction-neutral stats onto the way the live verdict points (Hold reads as "up").
  const want = dir === -1 ? -1 : 1;
  const winRate = want === 1 ? hist.upRate : 100 - hist.upRate;
  const baseRate = want === 1 ? hist.baseUpRate : 100 - hist.baseUpRate;
  const edge = winRate - baseRate;
  const barrier = hist.barrier && {
    ...hist.barrier,
    targetFirstPct: want === 1 ? hist.barrier.upFirstPct : 100 - hist.barrier.upFirstPct,
    baseTargetFirstPct: want === 1 ? hist.barrier.baseUpFirstPct : 100 - hist.barrier.baseUpFirstPct,
  };

  const iScore = intraday?.available ? intraday.score : null;
  const intradayAgrees = iScore != null && dir !== 0 && Math.sign(iScore) === dir && Math.abs(iScore) >= 15;
  const intradayDisagrees = iScore != null && dir !== 0 && Math.sign(iScore) === -dir && Math.abs(iScore) >= 15;
  const dailyDisagrees = dir !== 0 && Math.sign(dailyScore) === -dir && Math.abs(dailyScore) >= 15;

  let level;
  if (dir === 0) level = 'No edge';
  else if (winRate >= 60 && edge >= 5) level = 'High';
  else if (winRate >= 53 && edge >= 0) level = 'Moderate';
  else level = 'Low';

  const cap = (to) => {
    const order = ['Low', 'Moderate', 'High'];
    if (order.indexOf(level) > order.indexOf(to)) level = to;
  };
  // Timeframe + market agreement with the call's direction.
  const want2 = dir === 1 ? 'up' : 'down';
  const tfWith = align ? (dir === 1 ? align.up : align.down) : null;
  const tfAgainst = align ? (dir === 1 ? align.down : align.up) : null;
  const tfAligned = align && dir !== 0 && align.consensus === want2;
  const tfConflict = align && dir !== 0 && tfAgainst >= 3;
  const mkt = align?.market?.stance;
  const marketAgainst = dir !== 0 && mkt && mkt !== 'mixed' && mkt !== want2;

  if (dir !== 0) {
    if (!intradayAgrees) cap('Moderate'); // "High" needs the live price to confirm
    if (align && !tfAligned) cap('Moderate'); // ...and at least 3 of 4 timeframes
    if (marketAgainst) cap('Moderate'); // ...and not fighting the overall market
    if (intradayDisagrees || dailyDisagrees || tfConflict) cap('Low');
    if (earningsSoon || hist.cases < 25) cap('Moderate');
  }

  const word = want === 1 ? 'higher' : 'lower';
  const reasons = [
    `In ${hist.cases} past days with a similar technical setup, price was ${word} ${hist.horizonDays} days later ${winRate}% of the time (vs ${baseRate}% on an average day).`,
  ];
  if (dir === 0) reasons.push('The live score is in the Hold zone, so there is no directional call to rate.');
  if (intradayAgrees) reasons.push('Intraday signals at the live price confirm the direction.');
  if (intradayDisagrees) reasons.push('Intraday signals at the live price point the other way.');
  if (dailyDisagrees) reasons.push('The daily trend points the other way.');
  if (align && dir !== 0) {
    if (tfAligned) reasons.push(`${tfWith} of ${align.total} timeframes trend ${want2}.`);
    else if (tfConflict) reasons.push(`${tfAgainst} of ${align.total} timeframes trend the other way.`);
    else reasons.push(`Only ${tfWith} of ${align.total} timeframes trend ${want2}, so the bigger picture is mixed.`);
  }
  if (marketAgainst) reasons.push(`The S&P 500 is trending ${mkt}, against this call.`);
  else if (dir !== 0 && mkt === want2) reasons.push(`The S&P 500 is also trending ${mkt}.`);
  if (earningsSoon) reasons.push('Earnings are due within a week and can override technicals.');
  if (hist.cases < 25) reasons.push('Few comparable days, so the estimate is rough.');

  return {
    level,
    direction: dir,
    winRate,
    baseRate,
    edge,
    barrier,
    checks: {
      intraday: dir === 0 ? null : intradayAgrees ? 'pass' : intradayDisagrees ? 'fail' : 'neutral',
      timeframes: !align || dir === 0 ? null : tfAligned ? 'pass' : tfConflict ? 'fail' : 'neutral',
      market: !align?.market || dir === 0 ? null : marketAgainst ? 'fail' : mkt === want2 ? 'pass' : 'neutral',
      history: dir === 0 ? null : winRate >= 60 && edge >= 5 ? 'pass' : winRate >= 53 && edge >= 0 ? 'neutral' : 'fail',
    },
    reason: reasons.join(' '),
  };
}

export async function analyse(symbol) {
  const [daily, analyst, intraday, d1] = await Promise.all([
    getChart(symbol, '2y', { ttlMs: 60_000 }),
    getAnalyst(symbol),
    intradaySignals(symbol).catch((e) => ({ available: false, reason: e.message })),
    getChart(symbol, '1d').catch(() => null),
  ]);
  const align = await alignmentFor(symbol, d1?.quote, d1?.bars).catch(() => null);
  const bars = daily.bars;
  if (bars.length < 30) {
    const err = new Error('Not enough price history to analyse this symbol');
    err.status = 422;
    throw err;
  }
  // Use the live price for the forming daily bar so the score reflects "now".
  const price = daily.quote.price ?? last(bars).close;
  const liveBars = bars.slice();
  const lb = liveBars[liveBars.length - 1];
  liveBars[liveBars.length - 1] = { ...lb, close: price, high: Math.max(lb.high, price), low: Math.min(lb.low, price) };

  const tech = technicalSignals(liveBars.slice(-260)); // ~1 trading year, as before
  const an = analystSignals(analyst, price);
  const signals = [...tech.signals, ...an];

  const score = aggregate(signals);
  const verdict = verdictFor(score);
  const agreement = agreementOf(signals, score);
  const confidence = agreement >= 0.7 ? 'High' : agreement >= 0.45 ? 'Medium' : 'Low';

  // Historical hit rate for the technical score (analyst data has no history, so it's excluded).
  const samples = buildSamples(symbol, liveBars, (h) => aggregate(technicalSignals(h.slice(-260)).signals));
  const technicalScore = aggregate(tech.signals);
  const history = hitRate(samples, technicalScore);

  // "Live" verdict: the daily view nudged by intraday conditions at the live price.
  const liveScore =
    intraday.available && intraday.score != null ? Math.round(score * 0.65 + intraday.score * 0.35) : score;
  const liveVerdict = verdictFor(liveScore);

  // Price the trade levels are built from: the extended-hours price when the stock is trading
  // pre-market / after hours, otherwise the regular price. (The daily technicals above stay on
  // the official close, since daily bars are close-to-close.)
  const session = intraday.session || (daily.quote.marketState === 'REGULAR' ? 'regular' : 'closed');
  const tradePrice = intraday.extended?.price ?? daily.quote.extPrice ?? price;

  const daysToEarnings = analyst?.nextEarnings ? Math.ceil((analyst.nextEarnings * 1000 - Date.now()) / 86400_000) : null;
  const earningsSoon = daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 7;

  return {
    symbol: daily.quote.symbol,
    price,
    score,
    verdict: verdict.label,
    verdictKey: verdict.key,
    confidence,
    agreement: Math.round(agreement * 100),
    technicalScore,
    analystScore: aggregate(an),
    signals,
    levels: tech.levels,
    plan: tradePlan(liveScore, tradePrice, atr(liveBars, 14), tech.levels, analyst),
    session,
    live: {
      score: liveScore,
      verdict: liveVerdict.label,
      verdictKey: liveVerdict.key,
      intraday,
    },
    probability: { ...probabilityOf(history, liveScore, score, intraday, earningsSoon, align), history },
    alignment: align,
    earnings: analyst?.nextEarnings ? { date: analyst.nextEarnings, daysAway: daysToEarnings, soon: earningsSoon } : null,
    priceAsOf: daily.quote.marketTime,
    analyst,
    basis: `${Math.min(bars.length, 260)} daily bars${intraday.available ? ' + today’s 1-min bars' : ''} + ${
      analyst?.recommendationMean != null ? 'analyst consensus' : 'no analyst coverage'
    }`,
    generatedAt: Date.now(),
  };
}
