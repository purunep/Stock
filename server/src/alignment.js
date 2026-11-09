// Multi-timeframe trend agreement + overall-market check.
//
// The same simple rule is applied on every timeframe so the result is easy to explain:
//   up   = close > EMA 20 > EMA 50
//   down = close < EMA 20 < EMA 50
//   flat = anything else (mixed / sideways)
// Trades taken in the direction most timeframes agree on, with the market behind them,
// historically work more often than trades against the bigger trend.

import { ema, last } from './indicators.js';
import { getChart } from './yahoo.js';

const MARKET = 'SPY';

const TIMEFRAMES = [
  { key: '1m', label: '1-min', range: '1d', note: 'today, 1-minute bars' },
  { key: '5m', label: '5-min', range: '5d', note: 'last 5 days, 5-minute bars' },
  { key: '1d', label: 'Daily', range: '2y', note: 'daily bars' },
  { key: '1w', label: 'Weekly', range: '5y', note: 'weekly bars' },
];

function trendOf(bars) {
  const closes = bars.map((b) => b.close);
  if (closes.length < 55) return { trend: 'unknown', detail: 'Not enough bars' };
  const c = last(closes);
  const f = last(ema(closes, 20));
  const s = last(ema(closes, 50));
  const spread = ((f - s) / s) * 100;
  let trend = 'flat';
  if (c > f && f > s) trend = 'up';
  else if (c < f && f < s) trend = 'down';
  const where = `price ${c > f ? 'above' : 'below'} EMA 20, EMA 20 ${f > s ? 'above' : 'below'} EMA 50`;
  return { trend, ema20: f, ema50: s, spreadPct: Math.round(spread * 100) / 100, detail: where };
}

async function timeframeTrends(symbol, liveBars1d) {
  return Promise.all(
    TIMEFRAMES.map(async (tf) => {
      try {
        const bars = tf.range === '1d' && liveBars1d ? liveBars1d : (await getChart(symbol, tf.range, { ttlMs: 60_000 })).bars;
        return { key: tf.key, label: tf.label, note: tf.note, ...trendOf(bars) };
      } catch (e) {
        return { key: tf.key, label: tf.label, note: tf.note, trend: 'unknown', detail: e.message };
      }
    }),
  );
}

/** Session VWAP from today's regular-session 1-minute bars. */
function sessionVwap(bars, session) {
  let pv = 0, v = 0;
  for (const b of bars) {
    if (session && (b.time < session.start || b.time >= session.end)) continue;
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    v += b.volume;
  }
  return v ? pv / v : null;
}

async function marketCheck() {
  const [d1, d5, dy] = await Promise.all([
    getChart(MARKET, '1d'),
    getChart(MARKET, '5d', { ttlMs: 60_000 }),
    getChart(MARKET, '2y', { ttlMs: 60_000 }),
  ]);
  const q = d1.quote;
  const vwap = sessionVwap(d1.bars, q.session);
  const intraday = trendOf(d5.bars).trend;
  const daily = trendOf(dy.bars).trend;
  const aboveVwap = vwap != null ? q.price > vwap : null;
  // Risk-on when neither view is down; risk-off when both are down.
  let stance = 'mixed';
  if (intraday !== 'down' && daily !== 'down' && (intraday === 'up' || daily === 'up')) stance = 'up';
  if (intraday === 'down' && daily === 'down') stance = 'down';
  if (intraday === 'down' && aboveVwap === false && q.changePct < -0.5) stance = 'down';
  return {
    symbol: MARKET,
    name: 'S&P 500',
    price: q.price,
    changePct: q.changePct,
    vwap,
    aboveVwap,
    intradayTrend: intraday,
    dailyTrend: daily,
    stance,
  };
}

/**
 * @param symbol   the stock being analysed
 * @param quote    its 1d quote (for today's % change)
 * @param bars1d   its 1d bars (already fetched by the intraday analysis)
 */
export async function alignmentFor(symbol, quote, bars1d) {
  const [timeframes, market] = await Promise.all([
    timeframeTrends(symbol, bars1d),
    marketCheck().catch(() => null),
  ]);
  const known = timeframes.filter((t) => t.trend !== 'unknown');
  const up = known.filter((t) => t.trend === 'up').length;
  const down = known.filter((t) => t.trend === 'down').length;
  const consensus = up >= 3 && up > down ? 'up' : down >= 3 && down > up ? 'down' : 'mixed';

  // Relative strength: how the stock is doing today versus the market.
  const isMarket = symbol === MARKET;
  const relStrength =
    market && !isMarket && quote?.changePct != null && market.changePct != null
      ? Math.round((quote.changePct - market.changePct) * 100) / 100
      : null;

  return { timeframes, up, down, total: known.length, consensus, market: isMarket ? null : market, relStrength };
}
