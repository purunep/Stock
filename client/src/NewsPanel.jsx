import { useEffect, useState } from 'react';

const REFRESH_MS = 3 * 60_000; // server caches news for 3 min

const TONE = {
  1: { cls: 'tone-up', icon: '▲', word: 'Positive' },
  '-1': { cls: 'tone-down', icon: '▼', word: 'Negative' },
  0: { cls: 'tone-flat', icon: '●', word: 'Neutral' },
};

// What each catalyst usually means for the trade. Plain guidance, not a prediction.
const MEANING = {
  earnings: 'Earnings moves often keep going for a few days when results and guidance both beat, and fade when only one does.',
  guidance: 'A change in outlook tends to matter more than the last quarter’s numbers.',
  offering: 'The company is selling new shares. That adds supply and often pulls the price back down. Be careful chasing it.',
  'reverse-split': 'Reverse splits often come before more selling and usually aren’t a bullish sign.',
  bankruptcy: 'Bankruptcy or delisting risk: rallies are often short-lived and very risky.',
  fda: 'FDA and trial news can gap a stock hard either way; the first move isn’t always the last.',
  mna: 'Takeover news usually pins the price near the offer; extra upside depends on a higher bid.',
  analyst: 'Rating changes move stocks for a day or two; the effect usually fades.',
  contract: 'Contract and partnership news helps most when the deal is large relative to the company.',
  legal: 'Legal and regulatory news is usually a headwind until resolved.',
  none: 'No company news: a big move without a reason is more likely to reverse.',
  news: 'News but no clear catalyst type; read the headlines below.',
};

const ago = (sec) => {
  const m = Math.round((Date.now() / 1000 - sec) / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
};

export function useNews(symbol) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const r = await fetch(`/api/news/${encodeURIComponent(symbol)}`, { signal: ctrl.signal });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || 'News unavailable');
        if (alive) setState({ data: j, error: null, loading: false });
      } catch (e) {
        if (alive && e.name !== 'AbortError') setState((s) => ({ data: s.data, error: e.message, loading: false }));
      }
    };
    setState({ data: null, error: null, loading: true });
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      ctrl.abort();
      clearInterval(t);
    };
  }, [symbol]);
  return state;
}

/** Compact "why is it moving" line for the top of the page. */
export function CatalystLine({ news, onMore }) {
  const d = news.data;
  if (!d?.available || !d.catalyst) return null;
  const c = d.catalyst;
  const t = TONE[c.tone] || TONE[0];
  return (
    <button className={`catalyst ${t.cls}`} onClick={onMore} title="See news">
      <span className="catalyst-label">News</span>
      <span aria-hidden="true">{t.icon}</span>
      <strong>{c.label}</strong>
      {c.latest && <span className="catalyst-head">{c.latest.headline}</span>}
      {c.latest && <span className="catalyst-age">{ago(c.latest.time)}</span>}
    </button>
  );
}

/** Full news card. */
export default function NewsPanel({ symbol, news, panelRef }) {
  const { data, error, loading } = news;

  if (data && !data.available) {
    return (
      <section className="card news" ref={panelRef}>
        <h2>News</h2>
        <p className="reco-empty">{data.reason}</p>
      </section>
    );
  }

  const c = data?.catalyst;
  const t = c ? TONE[c.tone] || TONE[0] : null;
  const items = data?.items || [];

  return (
    <section className={`card news${loading && !data ? ' is-dimmed' : ''}`} ref={panelRef} aria-label={`News for ${symbol}`}>
      <div className="news-head">
        <div>
          <h2>News &amp; catalysts</h2>
          <div className="reco-sub">Last 7 days · Finnhub · refreshed every 3 min</div>
        </div>
        {c && (
          <div className={`news-cat ${t.cls}`}>
            <span className="news-cat-label">Last 24 h</span>
            <strong>
              <span aria-hidden="true">{t.icon}</span> {c.label}
            </strong>
            <span className="news-cat-sub">
              {c.fresh ? `${c.fresh} item${c.fresh === 1 ? '' : 's'} · ${t.word.toLowerCase()} tone` : 'Nothing new'}
            </span>
          </div>
        )}
      </div>

      {c && MEANING[c.key] && <p className="news-meaning">{MEANING[c.key]}</p>}

      {error && !data && <p className="reco-empty">{error}</p>}
      {loading && !data && <p className="reco-empty">Loading news…</p>}
      {data && items.length === 0 && <p className="reco-empty">No news for {symbol} in the last 7 days.</p>}

      <ul className="news-list">
        {items.map((n) => {
          const nt = TONE[n.tone] || TONE[0];
          const Tag = n.url ? 'a' : 'div';
          return (
            <li key={n.id ?? n.headline} className={n.relevant ? '' : 'is-mention'}>
              <Tag className="news-item" {...(n.url ? { href: n.url, target: '_blank', rel: 'noopener noreferrer' } : {})}>
                <span className={`news-tone ${nt.cls}`} title={`${nt.word} wording`} aria-label={nt.word}>
                  {nt.icon}
                </span>
                <span className="news-body">
                  <span className="news-title">{n.headline}</span>
                  <span className="news-meta">
                    {n.source} · {ago(n.time)}
                    {!n.relevant && ' · mentions this stock'}
                    {n.tags.map((tg) => (
                      <span key={tg.key} className="news-tag">
                        {tg.label}
                      </span>
                    ))}
                  </span>
                  {n.summary && <span className="news-summary">{n.summary}</span>}
                </span>
              </Tag>
            </li>
          );
        })}
      </ul>

      <p className="disclaimer">
        Tags and tone come from simple keyword rules on the headline and summary, so they can be wrong. Open the article
        before acting on it.
      </p>
    </section>
  );
}
