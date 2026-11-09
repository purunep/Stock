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

/** On-balance volume: cumulative volume, added on up-closes and subtracted on down-closes. */
export function obvLine(bars) {
  const out = [];
  let obv = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
    if (i > 0) {
      const prev = bars[i - 1].close;
      if (b.close > prev) obv += b.volume || 0;
      else if (b.close < prev) obv -= b.volume || 0;
    }
    out.push({ time: b.time, value: obv });
  }
  return out;
}

/**
 * Bars whose volume is >= `threshold` x normal. Returns a Set of raw (unshifted) bar times.
 * Intraday, "normal" = median volume at the same minute-of-day across earlier sessions
 * (from warmup), so the naturally heavy open/close aren't all flagged. Daily+ ranges, or when
 * there's no history, use the median of the previous 20 bars.
 */
export function volumeSpikes(bars, warmup, { intraday, offset = 0, threshold = 2 }) {
  const out = new Set();
  const median = (arr) => {
    const s = arr.filter((v) => v > 0).sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  };
  if (intraday && warmup.length > 100) {
    const slotOf = (t) => Math.floor(((t + offset) % 86400) / 900); // 15-minute buckets
    const day = (t) => Math.floor((t + offset) / 86400);
    const bySlot = new Map();
    for (const b of warmup) {
      if (!(b.volume > 0)) continue;
      const k = slotOf(b.time);
      if (!bySlot.has(k)) bySlot.set(k, { vols: [], days: new Set() });
      const s = bySlot.get(k);
      s.vols.push(b.volume);
      s.days.add(day(b.time));
    }
    // Only trust a time-of-day baseline seen on at least 2 earlier sessions; otherwise fall
    // back to the rolling median so a partial history can't flag half the day as spikes.
    const rolling = (i) => median(bars.slice(Math.max(0, i - 30), i).map((b) => b.volume));
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      if (!(b.volume > 0)) continue;
      const s = bySlot.get(slotOf(b.time));
      const base = s && s.days.size >= 2 ? median(s.vols) : i >= 20 ? rolling(i) : 0;
      if (base > 0 && b.volume >= threshold * base) out.add(b.time);
    }
    return out;
  }
  for (let i = 20; i < bars.length; i++) {
    const base = median(bars.slice(i - 20, i).map((b) => b.volume));
    if (base > 0 && bars[i].volume >= threshold * base) out.add(bars[i].time);
  }
  return out;
}

/** Which overlays make sense for a range (VWAP is an intraday, per-session indicator). */
export const OVERLAYS = [
  { key: 'vwap', label: 'VWAP', intradayOnly: true },
  { key: 'ema90', label: 'EMA 90', period: 90 },
  { key: 'ema150', label: 'EMA 150', period: 150 },
];
