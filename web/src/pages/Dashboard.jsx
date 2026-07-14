import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAccount } from '../App.jsx';
import { fmtDate, fmtMoney, fmtRange } from '../format.js';
import HealthBadge from '../components/HealthBadge.jsx';
import ProjectionChart from '../components/ProjectionChart.jsx';
import QuickAddTransaction from '../components/QuickAddTransaction.jsx';

export default function Dashboard() {
  const { accountId } = useAccount();
  const [data, setData] = useState(null);
  const [tags, setTags] = useState([]);
  const [months, setMonths] = useState(24);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      setData(await api(`/dashboard?months=${months}&account=${accountId ?? ''}`));
    } catch (err) {
      setError(err.message);
    }
  }, [months, accountId]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    api('/categories')
      .then((d) => setTags(d.categories.filter((c) => c.categoryType === 'tag' && !c.archived)))
      .catch(() => {});
  }, []);

  if (error) return <div className="dashboard dashboard-placeholder"><p className="form-error">{error}</p></div>;
  if (!data) return <div className="dashboard dashboard-placeholder"><div className="page-loading">Loading…</div></div>;

  const { currency, currentPeriod: cur, projection, firstNegative, firstBelowWarning } = data;
  const upcoming = projection.filter((e) => !e.materialized).slice(0, 8);
  const activeAccounts = (data.accounts || []).filter((a) => !a.archived);
  const account = data.accounts?.find((a) => a.id === data.accountId);

  return (
    <div className="dashboard">
      {/* Hero: the selected account's actual/cleared balance */}
      <section className="hero card">
        <div>
          <div className="stat-label">Actual balance{account ? ` · ${account.name}` : ''}</div>
          <div className="hero-figure">{fmtMoney(data.actualBalanceCents, currency)}</div>
          <div className="muted small">
            Cleared items and transactions only
            {data.actualAsOf ? ` · through the period of ${fmtRange(data.actualAsOf.start, data.actualAsOf.end)}` : ''}
          </div>
        </div>
        {cur && (
          <div className="hero-side">
            <div className="stat-label">
              Estimated balance, this period{' '}
              <HealthBadge health={cur.health}>{fmtMoney(cur.estBalance, currency)}</HealthBadge>
            </div>
            <div className="muted small">
              Assumes all planned income and expenses for {fmtRange(cur.start, cur.end)} happen as scheduled
            </div>
          </div>
        )}
      </section>

      {(firstNegative || firstBelowWarning) && (
        <section className="warning-banner" role="alert">
          {firstNegative ? (
            <>
              <strong>Heads up:</strong>&nbsp;{account ? `${account.name} is` : 'your balance is'} projected to go negative
              ({fmtMoney(firstNegative.estBalance, currency)}) in the period starting{' '}
              <Link to={`/period/${firstNegative.start}`}>{fmtDate(firstNegative.start)}</Link>.
            </>
          ) : (
            <>
              <strong>Heads up:</strong>&nbsp;{account ? `${account.name} is` : 'your balance is'} projected below your warning threshold
              ({fmtMoney(firstBelowWarning.estBalance, currency)}) in the period starting{' '}
              <Link to={`/period/${firstBelowWarning.start}`}>{fmtDate(firstBelowWarning.start)}</Link>.
            </>
          )}
        </section>
      )}

      {/* Net worth: the only place accounts are combined */}
      {activeAccounts.length > 1 && (
        <section className="card networth">
          <div>
            <div className="stat-label">Net worth · all accounts</div>
            <div className="networth-figure">{fmtMoney(data.netWorthCents, currency)}</div>
          </div>
          <div className="account-chips">
            {activeAccounts.map((a) => (
              <span
                key={a.id}
                className={`account-chip ${a.id === data.accountId ? 'account-chip-active' : ''}`}
                title={a.currency ? 'Tracked in its own currency; not part of the total' : undefined}
              >
                <span className="muted">{a.name}</span> {fmtMoney(a.balanceCents, a.currency || currency)}
              </span>
            ))}
          </div>
        </section>
      )}

      <section className="card dash-chart">
        <div className="card-head">
          <h2>Estimated running balance</h2>
          <div className="range-picker" role="group" aria-label="Projection horizon">
            {[3, 6, 12, 24, 36].map((m) => (
              <button
                key={m}
                className={`btn btn-ghost ${months === m ? 'active' : ''}`}
                onClick={() => setMonths(m)}
              >
                {m} mo
              </button>
            ))}
          </div>
        </div>
        <ProjectionChart
          entries={projection}
          currency={currency}
          firstNegative={firstNegative}
        />
      </section>

      {cur && (
        <section className="card dash-period">
          <div className="card-head">
            <h2>This pay period · {fmtRange(cur.start, cur.end)}</h2>
            <Link className="btn btn-ghost" to="/period/current">Open period →</Link>
          </div>
          <div className="totals-grid">
            <div className="stat">
              <div className="stat-label">Planned expenses</div>
              <div className="stat-value">{fmtMoney(cur.plannedExpenses, currency)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Cleared expenses</div>
              <div className="stat-value">{fmtMoney(cur.clearedExpenses, currency)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Planned income</div>
              <div className="stat-value">{fmtMoney(cur.plannedIncome, currency)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Cleared income</div>
              <div className="stat-value">{fmtMoney(cur.clearedIncome, currency)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Period loss / gain</div>
              <div className="stat-value">
                <HealthBadge health={cur.empty ? 'none' : cur.lossGain < 0 ? 'negative' : 'healthy'}>
                  {fmtMoney(cur.lossGain, currency)}
                </HealthBadge>
              </div>
            </div>
          </div>
          <h3>Quick add transaction</h3>
          <QuickAddTransaction onAdded={load} fixedAccountId={data.accountId} tags={tags} />
        </section>
      )}

      <section className="card dash-upcoming">
        <h2>Upcoming periods</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Period</th>
              <th className="num">Planned income</th>
              <th className="num">Planned expenses</th>
              <th className="num">Loss / gain</th>
              <th className="num">Projected balance</th>
              <th>Health</th>
            </tr>
          </thead>
          <tbody>
            {upcoming.map((e) => (
              <tr key={e.start}>
                <td><Link to={`/period/${e.start}`}>{fmtRange(e.start, e.end)}</Link></td>
                <td className="num">{fmtMoney(e.plannedIncome, currency)}</td>
                <td className="num">{fmtMoney(e.plannedExpenses, currency)}</td>
                <td className="num">{fmtMoney(e.lossGain, currency)}</td>
                <td className="num">{fmtMoney(e.estBalance, currency)}</td>
                <td><HealthBadge health={e.health} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
