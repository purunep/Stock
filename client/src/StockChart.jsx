import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart,
  AreaSeries,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  LineStyle,
  CrosshairMode,
} from 'lightweight-charts';
import { fmtPrice, fmtVolume, fmtTime } from './format.js';
import { emaLine, vwapLine, obvLine, volumeSpikes, OVERLAYS } from './overlays.js';
import { TradeZones, VolumeProfile, SessionShade, buildProfile } from './primitives.js';

// Optional chart layers (toggled from the legend, remembered across visits).
const LAYER_PREF_KEY = 'layers.v1';
const LAYER_DEFAULTS = { levels: true, profile: true, obv: true };
const loadLayers = () => {
  try {
    return { ...LAYER_DEFAULTS, ...JSON.parse(localStorage.getItem(LAYER_PREF_KEY) || '{}') };
  } catch {
    return { ...LAYER_DEFAULTS };
  }
};
const SPIKE_X = 2; // a bar is a "volume spike" at >= 2x the normal volume for that time

// Each overlay has its own colour AND dash style, so they can be told apart without colour.
const OVERLAY_STYLE = {
  vwap: { color: '--ov-vwap', lineStyle: LineStyle.Solid, lineWidth: 2 },
  ema90: { color: '--ov-ema90', lineStyle: LineStyle.Dashed, lineWidth: 2 },
  ema150: { color: '--ov-ema150', lineStyle: LineStyle.SparseDotted, lineWidth: 2 },
};
const OVERLAY_PREF_KEY = 'overlays.v1';
const loadPrefs = () => {
  try {
    return { vwap: true, ema90: true, ema150: true, ...JSON.parse(localStorage.getItem(OVERLAY_PREF_KEY) || '{}') };
  } catch {
    return { vwap: true, ema90: true, ema150: true };
  }
};

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function themeOptions() {
  return {
    layout: {
      background: { color: cssVar('--surface-1') },
      textColor: cssVar('--text-muted'),
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
      attributionLogo: false,
    },
    grid: {
      vertLines: { visible: false },
      horzLines: { color: cssVar('--grid') },
    },
    rightPriceScale: { borderColor: cssVar('--axis') },
    timeScale: { borderColor: cssVar('--axis') },
    crosshair: {
      mode: CrosshairMode.Magnet,
      vertLine: { color: cssVar('--text-muted'), width: 1, style: LineStyle.Solid, labelBackgroundColor: cssVar('--text-secondary') },
      horzLine: { color: cssVar('--text-muted'), width: 1, style: LineStyle.Dashed, labelBackgroundColor: cssVar('--text-secondary') },
    },
  };
}

function seriesColors() {
  const s1 = cssVar('--series-1');
  return {
    line: s1,
    up: cssVar('--up'),
    down: cssVar('--down'),
    volUp: cssVar('--vol-up'),
    volDown: cssVar('--vol-down'),
    // Spikes: same hue as the candle, at full strength, so heavy-volume bars stand out.
    spikeUp: cssVar('--up'),
    spikeDown: cssVar('--down'),
  };
}

// lightweight-charts renders timestamps as UTC; shift by the exchange offset so the
// axis reads in the exchange's local time (e.g. 09:30 for a NYSE open).
const toChartBars = (bars, offset) => bars.map((b) => ({ ...b, time: b.time + offset }));

export default function StockChart({ bars, warmup = [], resetSeq, quote, chartType, range, dark, dimmed, plan, extended }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const priceRef = useRef(null);
  const volRef = useRef(null);
  const prevCloseLineRef = useRef(null);
  const seededRef = useRef({ seq: -1, len: 0, type: null });
  const [hover, setHover] = useState(null);
  const overlayRefs = useRef({}); // key -> line series
  const [show, setShow] = useState(loadPrefs);
  const [layers, setLayers] = useState(loadLayers);
  const zonesRef = useRef(null);
  const profileRef = useRef(null);
  const shadeRef = useRef(null);
  const planLinesRef = useRef([]);
  const obvRef = useRef(null);
  const toggleLayer = (key) =>
    setLayers((s) => {
      const next = { ...s, [key]: !s[key] };
      localStorage.setItem(LAYER_PREF_KEY, JSON.stringify(next));
      return next;
    });

  const offset = quote?.gmtOffset ?? 0;
  const intraday = range === '1d' || range === '5d' || range === '1mo';
  const available = OVERLAYS.filter((o) => !o.intradayOnly || intraday);

  const toggle = (key) =>
    setShow((s) => {
      const next = { ...s, [key]: !s[key] };
      localStorage.setItem(OVERLAY_PREF_KEY, JSON.stringify(next));
      return next;
    });

  // Overlay values, keyed by (shifted) time. EMAs run over warmup + visible bars so they are
  // accurate from the first visible bar; only the visible part is drawn.
  const lines = useMemo(() => {
    if (!bars.length) return {};
    const firstVisible = bars[0].time + offset;
    const all = toChartBars([...warmup.filter((b) => b.time < bars[0].time), ...bars], offset);
    const visible = (arr) => arr.filter((p) => p.time >= firstVisible);
    const out = {};
    for (const o of OVERLAYS) {
      if (o.period) out[o.key] = visible(emaLine(all, o.period));
    }
    if (intraday) {
      // 1D: start VWAP at the regular-session open, skipping the pre-market.
      const sessionStart = range === '1d' && quote?.session ? quote.session.start + offset : null;
      out.vwap = vwapLine(toChartBars(bars, offset), { sessionStart });
    }
    // On-balance volume: running total of volume, + on up bars and - on down bars.
    out.obv = obvLine(toChartBars(bars, offset));
    return out;
  }, [bars, warmup, offset, intraday, range, quote?.session?.start]);

  // Volume spikes: bars trading >= SPIKE_X times normal. Intraday, "normal" is the average for
  // the same minute-of-day in earlier sessions (warmup), so the opening rush isn't flagged.
  const spikes = useMemo(
    () => volumeSpikes(bars, warmup, { intraday, offset, threshold: SPIKE_X }),
    [bars, warmup, intraday, offset],
  );
  const spikesRef = useRef(spikes);
  spikesRef.current = spikes;

  // Volume profile over today's regular session (1D) or the visible bars (other ranges).
  const profile = useMemo(() => {
    if (!bars.length) return null;
    const s = range === '1d' && quote?.session ? quote.session : null;
    const src = s ? bars.filter((b) => b.time >= s.start && b.time < s.end) : bars;
    return buildProfile(src.length >= 10 ? src : bars);
  }, [bars, range, quote?.session?.start]);
  // Create chart once.
  useEffect(() => {
    const chart = createChart(containerRef.current, {
      ...themeOptions(),
      autoSize: true,
      handleScale: { axisPressedMouseMove: true },
    });
    chartRef.current = chart;

    const vol = chart.addSeries(HistogramSeries, {
      priceScaleId: 'vol',
      priceFormat: { type: 'volume' },
      lastValueVisible: false,
      priceLineVisible: false,
    });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    volRef.current = vol;

    // OBV lives in its own pane under the price chart (pane index 1).
    const obv = chart.addSeries(
      LineSeries,
      { lineWidth: 2, priceLineVisible: false, lastValueVisible: true, title: 'OBV', priceFormat: { type: 'volume' } },
      1,
    );
    obvRef.current = obv;
    const pane = chart.panes()[1];
    pane?.setStretchFactor(0.22);
    chart.panes()[0]?.setStretchFactor(1);

    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  // Theme changes.
  useEffect(() => {
    chartRef.current?.applyOptions(themeOptions());
    seededRef.current.seq = -1; // force re-seed so series colours update
  }, [dark]);

  // Swap price series when the chart type changes.
  useEffect(() => {
    const chart = chartRef.current;
    const c = seriesColors();
    priceRef.current =
      chartType === 'candle'
        ? chart.addSeries(CandlestickSeries, {
            upColor: c.up,
            downColor: c.down,
            borderVisible: false,
            wickUpColor: c.up,
            wickDownColor: c.down,
          })
        : chart.addSeries(AreaSeries, {
            lineColor: c.line,
            lineWidth: 2,
            topColor: c.line + '38',
            bottomColor: c.line + '00',
            crosshairMarkerRadius: 4,
          });
    priceRef.current.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.22 } });
    seededRef.current.seq = -1;
    const series = priceRef.current;

    // Custom drawings ride on the price series.
    const shade = new SessionShade();
    const zones = new TradeZones();
    const prof = new VolumeProfile();
    series.attachPrimitive(shade);
    series.attachPrimitive(prof);
    series.attachPrimitive(zones);
    shadeRef.current = shade;
    zonesRef.current = zones;
    profileRef.current = prof;

    return () => {
      // The chart may already be removed (unmount / StrictMode remount) — that's fine.
      try {
        series.detachPrimitive(shade);
        series.detachPrimitive(zones);
        series.detachPrimitive(prof);
        chart.removeSeries(series);
      } catch {}
      priceRef.current = null;
      prevCloseLineRef.current = null;
      planLinesRef.current = [];
      zonesRef.current = null;
      profileRef.current = null;
      shadeRef.current = null;
    };
  }, [chartType, dark]);

  // Extended-hours shading (1D only: that's the only range that includes pre/post bars).
  const extRanges = useMemo(() => {
    const s = quote?.session;
    if (range !== '1d' || !s || !bars.length) return [];
    const pre = bars.filter((b) => b.time < s.start);
    const post = bars.filter((b) => b.time >= s.end);
    const out = [];
    if (pre.length) out.push({ from: pre[0].time + offset, to: pre.at(-1).time + offset, kind: 'pre', n: pre.length });
    if (post.length) out.push({ from: post[0].time + offset, to: post.at(-1).time + offset, kind: 'post', n: post.length });
    return out;
  }, [bars, range, offset, quote?.session?.start]);

  useEffect(() => {
    shadeRef.current?.setRanges(extRanges, cssVar('--ext-shade'));
  }, [extRanges, chartType, dark]);

  // Push data: full setData on a new snapshot / series swap, incremental update() on ticks.
  useEffect(() => {
    const price = priceRef.current;
    const vol = volRef.current;
    // While a new feed loads, `bars` still belong to the old one: keep the old frame as-is.
    if (!price || !bars.length || dimmed) return;
    const c = seriesColors();
    const shifted = toChartBars(bars, offset);
    const toPrice = (b) => (chartType === 'candle' ? b : { time: b.time, value: b.close });
    const toVol = (b) => {
      const up = b.close >= b.open;
      const spike = spikesRef.current.has(b.time - offset);
      return { time: b.time, value: b.volume, color: spike ? (up ? c.spikeUp : c.spikeDown) : up ? c.volUp : c.volDown };
    };

    const seeded = seededRef.current;
    const lastTime = shifted[shifted.length - 1].time;
    if (seeded.seq !== resetSeq || seeded.type !== chartType) {
      price.setData(shifted.map(toPrice));
      vol.setData(shifted.map(toVol));
      const ts = chartRef.current.timeScale();
      ts.fitContent();
      requestAnimationFrame(() => chartRef.current && ts.fitContent());
      seededRef.current = { seq: resetSeq, lastTime, type: chartType };
    } else {
      // On a tick only the forming bar changes (and maybe new bars appear).
      // update() may only touch the latest bar or append, so start at the last drawn time.
      let i = shifted.length - 1;
      while (i > 0 && shifted[i - 1].time >= seeded.lastTime) i--;
      for (; i < shifted.length; i++) {
        if (shifted[i].time < seeded.lastTime) continue;
        price.update(toPrice(shifted[i]));
        vol.update(toVol(shifted[i]));
      }
      seeded.lastTime = lastTime;
    }
  }, [bars, resetSeq, chartType, offset, dark, dimmed]);

  // Re-colour volume when the spike set changes (e.g. warmup arrives after the snapshot).
  useEffect(() => {
    const vol = volRef.current;
    if (!vol || !bars.length || dimmed) return;
    const c = seriesColors();
    vol.setData(
      toChartBars(bars, offset).map((b) => {
        const up = b.close >= b.open;
        const spike = spikes.has(b.time - offset);
        return { time: b.time, value: b.volume, color: spike ? (up ? c.spikeUp : c.spikeDown) : up ? c.volUp : c.volDown };
      }),
    );
    // Only when the spike set itself changes; per-tick updates are handled above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spikes, dark, chartType]);

  // OBV pane.
  useEffect(() => {
    const s = obvRef.current;
    if (!s || dimmed) return;
    s.applyOptions({ visible: layers.obv, color: cssVar('--text-secondary') });
    s.setData(layers.obv ? lines.obv || [] : []);
    const pane = chartRef.current?.panes()[1];
    pane?.setStretchFactor(layers.obv ? 0.22 : 0.0001);
  }, [lines, layers.obv, dimmed, dark]);

  // Entry / target / stop: price lines with axis labels + shaded reward/risk zones.
  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;
    for (const l of planLinesRef.current) {
      try {
        price.removePriceLine(l);
      } catch {}
    }
    planLinesRef.current = [];
    const on = layers.levels && plan && plan.entry && plan.target && plan.stop;
    const dataRange = bars.length
      ? { lo: Math.min(...bars.map((b) => b.low)), hi: Math.max(...bars.map((b) => b.high)) }
      : null;
    zonesRef.current?.setPlan(on ? plan : null, { reward: cssVar('--zone-reward'), risk: cssVar('--zone-risk') }, dataRange);
    if (!on) return;
    const short = plan.bias === 'short';
    const mk = (p, title, color, style) =>
      price.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title });
    planLinesRef.current = [
      mk(plan.entry, plan.bias === 'neutral' ? 'Buy below' : short ? 'Sell near' : 'Entry', cssVar('--text-primary'), LineStyle.Solid),
      mk(plan.target, 'Target', cssVar(short ? '--down' : '--up'), LineStyle.Dashed),
      mk(plan.stop, 'Stop', cssVar(short ? '--up' : '--down'), LineStyle.Dashed),
    ];
    // Range only needs refreshing when the visible data changes meaningfully (new snapshot).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan?.entry, plan?.target, plan?.stop, plan?.bias, layers.levels, chartType, dark, resetSeq, bars.length > 0]);

  // Volume profile drawing.
  useEffect(() => {
    profileRef.current?.setProfile(layers.profile ? profile : null, {
      bar: cssVar('--vp-bar'),
      va: cssVar('--vp-va'),
      poc: cssVar('--vp-poc'),
    });
  }, [profile, layers.profile, chartType, dark]);

  // Create one line series per overlay (re-created on theme change for fresh colours).
  useEffect(() => {
    const chart = chartRef.current;
    const made = {};
    for (const o of OVERLAYS) {
      const st = OVERLAY_STYLE[o.key];
      made[o.key] = chart.addSeries(LineSeries, {
        color: cssVar(st.color),
        lineWidth: st.lineWidth,
        lineStyle: st.lineStyle,
        title: o.label, // direct label on the price axis
        priceLineVisible: false,
        lastValueVisible: true,
        crosshairMarkerVisible: false,
        lineType: 0,
      });
    }
    overlayRefs.current = made;
    return () => {
      for (const s of Object.values(made)) {
        try {
          chart.removeSeries(s);
        } catch {}
      }
      overlayRefs.current = {};
    };
    // Re-created after the price series (declared above) so the lines draw on top of the candles.
  }, [dark, chartType]);

  // Push overlay data and visibility.
  useEffect(() => {
    if (dimmed) return; // keep the previous frame while a new feed loads
    for (const o of OVERLAYS) {
      const s = overlayRefs.current[o.key];
      if (!s) continue;
      const on = show[o.key] && available.some((a) => a.key === o.key);
      s.applyOptions({ visible: on });
      s.setData(on ? lines[o.key] || [] : []);
    }
  }, [lines, show, dimmed, dark, intraday, chartType]);

  // Previous-close reference line on the intraday view.
  useEffect(() => {
    const price = priceRef.current;
    if (!price) return;
    if (prevCloseLineRef.current) {
      price.removePriceLine(prevCloseLineRef.current);
      prevCloseLineRef.current = null;
    }
    if (range === '1d' && quote?.prevClose != null) {
      prevCloseLineRef.current = price.createPriceLine({
        price: quote.prevClose,
        color: cssVar('--text-muted'),
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'Prev close',
      });
    }
  }, [range, quote?.prevClose, chartType, dark]);

  // Crosshair readout: look up the full OHLCV bar at the hovered time.
  const barsRef = useRef(bars);
  barsRef.current = bars;
  useEffect(() => {
    const chart = chartRef.current;
    const handler = (param) => {
      if (!param.time || !param.point || param.point.x < 0) return setHover(null);
      const t = param.time - offset;
      const arr = barsRef.current;
      let lo = 0, hi = arr.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (arr[mid].time === t) return setHover(arr[mid]);
        if (arr[mid].time < t) lo = mid + 1;
        else hi = mid - 1;
      }
      setHover(null);
    };
    chart.subscribeCrosshairMove(handler);
    return () => chart.unsubscribeCrosshairMove(handler);
  }, [offset]);

  // Time axis labels follow the range granularity.
  useEffect(() => {
    chartRef.current?.applyOptions({
      timeScale: { timeVisible: intraday, secondsVisible: false },
      localization: { priceFormatter: (p) => fmtPrice(p) },
    });
  }, [intraday]);

  const last = bars.at(-1);
  const readout = hover || last;

  // Overlay values at the hovered (or latest) bar, and where the close sits against each.
  const valueAt = (key, time) => {
    const arr = lines[key];
    if (!arr?.length || time == null) return null;
    const t = time + offset;
    let lo = 0, hi = arr.length - 1, best = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].time <= t) {
        best = arr[mid];
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return best?.value ?? null;
  };
  const legend = available.map((o) => {
    const v = readout ? valueAt(o.key, readout.time) : null;
    const diff = v != null && readout ? ((readout.close - v) / v) * 100 : null;
    return { ...o, value: v, diff };
  });
  const bias = trendRead(legend.filter((l) => show[l.key]), readout?.close);

  // Layer readouts.
  const isSpike = readout ? spikes.has(readout.time) : false;
  const spikeCount = spikes.size;
  const obvTrend = (() => {
    // OBV needs volume, so on 1D read it over the bars that have volume (the regular session);
    // extended-hours bars carry no volume in this feed and would make it look flat.
    const s = quote?.session;
    const keepIdx = bars.map((b, i) => (range === '1d' && s && (b.time < s.start || b.time >= s.end) ? -1 : i)).filter((i) => i >= 0);
    const o = keepIdx.map((i) => lines.obv?.[i]).filter(Boolean);
    const px = keepIdx.map((i) => bars[i]);
    if (o.length < 30) return null;
    // Compare OBV slope with price slope over the last ~20% of bars (min 20).
    const n = Math.max(20, Math.floor(o.length * 0.2));
    const dObv = o.at(-1).value - o.at(-n).value;
    const p1 = px.at(-n)?.close, p2 = px.at(-1)?.close;
    if (p1 == null || p2 == null) return null;
    const dPx = p2 - p1;
    const up = dObv > 0, pxUp = dPx > 0;
    if (up && pxUp) return { kind: 'up', text: 'OBV rising with price: buyers confirm' };
    if (!up && !pxUp) return { kind: 'down', text: 'OBV falling with price: sellers confirm' };
    if (up && !pxUp) return { kind: 'up', text: 'Bullish divergence: OBV rising while price falls' };
    return { kind: 'down', text: 'Bearish divergence: OBV falling while price rises' };
  })();
  const pocDiff = profile && readout ? ((readout.close - profile.poc) / profile.poc) * 100 : null;

  return (
    <div className={`chart-wrap${dimmed ? ' is-dimmed' : ''}`}>
      {readout && (
        <div className="readout">
          <span className="readout-time">{fmtTime(readout.time, quote?.timezone, intraday)}</span>
          <Field label="O" value={fmtPrice(readout.open)} />
          <Field label="H" value={fmtPrice(readout.high)} />
          <Field label="L" value={fmtPrice(readout.low)} />
          <Field label="C" value={fmtPrice(readout.close)} />
          <Field label="Vol" value={fmtVolume(readout.volume)} />
        </div>
      )}

      <div className="ov-legend" role="group" aria-label="Indicator overlays">
        {legend.map((l) => (
          <button
            key={l.key}
            className={`ov-item${show[l.key] ? '' : ' is-off'}`}
            onClick={() => toggle(l.key)}
            aria-pressed={show[l.key]}
            title={`${show[l.key] ? 'Hide' : 'Show'} ${l.label}`}
          >
            <svg className="ov-key" width="22" height="8" aria-hidden="true">
              <line
                x1="1" y1="4" x2="21" y2="4"
                stroke={`var(${OVERLAY_STYLE[l.key].color})`}
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeDasharray={l.key === 'ema90' ? '5 3' : l.key === 'ema150' ? '1 4' : undefined}
              />
            </svg>
            <span className="ov-label">{l.label}</span>
            <strong className="ov-val">{l.value != null ? fmtPrice(l.value) : '—'}</strong>
            {l.diff != null && show[l.key] && (
              <span className={`ov-pos ${l.diff >= 0 ? 'stance-bullish' : 'stance-bearish'}`}>
                {l.diff >= 0 ? '▲ above' : '▼ below'} {Math.abs(l.diff).toFixed(2)}%
              </span>
            )}
          </button>
        ))}
        {!intraday && <span className="ov-note">VWAP is intraday only (1D, 5D, 1M)</span>}
        {bias && (
          <span className={`ov-bias ov-bias-${bias.kind}`} title={bias.detail}>
            {bias.label}
          </span>
        )}
      </div>

      <div className="ov-legend layer-row" role="group" aria-label="Chart layers">
        <button
          className={`ov-item${layers.levels ? '' : ' is-off'}`}
          onClick={() => toggleLayer('levels')}
          aria-pressed={layers.levels}
          title="Entry, target and stop from the Buy/Sell signal, with reward (green) and risk (red) zones"
        >
          <span className="layer-swatch zone" aria-hidden="true" />
          <span className="ov-label">Trade levels</span>
          {plan?.riskReward != null && layers.levels && <span className="ov-pos">R:R 1:{plan.riskReward}</span>}
        </button>
        <button
          className={`ov-item${layers.profile ? '' : ' is-off'}`}
          onClick={() => toggleLayer('profile')}
          aria-pressed={layers.profile}
          title="Volume traded at each price. POC = the price with the most volume; it often acts as support or resistance."
        >
          <span className="layer-swatch vp" aria-hidden="true" />
          <span className="ov-label">Volume profile</span>
          {profile && layers.profile && (
            <>
              <span>POC</span>
              <strong className="ov-val">{fmtPrice(profile.poc)}</strong>
              {pocDiff != null && (
                <span className={`ov-pos ${pocDiff >= 0 ? 'stance-bullish' : 'stance-bearish'}`}>
                  {pocDiff >= 0 ? '▲ above' : '▼ below'} {Math.abs(pocDiff).toFixed(2)}%
                </span>
              )}
            </>
          )}
        </button>
        <button
          className={`ov-item${layers.obv ? '' : ' is-off'}`}
          onClick={() => toggleLayer('obv')}
          aria-pressed={layers.obv}
          title="On-balance volume: adds volume on up bars and subtracts it on down bars. If it disagrees with price, the move is weakening."
        >
          <span className="layer-swatch obv" aria-hidden="true" />
          <span className="ov-label">OBV</span>
          {obvTrend && layers.obv && (
            <span className={`ov-pos ${obvTrend.kind === 'up' ? 'stance-bullish' : 'stance-bearish'}`}>{obvTrend.text}</span>
          )}
        </button>
        <span
          className={`spike-read${isSpike ? ' is-spike' : ''}`}
          title={`Bright volume bars traded at least ${SPIKE_X}× the normal volume for that time of day.`}
        >
          <span className="layer-swatch spike" aria-hidden="true" />
          {isSpike ? `This bar: volume spike (≥${SPIKE_X}× normal)` : `${spikeCount} volume spike${spikeCount === 1 ? '' : 's'} (≥${SPIKE_X}× normal)`}
        </span>
      </div>

      {extRanges.length > 0 && (
        <div className="ext-legend">
          <span className="layer-swatch ext" aria-hidden="true" />
          <span>
            Shaded = {extRanges.map((r) => (r.kind === 'pre' ? 'pre-market (4:00–9:30 AM)' : 'after hours (4:00–8:00 PM)')).join(' and ')} ET.
            Prices are live; the free data feed has no per-minute volume for these sessions, so those volume bars are empty
            {extended?.volume != null
              ? `. Session total from Nasdaq: ${fmtVolume(extended.volume)} shares${extended.volPctOfDay != null ? ` (${extended.volPctOfDay.toFixed(1)}% of a normal day)` : ''}.`
              : '.'}
          </span>
        </div>
      )}

      <div ref={containerRef} className="chart" />
    </div>
  );
}

/**
 * Plain-language read of price vs the overlays, the usual way traders use them:
 * above all three with EMA 90 over EMA 150 = uptrend (buy dips toward VWAP / EMA 90);
 * below all three with EMA 90 under EMA 150 = downtrend (sell rallies); anything else = mixed.
 */
function trendRead(items, close) {
  const by = Object.fromEntries(items.map((i) => [i.key, i.value]));
  const vals = items.filter((i) => i.value != null);
  if (close == null || vals.length < 2) return null;
  const above = vals.filter((i) => close > i.value).length;
  const emaUp = by.ema90 != null && by.ema150 != null ? by.ema90 > by.ema150 : null;
  const names = vals.map((i) => i.label).join(', ');
  if (above === vals.length && emaUp !== false)
    return {
      kind: 'up',
      label: 'Bullish stack: price above all lines',
      detail: `Price is above ${names}${emaUp ? ', and EMA 90 is above EMA 150' : ''}. Buyers are in control; dips toward VWAP or EMA 90 are where buyers usually step in.`,
    };
  if (above === 0 && emaUp !== true)
    return {
      kind: 'down',
      label: 'Bearish stack: price below all lines',
      detail: `Price is below ${names}${emaUp === false ? ', and EMA 90 is below EMA 150' : ''}. Sellers are in control; rallies into these lines often fail.`,
    };
  if (above === 0)
    return {
      kind: 'mixed',
      label: 'Pullback: below all lines, EMAs still rising',
      detail: `Price has dipped below ${names}, but EMA 90 is still above EMA 150, so the bigger trend is up. A reclaim of VWAP / EMA 90 would resume the uptrend; failing to reclaim them is a warning.`,
    };
  if (above === vals.length)
    return {
      kind: 'mixed',
      label: 'Bounce: above all lines, EMAs still falling',
      detail: `Price has bounced above ${names}, but EMA 90 is still below EMA 150, so the bigger trend is down. Holding above the lines would confirm a reversal; slipping back under them resumes the downtrend.`,
    };
  return {
    kind: 'mixed',
    label: `Mixed: above ${above} of ${vals.length} lines`,
    detail: 'Price is between the lines, so there is no clean trend. Wait for price to clear all of them, or use the lines as support/resistance.',
  };
}

function Field({ label, value }) {
  return (
    <span className="readout-field">
      <span className="readout-label">{label}</span>
      <strong>{value}</strong>
    </span>
  );
}
