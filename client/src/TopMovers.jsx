import { useEffect, useState } from 'react';
import { fmtPrice, fmtPct, fmtVolume } from './format.js';

const REFRESH_MS = 30_000;

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
    sub: '4:00–8:00 PM ET · refreshed every 30 s',
    vs: 'vs 4:00 PM close',
  },
  pre: {
    title: 'Pre-market gainers',
    tag: 'Pre-market',
    sub: '4:00–9:30 AM ET · refreshed every 30 s',
    vs: 'vs previous close',
  },
};

/** Right rail: top 3 gainers on high volume for whichever session is on now. */
export default function TopMovers({ current, onSelect }) {
  const [state, setState] = useState({ data: null, error: null });

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/movers');
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to load movers');
        if (alive) setState({ data: json, error: null });
      } catch (e) {
        if (alive) setState((s) => ({ data: s.data, error: e.message }));
      }
    };
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
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
        <div className="movers-sub">{sub}</div>
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
            {data?.scanned ? ` ${data.scanned.toLocaleString()}` : ' all'} US stocks on Nasdaq, NYSE and NYSE American. Kept
            only at $1 or more, with at least 100k shares and 2% of {mode === 'pre' ? "the last session's" : "today's"}{' '}
            volume traded in this session, since thin extended-hours moves often reverse at the open.
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
  return (
    <span className="mover-vol">
      <span title={`Shares traded in this ${mode === 'pre' ? 'pre-market' : 'after-hours'} session (Nasdaq)`}>
        {mode === 'pre' ? 'Pre' : 'AH'} vol <strong>{fmtVolume(x.volume)}</strong>
      </span>
      <span
        className="rvol"
        title={`This session's volume as a % of ${mode === 'pre' ? "the last session's" : "today's"} regular-session volume. Extended hours usually trade 2–5%.`}
      >
        <strong>{pct >= 100 ? `${(pct / 100).toFixed(1)}×` : `${pct.toFixed(0)}%`}</strong> of {mode === 'pre' ? 'last day' : 'today'}
      </span>
      <span className="rvol-bar" aria-hidden="true">
        {/* 2% (the minimum) -> empty, 100%+ of a normal day -> full, log scale */}
        <span style={{ width: `${Math.max(4, Math.min(100, (Math.log(pct / 2) / Math.log(50)) * 100))}%` }} />
      </span>
    </span>
  );
}
