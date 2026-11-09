import { fmtPrice } from './format.js';

const ARROW = { 'strong-buy': '▲▲', buy: '▲', hold: '■', sell: '▼', 'strong-sell': '▼▼' };

/**
 * Compact signal shown beside the symbol at the top of the page: the live verdict, how
 * likely it is to work (from the back-test), and the price levels for the current price.
 */
export default function SignalBadge({ analysis, livePrice, onDetails }) {
  const { data, loading, error } = analysis;
  if (error && !data) return <div className="sig sig-empty">Signal unavailable</div>;
  if (!data) return <div className="sig sig-empty">{loading ? 'Analysing…' : ''}</div>;

  const { plan, live, probability: p } = data;
  // How far the live price has drifted from the price the signal was computed at.
  const drift = livePrice != null && plan?.reference ? ((livePrice - plan.reference) / plan.reference) * 100 : 0;
  const stale = Math.abs(drift) > 1;

  return (
    <div className="sig">
      <div className="sig-top">
        <button className={`sig-verdict verdict-${live.verdictKey}`} onClick={onDetails} title="See full analysis">
          <span aria-hidden="true" className="sig-arrow">{ARROW[live.verdictKey]}</span>
          {live.verdict}
          <span className="sig-score">{live.score > 0 ? '+' : ''}{live.score}</span>
        </button>
        <span
          className={`prob-badge prob-${p.level.toLowerCase().replace(' ', '-')}`}
          title={p.reason}
        >
          {p.level === 'No edge' ? 'No edge' : `${p.level} probability`}
          {p.winRate != null && p.level !== 'No edge' && <b> {p.winRate}%</b>}
        </span>
      </div>

      {plan && (
        <div className="sig-levels">
          <Lvl label={plan.bias === 'neutral' ? 'Buy below' : plan.bias === 'short' ? 'Sell near' : 'Buy near'} value={plan.entry} />
          <Lvl label="Target" value={plan.target} kind={plan.bias === 'short' ? 'down' : 'up'} />
          <Lvl label="Stop" value={plan.stop} kind={plan.bias === 'short' ? 'up' : 'down'} />
          {plan.riskReward != null && <Lvl label="R:R" text={`1 : ${plan.riskReward}`} />}
        </div>
      )}

      <div className="sig-meta">
        {live.intraday.available ? 'Live' : 'Daily'} signal at {fmtPrice(plan?.reference ?? data.price)}
        {data.earnings?.soon && <span className="sig-warn"> · earnings in {Math.max(0, data.earnings.daysAway)}d</span>}
        {stale && <span className="sig-stale"> · price moved {drift > 0 ? '+' : ''}{drift.toFixed(1)}%, refreshing</span>}
      </div>
    </div>
  );
}

function Lvl({ label, value, text, kind }) {
  return (
    <span className="sig-lvl">
      <span className="sig-lvl-label">{label}</span>
      <strong className={kind ? `lvl-${kind}` : ''}>{text ?? fmtPrice(value)}</strong>
    </span>
  );
}
