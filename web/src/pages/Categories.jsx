import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { centsToInput, fmtDate, fmtMoney, parseMoney, todayISO } from '../format.js';
import { useAccounts } from '../useAccounts.js';

function AmountEditor({ category, onDone }) {
  const [amount, setAmount] = useState(centsToInput(category.currentAmountCents));
  const [effective, setEffective] = useState(todayISO());
  const [error, setError] = useState(null);

  const save = async () => {
    const cents = parseMoney(amount);
    if (cents === null) { setError('Enter a valid amount'); return; }
    try {
      await api(`/categories/${category.id}/amounts`, {
        method: 'POST',
        body: { amountCents: cents, effectiveStartDate: effective },
      });
      onDone(true);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="amount-editor">
      <label>
        New amount
        <input type="text" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} autoFocus />
      </label>
      <label>
        Effective from
        <input type="date" value={effective} onChange={(e) => setEffective(e.target.value)} />
      </label>
      <div className="muted small">
        Past periods keep their recorded amounts; every projected period from this date forward
        recalculates automatically.
      </div>
      {error && <span className="form-error">{error}</span>}
      <div className="editor-actions">
        <button className="btn btn-ghost" onClick={() => onDone(false)}>Cancel</button>
        <button className="btn btn-primary" onClick={save}>Save</button>
      </div>
    </div>
  );
}

function CategoryRow({ cat, currency, onChanged, onMove, isFirst, isLast, accounts }) {
  const [editingAmount, setEditingAmount] = useState(false);
  const [name, setName] = useState(cat.name);

  const patch = async (body) => {
    await api(`/categories/${cat.id}`, { method: 'PATCH', body });
    onChanged();
  };

  return (
    <div className={`category-row ${cat.archived ? 'archived' : ''}`}>
      <div className="category-main">
        <div className="reorder">
          <button className="btn btn-ghost btn-small" disabled={isFirst || cat.archived} onClick={() => onMove(cat, -1)} aria-label="Move up">↑</button>
          <button className="btn btn-ghost btn-small" disabled={isLast || cat.archived} onClick={() => onMove(cat, 1)} aria-label="Move down">↓</button>
        </div>
        <input
          className="category-name" value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => { if (name.trim() && name !== cat.name) patch({ name }); else setName(cat.name); }}
          disabled={cat.archived}
        />
        <select
          value={cat.recurrence}
          disabled={cat.archived}
          onChange={(e) => patch({ recurrence: e.target.value, dueDay: e.target.value === 'monthly' ? (cat.dueDay || 1) : undefined })}
        >
          <option value="every_period">Every period</option>
          <option value="monthly">Monthly</option>
        </select>
        {cat.recurrence === 'monthly' && (
          <input
            type="number" min="1" max="31" defaultValue={cat.dueDay} className="due-day" title="Due day of month"
            disabled={cat.archived}
            onBlur={(e) => { const d = Number(e.target.value); if (d >= 1 && d <= 31 && d !== cat.dueDay) patch({ dueDay: d }); }}
          />
        )}
        {accounts.length > 1 && (
          <select
            value={cat.accountId ?? ''} disabled={cat.archived} title="Account this clears from/to"
            onChange={(e) => patch({ accountId: e.target.value ? Number(e.target.value) : null })}
          >
            <option value="">Default account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
        <button
          className="cell-amount editable" disabled={cat.archived}
          title="Record a new amount effective from a date"
          onClick={() => setEditingAmount(!editingAmount)}
        >
          {fmtMoney(cat.currentAmountCents, currency)}
        </button>
        <button className="btn btn-ghost btn-small" onClick={() => patch({ archived: !cat.archived })}>
          {cat.archived ? 'Restore' : 'Archive'}
        </button>
      </div>
      {editingAmount && (
        <AmountEditor category={cat} onDone={(saved) => { setEditingAmount(false); if (saved) onChanged(); }} />
      )}
      {cat.history.length > 1 && (
        <details className="history">
          <summary className="muted small">Amount history ({cat.history.length})</summary>
          <ul>
            {cat.history.map((h) => (
              <li key={h.id} className="small">
                {fmtMoney(h.amountCents, currency)} effective {fmtDate(h.effectiveStartDate)}
                <button
                  className="btn btn-ghost btn-small"
                  onClick={async () => { await api(`/categories/${cat.id}/amounts/${h.id}`, { method: 'DELETE' }); onChanged(); }}
                  aria-label="Delete amount entry"
                >
                  ✕
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

function AddForm({ type, onAdded }) {
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [recurrence, setRecurrence] = useState('every_period');
  const [dueDay, setDueDay] = useState(1);
  const [error, setError] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('/categories', {
        method: 'POST',
        body: {
          name, type, recurrence,
          dueDay: recurrence === 'monthly' ? Number(dueDay) : undefined,
          amountCents: parseMoney(amount) ?? 0,
        },
      });
      setName(''); setAmount('');
      setError(null);
      onAdded();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <form className="quick-add" onSubmit={submit}>
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder={`New ${type} category`} required />
      <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)}>
        <option value="every_period">Every period</option>
        <option value="monthly">Monthly</option>
      </select>
      {recurrence === 'monthly' && (
        <input type="number" min="1" max="31" value={dueDay} onChange={(e) => setDueDay(e.target.value)} title="Due day" />
      )}
      <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Amount" />
      <button className="btn btn-primary">Add</button>
      {error && <span className="form-error">{error}</span>}
    </form>
  );
}

export default function Categories() {
  const { user } = useAuth();
  const { active: activeAccounts } = useAccounts();
  const [categories, setCategories] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    const data = await api('/categories');
    setCategories(data.categories);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!categories) return <div className="page-loading">Loading…</div>;

  const move = async (cat, dir) => {
    const list = categories.filter((c) => c.type === cat.type && !c.archived);
    const i = list.findIndex((c) => c.id === cat.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((c) => c.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('/categories/reorder', { method: 'POST', body: { type: cat.type, ids } });
    load();
  };

  const section = (type, title) => {
    const active = categories.filter((c) => c.type === type && !c.archived);
    const archived = categories.filter((c) => c.type === type && c.archived);
    return (
      <section className="card">
        <h2>{title}</h2>
        {active.map((c, i) => (
          <CategoryRow
            key={c.id} cat={c} currency={user.currency} onChanged={load} onMove={move}
            isFirst={i === 0} isLast={i === active.length - 1} accounts={activeAccounts}
          />
        ))}
        <AddForm type={type} onAdded={load} />
        {showArchived && archived.map((c) => (
          <CategoryRow
            key={c.id} cat={c} currency={user.currency} onChanged={load} onMove={move}
            isFirst isLast accounts={activeAccounts}
          />
        ))}
      </section>
    );
  };

  return (
    <div className="categories-page">
      <div className="card-head">
        <h1>Categories</h1>
        <label className="muted small toggle-archived">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
      <p className="muted">
        These templates drive every pay period and the whole forward projection. Changing an amount
        records it as “effective from a date” — history stays intact and the future recalculates.
      </p>
      {section('expense', 'Expenses')}
      {section('income', 'Income')}
    </div>
  );
}
