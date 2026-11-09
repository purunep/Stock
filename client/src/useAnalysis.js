import { useEffect, useState } from 'react';

const REFRESH_MS = 60_000; // re-score against the latest price once a minute

/** Fetches /api/analysis/:symbol and keeps it fresh. Shared by the header badge and the detail panel. */
export function useAnalysis(symbol) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  useEffect(() => {
    let alive = true;
    const ctrl = new AbortController();
    const load = async () => {
      try {
        const res = await fetch(`/api/analysis/${encodeURIComponent(symbol)}`, { signal: ctrl.signal });
        const json = await res.json();
        if (!alive) return;
        if (!res.ok) throw new Error(json.error || 'Analysis failed');
        setState({ data: json, error: null, loading: false });
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
