import { fmtPrice, fmtPct } from './format.js';

/**
 * Key prices for the selected stock, between the search bar and the watchlist:
 * symbol + live price, previous close, and today's range with a marker for where the price is.
 */
export default function PriceStrip({ symbol, quote, loading }) {
  const ready = Boolean(quote) && !loading;
  const price = ready ? quote.price : null;
  const lo = ready ? quote.dayLow : null;
  const hi = ready ? quote.dayHigh : null;
  const hasRange = price != null && lo != null && hi != null;
  // Where the price sits inside today's range: 0 = at the low, 1 = at the high.
  const pos = hasRange ? (hi > lo ? Math.min(1, Math.max(0, (price - lo) / (hi - lo))) : 0.5) : null;
  const dir = !ready ? 'flat' : quote.change > 0 ? 'up' : quote.change < 0 ? 'down' : 'flat';

  return (
    <section className={`pricestrip${ready ? '' : ' is-dim'}`} aria-label={`${symbol} key prices`}>
      <div className="ps-id">
        <span className="ps-sym">{symbol}</span>
        {ready && (
          <>
            <span className="ps-price">{fmtPrice(price)}</span>
            <span className={`ps-chg delta-${dir}`}>
              <span aria-hidden="true">{dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}</span> {fmtPct(quote.changePct)}
            </span>
          </>
        )}
      </div>

      <div className="ps-item">
        <span className="ps-label">Prev close</span>
        <strong>{ready ? fmtPrice(quote.prevClose) : '—'}</strong>
      </div>

      <div
        className="ps-item ps-range"
        title="Today's regular-session low and high. The marker shows where the price is within them."
      >
        <span className="ps-label">
          Day range
          {pos != null && <span className="ps-pos"> · price at {Math.round(pos * 100)}% of range</span>}
        </span>
        <div className="ps-rangebar" role="img" aria-label={hasRange ? `Low ${fmtPrice(lo)}, high ${fmtPrice(hi)}, price ${fmtPrice(price)}` : 'Day range unavailable'}>
          <strong>{hasRange ? fmtPrice(lo) : '—'}</strong>
          <span className="ps-track">
            {pos != null && (
              <>
                <span className="ps-fill" style={{ width: `${pos * 100}%` }} />
                <span className="ps-marker" style={{ left: `${pos * 100}%` }} />
              </>
            )}
          </span>
          <strong>{hasRange ? fmtPrice(hi) : '—'}</strong>
        </div>
      </div>
    </section>
  );
}
