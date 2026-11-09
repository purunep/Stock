import { useEffect, useRef, useState } from 'react';

/** Symbol search combobox backed by /api/search. Enter on raw text loads it as a ticker. */
export default function SearchBox({ onSelect }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setResults([]);
      return;
    }
    const ctrl = new AbortController();
    const t = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}`, { signal: ctrl.signal });
        const data = await res.json();
        setResults(Array.isArray(data) ? data : []);
        setActive(0);
        setOpen(true);
      } catch {
        /* aborted or offline */
      }
    }, 200);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [q]);

  useEffect(() => {
    const close = (e) => !boxRef.current?.contains(e.target) && setOpen(false);
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);

  const choose = (symbol) => {
    if (!symbol) return;
    onSelect(symbol.toUpperCase());
    setQ('');
    setResults([]);
    setOpen(false);
  };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(open && results[active] ? results[active].symbol : q.trim());
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  return (
    <div className="search" ref={boxRef}>
      <input
        type="search"
        placeholder="Search symbol or company (e.g. AAPL, Tesla, BTC-USD)"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onFocus={() => results.length && setOpen(true)}
        onKeyDown={onKeyDown}
        role="combobox"
        aria-expanded={open}
        aria-controls="search-results"
        aria-autocomplete="list"
      />
      {open && results.length > 0 && (
        <ul className="search-results" id="search-results" role="listbox">
          {results.map((r, i) => (
            <li
              key={r.symbol}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'is-active' : ''}
              onPointerEnter={() => setActive(i)}
              onPointerDown={(e) => {
                e.preventDefault();
                choose(r.symbol);
              }}
            >
              <span className="sr-symbol">{r.symbol}</span>
              <span className="sr-name">{r.name}</span>
              <span className="sr-meta">
                {r.type} · {r.exchange}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
