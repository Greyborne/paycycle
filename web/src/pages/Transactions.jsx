import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { fmtDate, fmtMoney } from '../format.js';
import { useAccounts } from '../useAccounts.js';
import DriftNotices from '../components/DriftNotices.jsx';

function CategorySelect({ value, categories, onChange, disabled, ariaLabel }) {
  const group = (type, categoryType) => categories
    .filter((c) => !c.archived && c.type === type && c.categoryType === categoryType);
  const renderOptions = (list) => list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>);
  return (
    <select
      value={value ?? ''} disabled={disabled} aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value ? Number(e.target.value) : null)}
    >
      <option value="">Uncategorized</option>
      <optgroup label="Bills & income (recurring)">
        {renderOptions(group('expense', 'recurring'))}
        {renderOptions(group('income', 'recurring'))}
      </optgroup>
      <optgroup label="Tags (one-off)">
        {renderOptions(group('expense', 'tag'))}
        {renderOptions(group('income', 'tag'))}
      </optgroup>
    </select>
  );
}

const SORTS = {
  date: (t) => t.date,
  description: (t) => (t.description || '').toLowerCase(),
  category: (t) => (t.category_name || '').toLowerCase(),
  amount: (t) => (t.type === 'expense' ? -t.amount_cents : t.amount_cents),
  account: (t) => (t.account_name || '').toLowerCase(),
};

export default function Transactions() {
  const { user } = useAuth();
  const { active: accounts } = useAccounts();
  const [txns, setTxns] = useState(null);
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({ from: '', to: '', account: '', category: '', search: '' });
  const [sort, setSort] = useState({ key: 'date', dir: -1 });
  const [selected, setSelected] = useState(new Set());
  const [bulkCategory, setBulkCategory] = useState(null);
  const [drift, setDrift] = useState([]);
  const [notice, setNotice] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(filters)) if (v) qs.set(k, v);
      const [data, cats] = await Promise.all([
        api(`/transactions?${qs}`),
        api('/categories'),
      ]);
      setTxns(data.transactions);
      setCategories(cats.categories);
      setSelected(new Set());
    } catch (err) {
      setError(err.message);
    }
  }, [filters]);

  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => {
    if (!txns) return null;
    const get = SORTS[sort.key];
    return [...txns].sort((a, b) => {
      const va = get(a);
      const vb = get(b);
      return (va < vb ? -1 : va > vb ? 1 : 0) * sort.dir;
    });
  }, [txns, sort]);

  if (error) return <p className="form-error">{error}</p>;
  if (!sorted) return <div className="page-loading">Loading…</div>;

  const clickSort = (key) => setSort((s) => ({ key, dir: s.key === key ? -s.dir : key === 'date' ? -1 : 1 }));
  const arrow = (key) => (sort.key === key ? (sort.dir > 0 ? ' ↑' : ' ↓') : '');

  const assign = async (ids, categoryId) => {
    try {
      const res = await api('/transactions/assign', { method: 'PATCH', body: { ids, categoryId } });
      if (res.drift?.length) setDrift((d) => [...d, ...res.drift]);
      load();
    } catch (err) {
      setError(err.message);
    }
  };

  const bulkDelete = async () => {
    if (!window.confirm(`Delete ${selected.size} transaction(s)? This cannot be undone.`)) return;
    const res = await api('/transactions/bulk-delete', { method: 'POST', body: { ids: [...selected] } });
    setNotice(`Deleted ${res.deleted}${res.skippedClosed ? ` · ${res.skippedClosed} in closed periods skipped` : ''}`);
    load();
  };

  const rerunRules = async () => {
    setNotice(null);
    const res = await api('/transactions/recategorize', { method: 'POST' });
    setNotice(`Rules matched ${res.matched} of ${res.examined} uncategorized transaction(s)${res.skippedClosed ? ` · ${res.skippedClosed} in closed periods skipped` : ''}`);
    if (res.drift?.length) setDrift((d) => [...d, ...res.drift]);
    load();
  };

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };
  const allSelected = sorted.length > 0 && sorted.every((t) => selected.has(t.id));

  const setFilter = (k, v) => setFilters((f) => ({ ...f, [k]: v }));
  const provenance = (t) => {
    if (!t.category_template_id) return ['uncat', 'needs review'];
    if (t.categorized_by === 'rule') return ['auto', 'auto-matched'];
    return ['manual', 'manual'];
  };

  return (
    <div className="transactions-page">
      <div className="page-actions">
        <button className="btn" onClick={rerunRules} title="Apply categorization rules to uncategorized transactions (manual assignments are never touched)">
          Re-run rules on uncategorized
        </button>
        <Link className="btn btn-ghost" to="/rules">Edit rules</Link>
      </div>

      <DriftNotices notices={drift} onChanged={load} />
      {notice && <p className="form-ok">{notice}</p>}

      <section className="card">
        <div className="report-controls">
          <label>From
            <input type="date" value={filters.from} onChange={(e) => setFilter('from', e.target.value)} />
          </label>
          <label>To
            <input type="date" value={filters.to} onChange={(e) => setFilter('to', e.target.value)} />
          </label>
          <label>Account
            <select value={filters.account} onChange={(e) => setFilter('account', e.target.value)}>
              <option value="">All</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </label>
          <label>Category
            <select value={filters.category} onChange={(e) => setFilter('category', e.target.value)}>
              <option value="">All</option>
              <option value="none">Uncategorized</option>
              {categories.filter((c) => !c.archived).map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.categoryType === 'tag' ? ' (tag)' : ''}</option>
              ))}
            </select>
          </label>
          <label>Search
            <input
              type="text" value={filters.search} placeholder="Description…"
              onChange={(e) => setFilter('search', e.target.value)}
            />
          </label>
        </div>

        {selected.size > 0 && (
          <div className="bulk-bar">
            <span className="small"><strong>{selected.size}</strong> selected</span>
            <CategorySelect
              value={bulkCategory} categories={categories} ariaLabel="Bulk category"
              onChange={setBulkCategory}
            />
            <button className="btn" onClick={() => assign([...selected], bulkCategory)}>Assign</button>
            <button className="btn btn-ghost" onClick={bulkDelete}>Delete</button>
          </div>
        )}

        <div className="table-scroll">
          <table className="table txn-table">
            <thead>
              <tr>
                <th>
                  <input
                    type="checkbox" checked={allSelected} aria-label="Select all"
                    onChange={() => setSelected(allSelected ? new Set() : new Set(sorted.map((t) => t.id)))}
                  />
                </th>
                <th className="sortable" onClick={() => clickSort('date')}>Date{arrow('date')}</th>
                <th className="sortable" onClick={() => clickSort('description')}>Description{arrow('description')}</th>
                <th className="sortable" onClick={() => clickSort('category')}>Category{arrow('category')}</th>
                <th className="sortable num" onClick={() => clickSort('amount')}>Amount{arrow('amount')}</th>
                <th className="sortable" onClick={() => clickSort('account')}>Account{arrow('account')}</th>
                <th>Period</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr><td colSpan={8} className="muted">No transactions match these filters.</td></tr>
              )}
              {sorted.map((t) => {
                const [provClass, provLabel] = provenance(t);
                return (
                  <tr key={t.id} className={t.category_template_id ? '' : 'txn-uncat'}>
                    <td>
                      <input
                        type="checkbox" checked={selected.has(t.id)} aria-label="Select row"
                        onChange={() => toggle(t.id)}
                      />
                    </td>
                    <td className="nowrap">{fmtDate(t.date)}</td>
                    <td>{t.description || <span className="muted">—</span>}</td>
                    <td>
                      <CategorySelect
                        value={t.category_template_id} categories={categories}
                        ariaLabel={`Category for ${t.description || 'transaction'}`}
                        onChange={(categoryId) => assign([t.id], categoryId)}
                      />
                    </td>
                    <td className={`num nowrap ${t.type === 'expense' ? 'amount-neg' : ''}`}>
                      {t.type === 'expense' ? '−' : ''}{fmtMoney(t.amount_cents, t.account_currency || user.currency)}
                    </td>
                    <td>{t.account_name || <span className="muted">—</span>}</td>
                    <td className="nowrap">
                      {t.period_start && (
                        <Link to={`/period/${t.period_start}`} className="small">
                          {fmtDate(t.period_start, { month: 'short', day: 'numeric' })}
                          {t.line_item_cleared && t.category_type === 'recurring' && (
                            <span title="Cleared this period's line item"> ✓</span>
                          )}
                        </Link>
                      )}
                    </td>
                    <td><span className={`badge txn-prov-${provClass}`}>{provLabel}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="muted small">
          Showing {sorted.length} transaction(s){sorted.length === 1000 ? ' (capped at 1000 — narrow the filters)' : ''}.
          Assigning a recurring category clears that period's line item; tags just label one-off spending.
        </p>
      </section>
    </div>
  );
}
