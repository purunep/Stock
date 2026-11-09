import { useEffect, useRef, useState } from 'react';
import SearchBox from './SearchBox.jsx';
import StockChart from './StockChart.jsx';
import Recommendation from './Recommendation.jsx';
import SignalBadge from './SignalBadge.jsx';
import TopMovers from './TopMovers.jsx';
import { useAnalysis } from './useAnalysis.js';
import { useLiveFeed } from './useLiveFeed.js';
import { fmtPrice, fmtChange, fmtPct, fmtVolume, fmtTime } from './format.js';

const RANGES = [
  { key: '1d', label: '1D' },
  { key: '5d', label: '5D' },
  { key: '1mo', label: '1M' },
  { key: '6mo', label: '6M' },
  { key: '1y', label: '1Y' },
  { key: '5y', label: '5Y' },
];
const WATCHLIST = ['SPCX', 'MSFT', 'NVDA', 'TSLA', 'AMZN', 'GOOGL', 'FUSE', 'SKHY'  ,'FRVO' ,'BIYA' , 'MRAM', 'QNT'];
const STATE_LABEL = {
  REGULAR: 'Market open',
  PRE: 'Pre-market',
  POST: 'After hours',
  CLOSED: 'Market closed',
  UNKNOWN: '',
};

const initialSymbol = () => new URLSearchParams(location.search).get('symbol')?.toUpperCase() || 'AAPL';

export default function App() {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [range, setRange] = useState('1d');
  const [chartType, setChartType] = useState('candle');
  const [dark, setDark] = useState(() => {
    const d = matchMedia('(prefers-color-scheme: dark)').matches;
    document.documentElement.dataset.theme = d ? 'dark' : 'light';
    return d;
  });
  const { quote, bars, warmup, resetSeq, status, error, loading } = useLiveFeed(symbol, range);
  const analysis = useAnalysis(symbol);
  const recoRef = useRef(null);

  // Set the theme attribute *before* re-render so the chart reads the new CSS variables.
  const toggleTheme = () => {
    const next = !dark;
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    setDark(next);
  };

  useEffect(() => {
    const url = new URL(location.href);
    url.searchParams.set('symbol', symbol);
    history.replaceState(null, '', url);
    document.title = quote?.price != null && !loading ? `${symbol} ${fmtPrice(quote.price)}` : `${symbol} · Live`;
  }, [symbol, quote?.price, loading]);

  const dir = quote?.change > 0 ? 'up' : quote?.change < 0 ? 'down' : 'flat';
  const live = status === 'live' && !error;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Live Stock Chart</div>
        <SearchBox onSelect={setSymbol} />
        <button className="ghost" onClick={toggleTheme} aria-label="Toggle theme">
          {dark ? 'Light' : 'Dark'}
        </button>
      </header>

      <nav className="watchlist" aria-label="Quick picks">
        {WATCHLIST.map((s) => (
          <button key={s} className={`chip${s === symbol ? ' is-on' : ''}`} onClick={() => setSymbol(s)}>
            {s}
          </button>
        ))}
      </nav>

      <div className="layout">
      <div className="layout-main">
      <main className="card">
        <section className="quote">
          <div className="quote-id">
            <h1>{symbol}</h1>
            <div className="quote-name">
              {quote && !loading ? `${quote.name} · ${quote.exchange} · ${quote.currency}` : ' '}
            </div>
          </div>

          {quote && !loading && (
            <div className="quote-price">
              <span className="price">{fmtPrice(quote.price)}</span>
              <span className={`delta delta-${dir}`}>
                <span aria-hidden="true">{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}</span>
                {fmtChange(quote.change)} ({fmtPct(quote.changePct)})
              </span>
              {quote.extPrice != null && (
                <span className="ext">
                  {STATE_LABEL[quote.marketState]}: <strong>{fmtPrice(quote.extPrice)}</strong>
                </span>
              )}
            </div>
          )}

          <SignalBadge
            analysis={analysis}
            livePrice={!loading ? quote?.price : null}
            onDetails={() => recoRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          />

          <div className={`status ${live ? 'is-live' : ''}`} title={error || status}>
            <span className="dot" aria-hidden="true" />
            {error
              ? error
              : status !== 'live'
              ? status === 'connecting' ? 'Connecting…' : 'Reconnecting…'
              : loading
              ? 'Loading…'
              : `Live · ${STATE_LABEL[quote?.marketState] || ''}`}
            {quote && !loading && live && (
              <span className="updated">updated {new Date(quote.updatedAt).toLocaleTimeString()}</span>
            )}
          </div>
        </section>

        <div className="controls">
          <div className="seg" role="group" aria-label="Range">
            {RANGES.map((r) => (
              <button key={r.key} className={r.key === range ? 'is-on' : ''} onClick={() => setRange(r.key)}>
                {r.label}
              </button>
            ))}
          </div>
          <div className="seg" role="group" aria-label="Chart type">
            <button className={chartType === 'area' ? 'is-on' : ''} onClick={() => setChartType('area')}>
              Line
            </button>
            <button className={chartType === 'candle' ? 'is-on' : ''} onClick={() => setChartType('candle')}>
              Candles
            </button>
          </div>
        </div>

        <StockChart
          bars={bars}
          warmup={warmup}
          resetSeq={resetSeq}
          quote={quote}
          chartType={chartType}
          range={range}
          dark={dark}
          dimmed={loading}
        />

        {quote && !loading && (
          <dl className="stats">
            <Stat label="Prev close" value={fmtPrice(quote.prevClose)} />
            <Stat label="Day range" value={`${fmtPrice(quote.dayLow)} – ${fmtPrice(quote.dayHigh)}`} />
            <Stat label="52-wk range" value={`${fmtPrice(quote.fiftyTwoWeekLow)} – ${fmtPrice(quote.fiftyTwoWeekHigh)}`} />
            <Stat label="Volume" value={fmtVolume(quote.volume)} />
            <Stat label="Last trade" value={fmtTime(quote.marketTime, quote.timezone)} />
          </dl>
        )}
      </main>

      <Recommendation symbol={symbol} analysis={analysis} ref={recoRef} />
      </div>

      <div className="layout-side">
        <TopMovers current={symbol} onSelect={setSymbol} />
      </div>
      </div>

      <footer className="foot">Data: Yahoo Finance (may be delayed for some exchanges). Not investment advice.</footer>
    </div>
  );
}

function Stat({ label, value }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
