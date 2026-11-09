// Shared helpers for building and combining signals.
// Each signal scores in [-1, 1]; a group's score is the weighted average x 100.

export const clamp = (v, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, v));
export const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);
export const stance = (s) => (s > 0.15 ? 'bullish' : s < -0.15 ? 'bearish' : 'neutral');
export const f2 = (v) => (v == null ? '—' : v.toFixed(2));

export function signal(group, name, score, weight, value, detail) {
  const s = clamp(score);
  return { group, name, score: Math.round(s * 100) / 100, weight, stance: stance(s), value, detail };
}

export function aggregate(signals) {
  const w = signals.reduce((s, x) => s + x.weight, 0);
  if (!w) return null;
  return Math.round((signals.reduce((s, x) => s + x.score * x.weight, 0) / w) * 100);
}
