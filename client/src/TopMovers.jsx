import { useEffect, useState } from 'react';
import { fmtPrice, fmtPct, fmtVolume } from './format.js';

const REFRESH_MS = 30_000;

/** Right-rail list: today's top 3 gainers that are trading on unusually high volume. */
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

  return (
    <aside className="card movers" aria-label="Top gainers on high volume">
      <div className="movers-head">
        <h2>Top gainers · high volume</h2>
        <div className="movers-sub">US stocks · refreshed every 30 s</div>
      </div>

      {!data && !error && <p className="movers-empty">Loading…</p>}
      {error && !data && <p className="movers-empty">{error}</p>}
      {data && movers.length === 0 && (
        <p className="movers-empty">No liquid gainers with above-normal volume right now.</p>
      )}

      <ol className="movers-list">
        {movers.map((m, i) => (
          <li key={m.symbol}>
            <button
              className={`mover${m.symbol === current ? ' is-on' : ''}`}
              onClick={() => onSelect(m.symbol)}
              title={`Open ${m.symbol}`}
            >
              <span className="mover-rank">{i + 1}</span>
              <span className="mover-id">
                <span className="mover-sym">
                  {m.symbol}
                  {m.smallCap && (
                    <span className="tag-risk" title={`Market cap ${fmtVolume(m.marketCap)}: small caps are more volatile and easier to move`}>
                      Small cap
                    </span>
                  )}
                </span>
                <span className="mover-name">{m.name}</span>
              </span>
              <span className="mover-px">
                <span className="mover-chg">
                  <span aria-hidden="true">▲</span> {fmtPct(m.changePct)}
                </span>
                <span className="mover-price">{fmtPrice(m.price)}</span>
              </span>
              <span className="mover-vol">
                <span>
                  Vol <strong>{fmtVolume(m.volume)}</strong>
                </span>
                <span className="rvol" title="Today's volume vs. the 3-month average">
                  <strong>{m.rvol.toFixed(1)}×</strong> avg
                </span>
                <span className="rvol-bar" aria-hidden="true">
                  <span style={{ width: `${Math.min(100, (Math.log2(m.rvol) / Math.log2(20)) * 100)}%` }} />
                </span>
              </span>
            </button>
          </li>
        ))}
      </ol>

      <p className="movers-note">
        Biggest % gainers on Nasdaq, NYSE and NYSE American (same order as Yahoo's Gainers page), kept only if trading
        at least 1.5× their 3-month average volume. Also excludes stocks under $1, under 500k shares traded or under
        $50M market cap.
        {data?.candidates != null && ` ${data.candidates} stocks qualify right now.`}
      </p>
    </aside>
  );
}
