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
import { emaLine, vwapLine, OVERLAYS } from './overlays.js';

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
  };
}

// lightweight-charts renders timestamps as UTC; shift by the exchange offset so the
// axis reads in the exchange's local time (e.g. 09:30 for a NYSE open).
const toChartBars = (bars, offset) => bars.map((b) => ({ ...b, time: b.time + offset }));

export default function StockChart({ bars, warmup = [], resetSeq, quote, chartType, range, dark, dimmed }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const priceRef = useRef(null);
  const volRef = useRef(null);
  const prevCloseLineRef = useRef(null);
  const seededRef = useRef({ seq: -1, len: 0, type: null });
  const [hover, setHover] = useState(null);
  const overlayRefs = useRef({}); // key -> line series
  const [show, setShow] = useState(loadPrefs);

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
    return out;
  }, [bars, warmup, offset, intraday, range, quote?.session?.start]);
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
    return () => {
      // The chart may already be removed (unmount / StrictMode remount) — that's fine.
      try {
        chart.removeSeries(series);
      } catch {}
      priceRef.current = null;
      prevCloseLineRef.current = null;
    };
  }, [chartType, dark]);

  // Push data: full setData on a new snapshot / series swap, incremental update() on ticks.
  useEffect(() => {
    const price = priceRef.current;
    const vol = volRef.current;
    // While a new feed loads, `bars` still belong to the old one: keep the old frame as-is.
    if (!price || !bars.length || dimmed) return;
    const c = seriesColors();
    const shifted = toChartBars(bars, offset);
    const toPrice = (b) => (chartType === 'candle' ? b : { time: b.time, value: b.close });
    const toVol = (b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? c.volUp : c.volDown });

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
