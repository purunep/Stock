import { forwardRef, useState } from 'react';
import { fmtPrice } from './format.js';

const ICON = { bullish: '▲', bearish: '▼', neutral: '●' };
const STANCE_LABEL = { bullish: 'Bullish', bearish: 'Bearish', neutral: 'Neutral' };

const Recommendation = forwardRef(function Recommendation({ symbol, analysis }, ref) {
  const { data, error, loading } = analysis;
  const [open, setOpen] = useState(true);

  if (error && !data) {
    return (
      <section className="card reco" ref={ref}>
        <h2>Buy / Sell signal</h2>
        <p className="reco-empty">{error}</p>
      </section>
    );
  }
  if (!data || data.symbol !== symbol) {
    return (
      <section className="card reco is-dimmed" ref={ref}>
        <h2>Buy / Sell signal</h2>
        <p className="reco-empty">{loading ? 'Analysing…' : ''}</p>
      </section>
    );
  }

  const { levels, analyst, plan, live, probability, earnings } = data;
  const intraday = live.intraday;
  // The table lists daily/analyst signals plus the intraday ones computed at the live price.
  const allSignals = [...data.signals, ...(intraday.available ? intraday.signals : [])];
  const groups = ['Intraday', 'Technical', 'Analysts'];

  return (
    <section className="card reco" ref={ref}>
      <div className="reco-head">
        <div>
          <h2>Buy / Sell signal</h2>
          <div className="reco-sub">Based on {data.basis}</div>
        </div>
        <div className={`verdict verdict-${live.verdictKey}`}>
          <span className="verdict-label">{live.verdict}</span>
          <span className="verdict-conf">
            Live now · daily view: {data.verdict}
          </span>
        </div>
      </div>

      <Gauge score={live.score} />

      <div className="reco-split">
        <SubScore label="Live (daily + intraday)" value={live.score} />
        <SubScore label="Daily technical" value={data.technicalScore} />
        <SubScore label="Intraday" value={intraday.available ? intraday.score : null} none="Market closed" />
        <SubScore label="Analysts" value={data.analystScore} />
      </div>

      {earnings?.soon && (
        <div className="warn" role="note">
          <strong>Earnings {earnings.daysAway <= 0 ? 'today' : `in ${earnings.daysAway} day${earnings.daysAway === 1 ? '' : 's'}`}.</strong>{' '}
          Results can move the price far more than any technical signal. Treat this signal with extra caution.
        </div>
      )}

      <Probability probability={probability} />

      {plan && (
        <div className="plan">
          <div className="plan-title">Today's price levels</div>
          <p className="plan-note">{plan.note}</p>
          <p className="plan-how">
            Calculated at {fmtPrice(plan.reference)}. Stop and fallback targets are sized by the average daily
            range (ATR {fmtPrice(plan.atr)}). They recalculate as the live price moves.
          </p>
        </div>
      )}

      {analyst?.trend && <AnalystBar trend={analyst.trend} count={analyst.analystCount} />}

      <dl className="levels">
        <Level label="Support (20D low)" value={fmtPrice(levels.support)} />
        <Level label="Resistance (20D high)" value={fmtPrice(levels.resistance)} />
        <Level label="50-day avg" value={fmtPrice(levels.sma50)} />
        <Level label="200-day avg" value={fmtPrice(levels.sma200)} />
        {analyst?.targetMean != null && <Level label="Analyst target" value={fmtPrice(analyst.targetMean)} />}
      </dl>

      <button className="reco-toggle" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        {open ? 'Hide' : 'Show'} signal breakdown ({allSignals.length})
      </button>

      {open && (
        <table className="signals">
          <thead>
            <tr>
              <th>Signal</th>
              <th>Reading</th>
              <th>Stance</th>
              <th className="hide-sm">Why</th>
            </tr>
          </thead>
          {groups.map((g) => {
            const rows = allSignals.filter((s) => s.group === g);
            if (!rows.length) return null;
            return (
              <tbody key={g}>
                <tr className="group-row">
                  <th colSpan={4}>{g}</th>
                </tr>
                {rows.map((s) => (
                  <tr key={s.name}>
                    <td>{s.name}</td>
                    <td className="num">{s.value}</td>
                    <td>
                      <span className={`stance stance-${s.stance}`}>
                        <span aria-hidden="true">{ICON[s.stance]}</span> {STANCE_LABEL[s.stance]}
                      </span>
                    </td>
                    <td className="why hide-sm">{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            );
          })}
        </table>
      )}

      {!intraday.available && <p className="reco-empty">Intraday signals: {intraday.reason}</p>}

      <p className="disclaimer">
        Automated rule-based signal from price indicators, a historical back-test and published analyst ratings. Past
        results do not predict future returns, and no signal is a guarantee. For information only, not financial
        advice. Do your own research before trading.
      </p>
    </section>
  );
});

export default Recommendation;

const LEVEL_HELP = {
  High: 'Strong historical edge, and the live price confirms it.',
  Moderate: 'Some historical edge, but not every check agrees.',
  Low: 'Little or no historical edge for this setup.',
  'No edge': 'Hold zone: there is no direction to rate.',
  Unknown: 'Not enough history.',
};

/** How often similar past setups worked, tempered by whether the live price confirms. */
function Probability({ probability: p }) {
  const h = p.history;
  const goingDown = p.direction === -1;
  return (
    <div className="prob">
      <div className="prob-head">
        <div>
          <div className="plan-title">Probability at the live price</div>
          <div className="prob-help">{LEVEL_HELP[p.level]}</div>
        </div>
        <span className={`prob-badge prob-${p.level.toLowerCase().replace(' ', '-')}`}>{p.level}</span>
      </div>

      {h && p.winRate != null && (
        <div className="prob-stats">
          <Pct
            label={`${goingDown ? 'Lower' : 'Higher'} after ${h.horizonDays} days`}
            value={p.winRate}
            base={p.baseRate}
          />
          {p.barrier && (
            <Pct
              label={`${goingDown ? '−' : '+'}${p.barrier.atr} ATR hit first (≤${p.barrier.days}d)`}
              value={p.barrier.targetFirstPct}
              base={p.barrier.baseTargetFirstPct}
            />
          )}
          <div className="pstat">
            <span className="pstat-label">Similar past days</span>
            <strong>{h.cases}</strong>
            <span className="pstat-base">avg {h.avgReturnPct >= 0 ? '+' : ''}{h.avgReturnPct}% after {h.horizonDays}d</span>
          </div>
        </div>
      )}

      <p className="prob-reason">{p.reason}</p>
    </div>
  );
}

/** A percentage with a bar and a tick marking the average-day baseline. */
function Pct({ label, value, base }) {
  const edge = value - base;
  return (
    <div className="pstat">
      <span className="pstat-label">{label}</span>
      <strong>{value}%</strong>
      <span className="pbar" aria-hidden="true">
        <span className="pbar-fill" style={{ width: `${value}%` }} />
        <span className="pbar-base" style={{ left: `${base}%` }} />
      </span>
      <span className="pstat-base">
        average day {base}% ({edge >= 0 ? '+' : ''}{edge} pts)
      </span>
    </div>
  );
}

/** Score gauge: −100 (strong sell) … +100 (strong buy). */
function Gauge({ score }) {
  const pos = ((score + 100) / 200) * 100;
  return (
    <div className="gauge" role="meter" aria-valuemin={-100} aria-valuemax={100} aria-valuenow={score} aria-label="Signal score">
      <div className="gauge-track">
        <div className="gauge-zone z-ss" />
        <div className="gauge-zone z-s" />
        <div className="gauge-zone z-h" />
        <div className="gauge-zone z-b" />
        <div className="gauge-zone z-sb" />
        <div className="gauge-needle" style={{ left: `${pos}%` }}>
          <span className="gauge-value">{score > 0 ? '+' : ''}{score}</span>
        </div>
      </div>
      <div className="gauge-labels">
        <span>Strong sell</span>
        <span>Sell</span>
        <span>Hold</span>
        <span>Buy</span>
        <span>Strong buy</span>
      </div>
    </div>
  );
}

function SubScore({ label, value, none = 'No coverage' }) {
  const stance = value == null ? 'none' : value > 15 ? 'bullish' : value < -15 ? 'bearish' : 'neutral';
  return (
    <div className="subscore">
      <span className="subscore-label">{label}</span>
      {value == null ? (
        <span className="subscore-value muted">{none}</span>
      ) : (
        <span className={`subscore-value stance-${stance}`}>
          <span aria-hidden="true">{ICON[stance]}</span> {value > 0 ? '+' : ''}
          {value}
        </span>
      )}
    </div>
  );
}

function AnalystBar({ trend, count }) {
  const parts = [
    ['strongBuy', 'Strong buy'],
    ['buy', 'Buy'],
    ['hold', 'Hold'],
    ['sell', 'Sell'],
    ['strongSell', 'Strong sell'],
  ];
  const total = parts.reduce((s, [k]) => s + (trend[k] || 0), 0);
  if (!total) return null;
  return (
    <div className="abar">
      <div className="abar-title">
        Analyst ratings <span className="muted">({count ?? total} analysts)</span>
      </div>
      <div className="abar-track">
        {parts.map(([k, label]) =>
          trend[k] ? (
            <div
              key={k}
              className={`abar-seg seg-${k}`}
              style={{ flexGrow: trend[k] }}
              title={`${label}: ${trend[k]}`}
            />
          ) : null,
        )}
      </div>
      <div className="abar-legend">
        {parts.map(([k, label]) => (
          <span key={k}>
            <i className={`swatch seg-${k}`} /> {label} <strong>{trend[k] || 0}</strong>
          </span>
        ))}
      </div>
    </div>
  );
}

function Level({ label, value }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
