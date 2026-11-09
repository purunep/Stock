// Custom drawings attached to the price series (lightweight-charts "series primitives").
// They draw straight onto the chart canvas and stay in sync with zoom/scroll for free.

/* --------------------------------------------------------------------------------------
 * Trade zones: shaded reward zone (entry -> target) and risk zone (entry -> stop),
 * spanning the right part of the chart so they read as "from now on" levels.
 * The entry/target/stop lines and their axis labels are separate price lines.
 * ------------------------------------------------------------------------------------ */
export class TradeZones {
  constructor() {
    this._plan = null;
    this._colors = { reward: 'rgba(12,163,12,0.10)', risk: 'rgba(208,59,59,0.10)' };
    this._series = null;
    this._requestUpdate = null;
    // 'bottom' views are drawn (via draw(), not drawBackground()) underneath the grid and series.
    const renderer = { draw: (target) => this._draw(target) };
    this._views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
  }
  attached({ series, requestUpdate }) {
    this._series = series;
    this._requestUpdate = requestUpdate;
  }
  detached() {
    this._series = null;
  }
  paneViews() {
    return this._views;
  }
  /**
   * Stretch the autoscale to include levels that are reasonably close to the price data
   * (within 60% of its range beyond either edge). Far-away levels would squash the candles
   * into a thin band, so they are left off-screen (their axis labels still show at the edge).
   */
  autoscaleInfo() {
    const p = this._plan, r = this._dataRange;
    if (!p || !r) return null;
    const pad = (r.hi - r.lo) * 0.6;
    const near = [p.entry, p.target, p.stop].filter((v) => v != null && v >= r.lo - pad && v <= r.hi + pad);
    if (!near.length) return null;
    return { priceRange: { minValue: Math.min(r.lo, ...near), maxValue: Math.max(r.hi, ...near) } };
  }
  setPlan(plan, colors, dataRange) {
    this._plan = plan;
    this._dataRange = dataRange || null;
    if (colors) this._colors = colors;
    this._requestUpdate?.();
  }
  _draw(target) {
    const p = this._plan, s = this._series;
    if (!p || !s) return;
    const yE = s.priceToCoordinate(p.entry);
    const yT = s.priceToCoordinate(p.target);
    const yS = s.priceToCoordinate(p.stop);
    if (yE == null || yT == null || yS == null) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      // Zones cover the right 35% of the plot: the "trade from here" area.
      const x0 = mediaSize.width * 0.65, w = mediaSize.width - x0;
      ctx.fillStyle = this._colors.reward;
      ctx.fillRect(x0, Math.min(yE, yT), w, Math.abs(yT - yE));
      ctx.fillStyle = this._colors.risk;
      ctx.fillRect(x0, Math.min(yE, yS), w, Math.abs(yS - yE));
    });
  }
}

/* --------------------------------------------------------------------------------------
 * Volume profile: horizontal histogram of volume traded at each price over the visible
 * session, drawn against the right edge. Highlights the point of control (POC, the price
 * with the most volume) and the value area (the ~70% of volume around it).
 * ------------------------------------------------------------------------------------ */
export function buildProfile(bars, rows = 32) {
  const valid = bars.filter((b) => b.volume > 0);
  if (valid.length < 10) return null;
  const lo = Math.min(...valid.map((b) => b.low));
  const hi = Math.max(...valid.map((b) => b.high));
  if (!(hi > lo)) return null;
  const step = (hi - lo) / rows;
  const vol = new Array(rows).fill(0);
  for (const b of valid) {
    // Spread each bar's volume evenly across the price rows its high-low range touches.
    const a = Math.max(0, Math.min(rows - 1, Math.floor((b.low - lo) / step)));
    const z = Math.max(0, Math.min(rows - 1, Math.floor((b.high - lo) / step)));
    const share = b.volume / (z - a + 1);
    for (let i = a; i <= z; i++) vol[i] += share;
  }
  const total = vol.reduce((x, y) => x + y, 0);
  const poc = vol.indexOf(Math.max(...vol));
  // Value area: grow outward from the POC until 70% of volume is covered.
  let vaLo = poc, vaHi = poc, acc = vol[poc];
  while (acc < total * 0.7 && (vaLo > 0 || vaHi < rows - 1)) {
    const below = vaLo > 0 ? vol[vaLo - 1] : -1;
    const above = vaHi < rows - 1 ? vol[vaHi + 1] : -1;
    if (above >= below) acc += vol[++vaHi];
    else acc += vol[--vaLo];
  }
  const price = (i) => lo + (i + 0.5) * step;
  return {
    lo, hi, step, vol, max: Math.max(...vol),
    poc: price(poc), pocIndex: poc,
    vah: lo + (vaHi + 1) * step, val: lo + vaLo * step,
    vaLo, vaHi,
  };
}

export class VolumeProfile {
  constructor() {
    this._p = null;
    this._colors = { bar: 'rgba(120,120,120,0.12)', va: 'rgba(120,120,120,0.26)', poc: 'rgba(11,11,11,0.62)' };
    this._series = null;
    this._requestUpdate = null;
    const renderer = { draw: (target) => this._draw(target) };
    this._views = [{ zOrder: () => 'bottom', renderer: () => renderer }];
  }
  attached({ series, requestUpdate }) {
    this._series = series;
    this._requestUpdate = requestUpdate;
  }
  detached() {
    this._series = null;
  }
  paneViews() {
    return this._views;
  }
  setProfile(profile, colors) {
    this._p = profile;
    if (colors) this._colors = colors;
    this._requestUpdate?.();
  }
  _draw(target) {
    const p = this._p, s = this._series;
    if (!p || !s) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      const maxW = Math.min(160, mediaSize.width * 0.2);
      const right = mediaSize.width; // plot area's right edge (price axis is outside)
      for (let i = 0; i < p.vol.length; i++) {
        const yTop = s.priceToCoordinate(p.lo + (i + 1) * p.step);
        const yBot = s.priceToCoordinate(p.lo + i * p.step);
        if (yTop == null || yBot == null) continue;
        const h = Math.max(1, yBot - yTop - 1); // 1px gap between rows
        const w = (p.vol[i] / p.max) * maxW;
        ctx.fillStyle = i === p.pocIndex ? this._colors.poc : i >= p.vaLo && i <= p.vaHi ? this._colors.va : this._colors.bar;
        ctx.fillRect(right - w, yTop, w, h);
      }
    });
  }
}
