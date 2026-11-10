import { useEffect, useRef, useState } from 'react';

const REFRESH_MS = 45_000; // server re-checks each symbol's news every ~2 min
const SHOW = 3;

const TONE = { 1: ['tone-up', '▲', 'Positive'], '-1': ['tone-down', '▼', 'Negative'], 0: ['tone-flat', '●', 'Neutral'] };

const ago = (sec) => {
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  return `${Math.round(m / 60)}h ago`;
};

/**
 * Right rail, under the top gainers: the newest headlines that name a stock, across the
 * watchlist, the stock being viewed, the current top gainers and the biggest US companies.
 * Polls for new items and marks ones that arrived since the last refresh.
 */
export default function LiveNews({ symbols, current, onSelect }) {
  const [state, setState] = useState({ data: null, error: null });
  const seen = useRef(new Set()); // headline ids already shown once
  const [fresh, setFresh] = useState(new Set());
  const [, tick] = useState(0); // re-render every 30 s so "5m ago" stays right
  const key = symbols.join(',');

  useEffect(() => {
    let alive = true;
    let timer;
    let first = true;
    const load = async () => {
      try {
        if (first || document.visibilityState === 'visible') {
          const r = await fetch(`/api/news-feed?symbols=${encodeURIComponent(key)}`);
          const j = await r.json();
          if (!r.ok) throw new Error(j.error || 'News unavailable');
          if (!alive) return;
          // Items not seen before are "new" (but not on the very first load).
          const newIds = new Set();
          for (const it of j.items || []) {
            if (!seen.current.has(it.id) && !first) newIds.add(it.id);
            seen.current.add(it.id);
          }
          if (newIds.size) {
            setFresh(newIds);
            setTimeout(() => alive && setFresh(new Set()), 60_000); // highlight fades after a minute
          }
          first = false;
          setState({ data: j, error: null });
        }
      } catch (e) {
        if (alive) setState((s) => ({ data: s.data, error: e.message }));
      }
      if (alive) timer = setTimeout(load, REFRESH_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && alive) {
        clearTimeout(timer);
        load();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    load();
    const clock = setInterval(() => tick((n) => n + 1), 30_000);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearInterval(clock);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key]);

  const { data, error } = state;
  if (data && !data.available) {
    return (
      <aside className="card livenews" aria-label="Latest stock news">
        <h2>Latest stock news</h2>
        <p className="movers-empty">{data.reason}</p>
      </aside>
    );
  }
  const items = (data?.items || []).slice(0, SHOW);

  return (
    <aside className="card livenews" aria-label="Latest stock news">
      <div className="movers-head">
        <h2>
          Latest stock news
          <span className="live-dot" aria-hidden="true" />
        </h2>
        <div className="movers-sub">
          Watchlist, top gainers &amp; big caps · checks every 45 s
          {data?.updatedAt && <> · updated {new Date(data.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</>}
        </div>
      </div>

      {!data && !error && <p className="movers-empty">Loading…</p>}
      {error && !data && <p className="movers-empty">{error}</p>}
      {data && items.length === 0 && <p className="movers-empty">No stock news in the last 24 hours yet.</p>}

      <ol className="livenews-list">
        {items.map((n) => {
          const [cls, icon, word] = TONE[n.tone] || TONE[0];
          return (
            <li key={n.id} className={fresh.has(n.id) ? 'is-new' : ''}>
              <div className="ln-top">
                {n.symbols.slice(0, 3).map((s) => (
                  <button
                    key={s}
                    className={`ln-sym${s === current ? ' is-on' : ''}`}
                    onClick={() => onSelect(s)}
                    title={`Open ${s}`}
                  >
                    {s}
                  </button>
                ))}
                {n.mover && <span className="ln-flag">Top gainer</span>}
                {fresh.has(n.id) && <span className="ln-flag ln-new">New</span>}
                <span className={`ln-tone ${cls}`} title={`${word} wording`} aria-label={word}>
                  {icon}
                </span>
                <span className="ln-age">{ago(n.time)}</span>
              </div>
              {n.url ? (
                <a className="ln-head" href={n.url} target="_blank" rel="noopener noreferrer">
                  {n.headline}
                </a>
              ) : (
                <span className="ln-head">{n.headline}</span>
              )}
              <div className="ln-meta">
                {n.source}
                {n.tags.slice(0, 2).map((t) => (
                  <span key={t.key} className="news-tag">
                    {t.label}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ol>
    </aside>
  );
}
