import { useEffect, useState } from 'react';
import { fmtPrice, fmtPct, fmtVolume } from './format.js';

// The server re-prices the leaders every 2 s in pre-market / after hours (when moves are fast
// and thin), and every 30 s in the regular session. Poll to match.
const REFRESH_MS = { regular: 30_000, pre: 2_000, post: 2_000 };

// Panel wording per session. The server picks the session from the US market clock.
const MODE = {
  regular: {
    title: 'Top gainers · high volume',
    tag: 'Today',
    sub: 'Regular session · refreshed every 30 s',
    vs: 'vs previous close',
  },
  post: {
    title: 'After-hours gainers',
    tag: 'After hours',
    sub: '4:00–8:00 PM ET · live',
    vs: 'vs 4:00 PM close',
  },
  pre: {
    title: 'Pre-market gainers',
    tag: 'Pre-market',
    sub: '4:00–9:30 AM ET · live',
    vs: 'vs previous close',
  },
};

/** Right rail: top 3 gainers on high volume for whichever session is on now. */
export default function TopMovers({ current, onSelect }) {
  const [state, setState] = useState({ data: null, error: null });

  useEffect(() => {
    let alive = true;
    let timer;
    let mode = 'regular';
    let loaded = false;
    const load = async () => {
      try {
        // Always load once; after that, skip polling while the tab is hidden.
        if (!loaded || document.visibilityState === 'visible') {
          const res = await fetch('/api/movers');
          const json = await res.json();
          if (!res.ok) throw new Error(json.error || 'Failed to load movers');
          mode = json.mode || 'regular';
          loaded = true;
          if (alive) setState({ data: json, error: null });
        }
      } catch (e) {
        if (alive) setState((s) => ({ data: s.data, error: e.message }));
      }
      // Hidden tabs re-check slowly (browsers throttle timers anyway).
      const wait = document.visibilityState === 'visible' ? REFRESH_MS[mode] ?? 30_000 : 30_000;
      if (alive) timer = setTimeout(load, wait);
    };
    // Coming back to the tab: refresh straight away instead of waiting for the next tick.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && alive) {
        clearTimeout(timer);
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    load();
    return () => {
      alive = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { data, error } = state;
  const movers = data?.movers || [];
  const mode = MODE[data?.mode] ? data.mode : 'regular';
  const m = MODE[mode];
  const extended = mode !== 'regular';
  // Overnight/weekend the server returns the last after-hours session, marked not live.
  const sub = data && !data.live && extended ? 'Last after-hours session · market closed' : m.sub;

  return (
    <aside className="card movers" aria-label={m.title}>
      <div className="movers-head">
        <h2>
          {m.title}
          <span className={`session-tag session-${mode}`}>{m.tag}</span>
        </h2>
        <div className="movers-sub">
          {sub}
          {extended && data?.live && data.updatedAt && (
            <span className="movers-age" title="Prices of the leaders are refreshed every 2 s; the whole market is re-scanned every 20 s.">
              {' '}· updated {new Date(data.updatedAt).toLocaleTimeString()}
            </span>
          )}
        </div>
      </div>

      {!data && !error && <p className="movers-empty">Loading…</p>}
      {error && !data && <p className="movers-empty">{error}</p>}
      {data?.note && <p className="movers-empty">{data.note}</p>}
      {data && movers.length === 0 && (
        <p className="movers-empty">
          {extended
            ? `No liquid stocks are up on meaningful ${mode === 'pre' ? 'pre-market' : 'after-hours'} volume yet.`
            : 'No liquid gainers with above-normal volume right now.'}
        </p>
      )}

      <ol className="movers-list">
        {movers.map((x, i) => (
          <li key={x.symbol}>
            <button
              className={`mover${x.symbol === current ? ' is-on' : ''}`}
              onClick={() => onSelect(x.symbol)}
              title={`Open ${x.symbol}`}
            >
              <span className="mover-rank">{i + 1}</span>
              <span className="mover-id">
                <span className="mover-sym">
                  {x.symbol}
                  {x.smallCap && (
                    <span className="tag-risk" title={`Market cap ${fmtVolume(x.marketCap)}: small caps are more volatile and easier to move`}>
                      Small cap
                    </span>
                  )}
                </span>
                <span className="mover-name">{x.name}</span>
              </span>
              <span className="mover-px">
                <span className="mover-chg" title={m.vs}>
                  <span aria-hidden="true">▲</span> {fmtPct(x.changePct)}
                </span>
                <span className="mover-price">{fmtPrice(x.price)}</span>
              </span>
              {extended ? <ExtVolume x={x} mode={mode} /> : <RegVolume x={x} />}
            </button>
          </li>
        ))}
      </ol>

      <p className="movers-note">
        {extended ? (
          <>
            Biggest {mode === 'pre' ? 'pre-market' : 'after-hours'} % gainers {m.vs} (same basis as TradingView's
            {mode === 'pre' ? ' pre-market' : ' post-market'} change), scanning
            {data?.scanned ? ` ${data.scanned.toLocaleString()}` : ' all'} US stocks on Nasdaq, NYSE and NYSE American every
            20 s, with the leaders re-priced every 2 s. Kept only at $1 or more with at least 50k shares and $1M traded in
            this session, so a few tiny trades can't top the list.
            {data?.candidates != null && ` ${data.candidates} stocks qualify right now.`}
          </>
        ) : (
          <>
            Biggest % gainers on Nasdaq, NYSE and NYSE American (same order as Yahoo's Gainers page), kept only if trading
            at least 1.5× their 3-month average volume. Also excludes stocks under $1, under 500k shares traded or under $50M
            market cap.
            {data?.candidates != null && ` ${data.candidates} stocks qualify right now.`}
          </>
        )}
      </p>
    </aside>
  );
}

/** Regular session: today's volume vs the 3-month average. */
function RegVolume({ x }) {
  return (
    <span className="mover-vol">
      <span>
        Vol <strong>{fmtVolume(x.volume)}</strong>
      </span>
      <span className="rvol" title="Today's volume vs. the 3-month average">
        <strong>{x.rvol.toFixed(1)}×</strong> avg
      </span>
      <span className="rvol-bar" aria-hidden="true">
        <span style={{ width: `${Math.min(100, (Math.log2(x.rvol) / Math.log2(20)) * 100)}%` }} />
      </span>
    </span>
  );
}

/** Extended hours: shares traded this session, as a share of a normal full day. */
function ExtVolume({ x, mode }) {
  const pct = x.volPctOfDay;
  const dollars = x.dollarVolume ?? x.volume * x.price;
  return (
    <span className="mover-vol">
      <span title={`Shares traded in this ${mode === 'pre' ? 'pre-market' : 'after-hours'} session (Nasdaq)`}>
        {mode === 'pre' ? 'Pre' : 'AH'} vol <strong>{fmtVolume(x.volume)}</strong>
      </span>
      <span className="rvol" title="Dollar value traded in this session">
        <strong>${fmtVolume(dollars)}</strong>
      </span>
      {pct != null && (
        <span
          className="rvol"
          title={`This session's volume vs ${mode === 'pre' ? "the last session's" : "today's"} regular-session volume. Extended hours usually trade 2–5%; far more means news.`}
        >
          <strong>{pct >= 100 ? `${(pct / 100).toFixed(1)}×` : `${pct.toFixed(0)}%`}</strong> of {mode === 'pre' ? 'last day' : 'today'}
        </span>
      )}
    </span>
  );
}
