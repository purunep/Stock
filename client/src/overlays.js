// Indicator overlays drawn on top of the price chart.
// Each returns [{ time, value }] aligned to the input bars (already time-shifted).

/** Exponential moving average of closes, seeded with the SMA of the first `period` bars. */
export function emaLine(bars, period) {
  if (bars.length < period) return [];
  const k = 2 / (period + 1);
  let prev = 0;
  for (let i = 0; i < period; i++) prev += bars[i].close;
  prev /= period;
  const out = [{ time: bars[period - 1].time, value: prev }];
  for (let i = period; i < bars.length; i++) {
    prev = bars[i].close * k + prev * (1 - k);
    out.push({ time: bars[i].time, value: prev });
  }
  return out;
}

/**
 * Session VWAP: resets at each new trading day (by the bars' exchange-local date, since
 * times are already shifted). Bars with zero volume carry the running value forward.
 * `sessionStart` (exchange-local, shifted) lets 1D skip the pre-market so VWAP starts at
 * the regular open, matching what most platforms show.
 */
export function vwapLine(bars, { sessionStart = null } = {}) {
  const out = [];
  let day = null, pv = 0, v = 0;
  for (const b of bars) {
    if (sessionStart != null && b.time < sessionStart) continue;
    const d = Math.floor(b.time / 86400);
    if (d !== day) {
      day = d;
      pv = 0;
      v = 0;
    }
    const tp = (b.high + b.low + b.close) / 3;
    pv += tp * (b.volume || 0);
    v += b.volume || 0;
    if (v > 0) out.push({ time: b.time, value: pv / v });
  }
  return out;
}

/** Which overlays make sense for a range (VWAP is an intraday, per-session indicator). */
export const OVERLAYS = [
  { key: 'vwap', label: 'VWAP', intradayOnly: true },
  { key: 'ema90', label: 'EMA 90', period: 90 },
  { key: 'ema150', label: 'EMA 150', period: 150 },
];
