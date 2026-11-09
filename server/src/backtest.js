// Historical hit rate for the current technical score.
//
// For every past trading day with enough history, recompute the technical score using only
// the data available on that day (no look-ahead), then record what happened next:
//   - fwd5:  return over the next 5 trading days
//   - first: whether price hit +1.5 ATR or -1.5 ATR first within 10 days (barrier test)
// Then, for days whose score was close to today's, report how often price went the
// predicted way, and compare that with the base rate over all days.

import { atr } from './indicators.js';

const HORIZON = 5;
const BARRIER_DAYS = 10;
const BARRIER_ATR = 1.5;
const MIN_HISTORY = 200; // so the 200-day average exists

const cache = new Map(); // symbol -> { day, samples }

function barrierOutcome(bars, i, a) {
  const entry = bars[i].close;
  const up = entry + BARRIER_ATR * a, down = entry - BARRIER_ATR * a;
  for (let j = i + 1; j <= Math.min(i + BARRIER_DAYS, bars.length - 1); j++) {
    const hitUp = bars[j].high >= up, hitDown = bars[j].low <= down;
    if (hitUp && hitDown) return 0; // both in one bar: ambiguous
    if (hitUp) return 1;
    if (hitDown) return -1;
  }
  return 0; // neither within the window
}

/** `scoreFn(bars)` must return the technical score (-100..100) using only `bars`. */
export function buildSamples(symbol, bars, scoreFn) {
  const day = Math.floor(bars[bars.length - 1].time / 86400);
  const hit = cache.get(symbol);
  if (hit && hit.day === day && hit.len === bars.length) return hit.samples;

  const samples = [];
  // Exclude today's still-forming bar from both inputs and outcomes.
  const complete = bars.length - 1;
  for (let i = MIN_HISTORY; i + HORIZON < complete; i++) {
    const hist = bars.slice(0, i + 1);
    const score = scoreFn(hist);
    if (score == null) continue;
    const a = atr(hist, 14);
    samples.push({
      score,
      fwd5: (bars[i + HORIZON].close - bars[i].close) / bars[i].close,
      first: a ? barrierOutcome(bars.slice(0, complete), i, a) : 0,
    });
  }
  cache.set(symbol, { day, len: bars.length, samples });
  return samples;
}

/**
 * Outcome stats for past days whose technical score was close to `currentScore`.
 * Reported direction-neutrally (how often price went UP); the caller maps that onto
 * whichever way the verdict points.
 */
export function hitRate(samples, currentScore) {
  if (samples.length < 40) return null;

  // Widen the score band until there are enough similar days.
  let band = 10, similar = [];
  while (band <= 40) {
    similar = samples.filter((s) => Math.abs(s.score - currentScore) <= band);
    if (similar.length >= 25) break;
    band += 5;
  }
  if (similar.length < 15) return null;

  const share = (arr, fn) => arr.filter(fn).length / arr.length;
  const up = (s) => s.fwd5 > 0;
  const decided = similar.filter((s) => s.first !== 0);
  const allDecided = samples.filter((s) => s.first !== 0);
  const avg = similar.reduce((t, s) => t + s.fwd5, 0) / similar.length;

  return {
    horizonDays: HORIZON,
    technicalScore: currentScore,
    scoreBand: [Math.round(currentScore - band), Math.round(currentScore + band)],
    cases: similar.length,
    upRate: Math.round(share(similar, up) * 100),
    baseUpRate: Math.round(share(samples, up) * 100),
    avgReturnPct: Math.round(avg * 1000) / 10,
    barrier:
      decided.length >= 10
        ? {
            atr: BARRIER_ATR,
            days: BARRIER_DAYS,
            cases: decided.length,
            upFirstPct: Math.round(share(decided, (s) => s.first === 1) * 100),
            baseUpFirstPct: Math.round(share(allDecided, (s) => s.first === 1) * 100),
          }
        : null,
    totalSamples: samples.length,
  };
}
