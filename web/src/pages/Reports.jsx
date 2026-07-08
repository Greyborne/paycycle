import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAccount, useAuth } from '../App.jsx';
import { fmtMoney } from '../format.js';
import { useAccounts } from '../useAccounts.js';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function RollupTable({ title, rows, miscRow, currency, mode, accountLabel }) {
  const cell = (m) => (mode === 'planned' ? m.planned : m.cleared);
  const rowTotal = (r) => r.months.reduce((s, m) => s + cell(m), 0);
  const miscTotal = miscRow.reduce((s, v) => s + v, 0);
  const colTotals = MONTHS.map((_, i) =>
    rows.reduce((s, r) => s + cell(r.months[i]), 0) + (mode === 'cleared' ? miscRow[i] : 0));
  const money = (v) => (v === 0 ? <span className="muted">—</span> : fmtMoney(v, currency));

  return (
    <section className="card">
      <h2>{title}</h2>
      <div className="table-scroll">
        <table className="table report-table">
          <thead>
            <tr>
              <th>Category</th>
              {MONTHS.map((m) => <th key={m} className="num">{m}</th>)}
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <td>
                  {r.name}
                  {accountLabel(r) && <span className="muted small"> · {accountLabel(r)}</span>}
                </td>
                {r.months.map((m, i) => <td key={i} className="num">{money(cell(m))}</td>)}
                <td className="num"><strong>{money(rowTotal(r))}</strong></td>
              </tr>
            ))}
            {mode === 'cleared' && (
              <tr>
                <td>Misc (uncategorized)</td>
                {miscRow.map((v, i) => <td key={i} className="num">{money(v)}</td>)}
                <td className="num"><strong>{money(miscTotal)}</strong></td>
              </tr>
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              {colTotals.map((v, i) => <td key={i} className="num">{money(v)}</td>)}
              <td className="num">{money(colTotals.reduce((s, v) => s + v, 0))}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

export default function Reports() {
  const { user } = useAuth();
  const { accountId } = useAccount();
  const { base: baseAccounts } = useAccounts();
  const [year, setYear] = useState(new Date().getFullYear());
  const [data, setData] = useState(null);
  const [mode, setMode] = useState('cleared');
  const [scope, setScope] = useState('all');
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    try {
      const acct = scope === 'account' ? `&account=${accountId ?? ''}` : '';
      setData(await api(`/reports/summary?year=${year}${acct}`));
    } catch (err) {
      setError(err.message);
    }
  }, [year, scope, accountId]);

  useEffect(() => { load(); }, [load]);

  if (error) return <p className="form-error">{error}</p>;
  if (!data) return <div className="page-loading">Loading…</div>;

  const years = data.years.length ? data.years : [year];
  const defaultId = baseAccounts.find((a) => a.isDefault)?.id;
  const selectedName = baseAccounts.find((a) => a.id === (accountId ?? defaultId))?.name ?? 'Selected account';
  // In the all-accounts view of a multi-account household, same-named
  // categories on different accounts need their account spelled out.
  const accountLabel = (r) => {
    if (scope !== 'all' || baseAccounts.length < 2) return null;
    return baseAccounts.find((a) => a.id === (r.accountId ?? defaultId))?.name ?? null;
  };

  return (
    <div className="reports-page">
      <div className="page-actions">
        <div className="range-picker">
          <a className="btn btn-ghost" href="/api/reports/export/transactions.csv">Export transactions CSV</a>
          <a className="btn btn-ghost" href="/api/reports/export/periods.csv">Export periods CSV</a>
        </div>
      </div>
      <div className="report-controls">
        <label>
          Year
          <select value={year} onChange={(e) => setYear(Number(e.target.value))}>
            {years.map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </label>
        <div className="range-picker" role="group" aria-label="Amount basis">
          <button className={`btn btn-ghost ${mode === 'cleared' ? 'active' : ''}`} onClick={() => setMode('cleared')}>
            Cleared (actual)
          </button>
          <button className={`btn btn-ghost ${mode === 'planned' ? 'active' : ''}`} onClick={() => setMode('planned')}>
            Planned
          </button>
        </div>
        {baseAccounts.length > 1 && (
          <div className="range-picker" role="group" aria-label="Account scope">
            <button className={`btn btn-ghost ${scope === 'all' ? 'active' : ''}`} onClick={() => setScope('all')}>
              All accounts
            </button>
            <button className={`btn btn-ghost ${scope === 'account' ? 'active' : ''}`} onClick={() => setScope('account')}>
              {selectedName}
            </button>
          </div>
        )}
      </div>
      <p className="muted small">
        Amounts are grouped by the month each pay period starts in; misc transactions by their own date.
        Planned amounts cover the whole year (projected from your categories, respecting their valid
        dates); cleared amounts exist for recorded periods, with earlier months treated as reconciled
        at plan.
      </p>
      <RollupTable
        title={`Expenses · ${data.year}`} currency={user.currency} mode={mode} accountLabel={accountLabel}
        rows={data.categories.filter((c) => c.type === 'expense')} miscRow={data.misc.expense}
      />
      <RollupTable
        title={`Income · ${data.year}`} currency={user.currency} mode={mode} accountLabel={accountLabel}
        rows={data.categories.filter((c) => c.type === 'income')} miscRow={data.misc.income}
      />
    </div>
  );
}
