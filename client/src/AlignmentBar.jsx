import { fmtPct } from './format.js';

const ARROW = { up: '▲', down: '▼', flat: '▬', mixed: '▬', unknown: '?' };
const WORD = { up: 'Up', down: 'Down', flat: 'Flat', mixed: 'Mixed', unknown: 'n/a' };
const CHECK_ICON = { pass: '✓', fail: '✗', neutral: '–' };

/**
 * One-line "is everything pointing the same way?" strip: trend on four timeframes, the
 * S&P 500, relative strength, and the checks the probability rating used.
 */
export default function AlignmentBar({ analysis }) {
  const a = analysis?.alignment;
  if (!a) return null;
  const p = analysis.probability;
  const dir = p?.direction === 1 ? 'up' : p?.direction === -1 ? 'down' : null;
  const m = a.market;

  return (
    <div className="align" role="group" aria-label="Trend alignment">
      <div className="align-group">
        <span className="align-title">Trend</span>
        {a.timeframes.map((t) => (
          <span
            key={t.key}
            className={`tf tf-${t.trend}${dir && t.trend === dir ? ' tf-agree' : ''}`}
            title={`${t.label} (${t.note}): ${WORD[t.trend]}. ${t.detail}. Rule: up = price > EMA 20 > EMA 50.`}
          >
            <span className="tf-label">{t.label}</span>
            <span aria-hidden="true">{ARROW[t.trend]}</span>
            <span className="tf-word">{WORD[t.trend]}</span>
          </span>
        ))}
        <span className={`align-sum align-${a.consensus}`}>
          {a.consensus === 'mixed' ? `${a.up} up · ${a.down} down` : `${Math.max(a.up, a.down)}/${a.total} ${a.consensus}`}
        </span>
      </div>

      {m && (
        <div className="align-group">
          <span className="align-title">Market</span>
          <span
            className={`tf tf-${m.stance}`}
            title={`S&P 500 (SPY): today ${fmtPct(m.changePct)}, ${m.aboveVwap ? 'above' : 'below'} VWAP; 5-min trend ${WORD[m.intradayTrend]}, daily trend ${WORD[m.dailyTrend]}.`}
          >
            <span className="tf-label">S&amp;P 500</span>
            <span aria-hidden="true">{ARROW[m.stance]}</span>
            <span className="tf-word">{fmtPct(m.changePct)}</span>
          </span>
          {a.relStrength != null && (
            <span
              className={`tf ${a.relStrength >= 0 ? 'tf-up' : 'tf-down'}`}
              title="Today's % change of this stock minus the S&P 500's. Positive = stronger than the market."
            >
              <span className="tf-label">vs market</span>
              <span className="tf-word">
                {a.relStrength >= 0 ? '+' : ''}
                {a.relStrength.toFixed(2)} pts
              </span>
            </span>
          )}
        </div>
      )}

      {p?.checks && dir && (
        <div className="align-group align-checks" title={p.reason}>
          <span className="align-title">Checks</span>
          {[
            ['history', 'History'],
            ['intraday', 'Live price'],
            ['timeframes', 'Timeframes'],
            ['market', 'Market'],
          ].map(([k, label]) =>
            p.checks[k] ? (
              <span key={k} className={`chk chk-${p.checks[k]}`}>
                <span aria-hidden="true">{CHECK_ICON[p.checks[k]]}</span> {label}
              </span>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
