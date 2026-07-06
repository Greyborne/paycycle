import React, { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { centsToInput, fmtDate, fmtMoney, fmtRange, parseMoney } from '../format.js';
import HealthBadge from '../components/HealthBadge.jsx';
import QuickAddTransaction from '../components/QuickAddTransaction.jsx';
import { useAccounts } from '../useAccounts.js';

function PlannedCell({ item, currency, editable, onSave }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  if (!editable || !editing) {
    return (
      <button
        className={`cell-amount ${editable ? 'editable' : ''}`}
        disabled={!editable}
        title={editable ? 'Click to edit this period only' : undefined}
        onClick={() => { setValue(centsToInput(item.planned_amount_cents)); setEditing(true); }}
      >
        {fmtMoney(item.planned_amount_cents, currency)}
      </button>
    );
  }
  const commit = async () => {
    const cents = parseMoney(value);
    if (cents !== null && cents !== item.planned_amount_cents) await onSave(cents);
    setEditing(false);
  };
  return (
    <input
      className="cell-input" type="text" inputMode="decimal" value={value} autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') setEditing(false); }}
    />
  );
}

function ItemTable({ title, items, currency, editable, onPatch, plannedTotal, clearedTotal, clearedNote, accounts }) {
  const showAccounts = accounts.length > 1;
  const cols = showAccounts ? 4 : 3;
  return (
    <div className="period-table">
      <h3>{title}</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Category</th>
            <th className="num">Planned</th>
            {showAccounts && <th>Account</th>}
            <th className="center">Cleared</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td colSpan={cols} className="muted">No line items{editable ? ' — add categories to populate this period' : ''}.</td></tr>
          )}
          {items.map((item, i) => (
            <tr key={item.id ?? `v${i}`}>
              <td>
                {item.name}
                {item.recurrence === 'monthly' && <span className="muted small"> · due day {item.due_day}</span>}
              </td>
              <td className="num">
                <PlannedCell
                  item={item} currency={currency} editable={editable}
                  onSave={(cents) => onPatch(item, { plannedAmountCents: cents })}
                />
              </td>
              {showAccounts && (
                <td>
                  <select
                    value={item.account_id ?? ''} disabled={!editable}
                    onChange={(e) => onPatch(item, { accountId: Number(e.target.value) })}
                    aria-label="Account"
                  >
                    {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </td>
              )}
              <td className="center">
                <input
                  type="checkbox" checked={item.cleared} disabled={!editable}
                  title={item.cleared_date ? `Cleared ${fmtDate(item.cleared_date)}` : 'Has this posted to your bank account?'}
                  onChange={(e) => onPatch(item, { cleared: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total planned</td>
            <td className="num">{fmtMoney(plannedTotal, currency)}</td>
            <td colSpan={cols - 2} />
          </tr>
          <tr>
            <td>Total cleared{clearedNote ? <span className="muted small"> {clearedNote}</span> : null}</td>
            <td className="num">{fmtMoney(clearedTotal, currency)}</td>
            <td colSpan={cols - 2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

export default function PeriodDetail() {
  const { start } = useParams();
  const { user } = useAuth();
  const { base: baseAccounts } = useAccounts();
  const currency = user.currency;
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setData(await api(`/periods/${start}`));
    } catch (err) {
      setError(err.message);
    }
  }, [start]);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <div className="page-loading">Loading…</div>;

  const { period, expenses, income, transactions, summary, nav } = data;
  const editable = period.materialized;

  const patchItem = async (item, body) => {
    await api(`/periods/line-items/${item.id}`, { method: 'PATCH', body });
    load();
  };
  const deleteTxn = async (id) => {
    await api(`/transactions/${id}`, { method: 'DELETE' });
    load();
  };

  return (
    <div className="period-page">
      <div className="period-header card">
        <Link className="btn btn-ghost" to={`/period/${nav.prevStart}`}>← Previous</Link>
        <div className="period-title">
          <h1>{fmtRange(period.start, period.end)}</h1>
          <div>
            {period.materialized
              ? (summary?.isCurrent ? <span className="badge badge-current">Current period</span> : <span className="muted small">Recorded period</span>)
              : <span className="badge health-none">Projected — computed from your categories</span>}
          </div>
        </div>
        <Link className="btn btn-ghost" to={`/period/${nav.nextStart}`}>Next →</Link>
      </div>

      {summary && (
        <div className="card period-summary">
          <div className="totals-grid">
            <div className="stat">
              <div className="stat-label">Estimated running balance</div>
              <div className="stat-value">
                <HealthBadge health={summary.health}>{fmtMoney(summary.estBalance, currency)}</HealthBadge>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Period loss / gain</div>
              <div className="stat-value">
                <HealthBadge health={summary.empty ? 'none' : summary.lossGain < 0 ? 'negative' : 'healthy'}>
                  {fmtMoney(summary.lossGain, currency)}
                </HealthBadge>
              </div>
            </div>
            <div className="stat">
              <div className="stat-label">Misc income</div>
              <div className="stat-value">{fmtMoney(summary.miscIncome, currency)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Misc expenses</div>
              <div className="stat-value">{fmtMoney(summary.miscExpenses, currency)}</div>
            </div>
          </div>
        </div>
      )}

      <div className="period-columns">
        <ItemTable
          title="Expenses" items={expenses} currency={currency} editable={editable} onPatch={patchItem}
          plannedTotal={summary?.plannedExpenses ?? 0}
          clearedTotal={summary?.clearedExpenses ?? 0}
          clearedNote="(cleared items + misc transactions)"
          accounts={baseAccounts}
        />
        <ItemTable
          title="Income" items={income} currency={currency} editable={editable} onPatch={patchItem}
          plannedTotal={summary?.plannedIncome ?? 0}
          clearedTotal={summary?.clearedIncome ?? 0}
          clearedNote="(cleared items + misc income)"
          accounts={baseAccounts}
        />
      </div>

      <section className="card">
        <h2>Misc transactions</h2>
        <p className="muted small">
          One-off, uncategorized amounts for this period. Expenses count toward cleared expenses;
          income counts toward misc income.
        </p>
        {editable ? <QuickAddTransaction onAdded={load} /> : (
          <p className="muted">Transactions can be added once this period is reached.</p>
        )}
        {transactions.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Description</th><th>Type</th><th className="num">Amount</th><th /></tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td>{fmtDate(t.date)}</td>
                  <td>
                    {t.description || <span className="muted">—</span>}
                    {t.entered_by && t.entered_by !== user.email && (
                      <span className="muted small"> · {t.entered_by}</span>
                    )}
                  </td>
                  <td>
                    {t.type}
                    {t.account_currency && (
                      <span className="muted small" title="On a foreign-currency tracked account — not counted in period totals">
                        {' '}· {t.account_name} ({t.account_currency})
                      </span>
                    )}
                  </td>
                  <td className={`num ${t.type === 'expense' ? 'amount-neg' : ''}`}>
                    {t.type === 'expense' ? '−' : ''}{fmtMoney(t.amount_cents, t.account_currency || currency)}
                  </td>
                  <td className="center">
                    <button className="btn btn-ghost btn-small" onClick={() => deleteTxn(t.id)} aria-label="Delete transaction">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
