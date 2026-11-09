import { useEffect, useRef, useState } from 'react';

const WS_URL = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
const feedKey = (symbol, range) => `${symbol.toUpperCase()}:${range}`;

/** Merge incoming bars into an existing time-sorted array (replace same time, append newer). */
function mergeBars(prev, incoming) {
  if (!prev.length) return incoming;
  const out = prev.slice();
  for (const bar of incoming) {
    if (bar.time > out[out.length - 1].time) {
      out.push(bar);
      continue;
    }
    for (let i = out.length - 1; i >= 0 && out[i].time >= bar.time; i--) {
      if (out[i].time === bar.time) {
        out[i] = bar;
        break;
      }
    }
  }
  return out;
}

/**
 * Subscribes to the backend WebSocket feed for (symbol, range).
 * - `loadedKey` is the feed the current bars belong to; `loading` is true until the
 *   snapshot for the requested feed arrives (the chart keeps the old frame meanwhile).
 * - `resetSeq` increments on every snapshot so the chart re-seeds with setData().
 */
export function useLiveFeed(symbol, range) {
  const [state, setState] = useState({
    quote: null,
    bars: [],
    warmup: [], // earlier bars, same interval, so EMAs are warmed up from the first visible bar
    loadedKey: null,
    resetSeq: 0,
    status: 'connecting',
    error: null,
  });
  const wsRef = useRef(null);
  const wantKeyRef = useRef(feedKey(symbol, range));
  const subRef = useRef({ symbol, range });
  subRef.current = { symbol, range };
  wantKeyRef.current = feedKey(symbol, range);

  // One socket for the lifetime of the component, with auto-reconnect.
  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer;

    const connect = () => {
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;

      ws.onopen = () => {
        retry = 0;
        setState((s) => ({ ...s, status: 'live' }));
        const { symbol: sym, range: rng } = subRef.current;
        if (sym) ws.send(JSON.stringify({ type: 'subscribe', symbol: sym, range: rng }));
      };

      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.key && msg.key !== wantKeyRef.current) return; // late message from a previous feed
        if (msg.type === 'snapshot') {
          setState((s) => ({
            ...s,
            quote: msg.quote,
            bars: msg.bars,
            warmup: msg.warmup || [],
            loadedKey: msg.key,
            resetSeq: s.resetSeq + 1,
            error: null,
          }));
        } else if (msg.type === 'tick') {
          setState((s) =>
            s.loadedKey === msg.key
              ? { ...s, quote: msg.quote, bars: mergeBars(s.bars, msg.bars), error: null }
              : s,
          );
        } else if (msg.type === 'error') {
          setState((s) => ({ ...s, error: msg.error }));
        }
      };

      ws.onclose = () => {
        if (closed) return;
        setState((s) => ({ ...s, status: 'reconnecting' }));
        timer = setTimeout(connect, Math.min(1000 * 2 ** retry++, 15000));
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  // (Re)subscribe whenever symbol or range changes.
  useEffect(() => {
    setState((s) => ({ ...s, error: null }));
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN && symbol) {
      ws.send(JSON.stringify({ type: 'subscribe', symbol, range }));
    }
  }, [symbol, range]);

  return { ...state, loading: state.loadedKey !== feedKey(symbol, range) };
}
