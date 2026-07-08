import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAccount, useAuth } from '../App.jsx';
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

function CategoryRow({ cat, currency, onChanged, onMove, isFirst, isLast }) {
  const [editingAmount, setEditingAmount] = useState(false);
  const [name, setName] = useState(cat.name);
  const isTag = cat.categoryType === 'tag';

  const patch = async (body) => {
    await api(`/categories/${cat.id}`, { method: 'PATCH', body });
    onChanged();
  };

  return (
    <div className={`category-row ${cat.archived ? 'archived' : ''}`}>
      <div className="category-grid">
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
          value={isTag ? 'tag' : cat.recurrence}
          disabled={cat.archived}
          aria-label="Repeats"
          className={isTag ? 'select-tag' : ''}
          title={isTag ? 'Tags label one-off spending — no planned amount, no projection impact' : undefined}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'tag') patch({ categoryType: 'tag' });
            else patch({ categoryType: 'recurring', recurrence: v, dueDay: v === 'monthly' ? (cat.dueDay || 1) : undefined });
          }}
        >
          <option value="every_period">Every period</option>
          <option value="monthly">Monthly</option>
          <option value="tag">Tag (one-off)</option>
        </select>
        {!isTag && cat.recurrence === 'monthly' ? (
          <input
            type="number" min="1" max="31" defaultValue={cat.dueDay} className="due-day" title="Due day of month"
            aria-label="Due day"
            disabled={cat.archived}
            onBlur={(e) => { const d = Number(e.target.value); if (d >= 1 && d <= 31 && d !== cat.dueDay) patch({ dueDay: d }); }}
          />
        ) : <span className="muted small">—</span>}
        {isTag ? <span className="muted small">—</span> : (
          <input
            type="date" className="valid-date" value={cat.startDate ?? ''} disabled={cat.archived}
            title="Valid from — the first date this category applies (blank = always)"
            aria-label="Valid from"
            onChange={(e) => patch({ startDate: e.target.value || null })}
          />
        )}
        <span className="muted small" aria-hidden="true">{isTag ? '' : '→'}</span>
        {isTag ? <span className="muted small">—</span> : (
          <input
            type="date" className="valid-date" value={cat.endDate ?? ''} disabled={cat.archived}
            title="Valid until — the last date this category applies (blank = ongoing)"
            aria-label="Valid until"
            onChange={(e) => patch({ endDate: e.target.value || null })}
          />
        )}
        {isTag ? <span className="muted small">—</span> : (
          <button
            className="cell-amount editable" disabled={cat.archived}
            title="Record a new amount effective from a date"
            onClick={() => setEditingAmount(!editingAmount)}
          >
            {fmtMoney(cat.currentAmountCents, currency)}
          </button>
        )}
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

function AddForm({ type, onAdded, accountId }) {
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
          name,
          type,
          categoryType: recurrence === 'tag' ? 'tag' : 'recurring',
          recurrence: recurrence === 'tag' ? undefined : recurrence,
          dueDay: recurrence === 'monthly' ? Number(dueDay) : undefined,
          amountCents: recurrence === 'tag' ? 0 : (parseMoney(amount) ?? 0),
          // New categories belong to the account being viewed.
          accountId: accountId ?? undefined,
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
      <select value={recurrence} onChange={(e) => setRecurrence(e.target.value)} title="Recurring categories plan an amount every period; tags just label one-off spending">
        <option value="every_period">Every period</option>
        <option value="monthly">Monthly</option>
        <option value="tag">Tag (one-off)</option>
      </select>
      {recurrence === 'monthly' && (
        <input type="number" min="1" max="31" value={dueDay} onChange={(e) => setDueDay(e.target.value)} title="Due day" />
      )}
      {recurrence !== 'tag' && (
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" placeholder="Amount" />
      )}
      <button className="btn btn-primary">Add</button>
      {error && <span className="form-error">{error}</span>}
    </form>
  );
}

export default function Categories() {
  const { user } = useAuth();
  const { accountId } = useAccount();
  const { accounts, base: baseAccounts } = useAccounts();
  const [categories, setCategories] = useState(null);
  const [showArchived, setShowArchived] = useState(false);

  const load = useCallback(async () => {
    const data = await api('/categories');
    setCategories(data.categories);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!categories || accounts === null) return <div className="page-loading">Loading…</div>;

  // The page is scoped to the account selected in the top bar, like the
  // dashboard and pay-period views (a NULL category account = the default).
  const defaultId = baseAccounts.find((a) => a.isDefault)?.id ?? baseAccounts[0]?.id ?? null;
  const selectedId = baseAccounts.some((a) => a.id === accountId) ? accountId : defaultId;
  const inAccount = (c) => (c.accountId ?? defaultId) === selectedId;

  const move = async (cat, dir) => {
    const list = categories.filter((c) => c.type === cat.type && !c.archived && inAccount(c));
    const i = list.findIndex((c) => c.id === cat.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((c) => c.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('/categories/reorder', { method: 'POST', body: { type: cat.type, ids } });
    load();
  };

  const gridHead = (
    <div className="category-grid category-grid-head" aria-hidden="true">
      <span />
      <span>Category</span>
      <span>Repeats</span>
      <span>Due</span>
      <span>Valid from</span>
      <span />
      <span>Valid until</span>
      <span className="head-num">Amount</span>
      <span />
    </div>
  );

  const section = (type, title) => {
    const active = categories.filter((c) => c.type === type && !c.archived && inAccount(c));
    const archived = categories.filter((c) => c.type === type && c.archived && inAccount(c));
    return (
      <section className="card">
        <h2>{title}</h2>
        <div className="category-scroll">
          {gridHead}
          {active.map((c, i) => (
            <CategoryRow
              key={c.id} cat={c} currency={user.currency} onChanged={load} onMove={move}
              isFirst={i === 0} isLast={i === active.length - 1}
            />
          ))}
          {showArchived && archived.map((c) => (
            <CategoryRow
              key={c.id} cat={c} currency={user.currency} onChanged={load} onMove={move}
              isFirst isLast
            />
          ))}
        </div>
        <AddForm type={type} onAdded={load} accountId={selectedId === defaultId ? null : selectedId} />
      </section>
    );
  };

  return (
    <div className="categories-page">
      <div className="page-actions">
        <label className="muted small toggle-archived">
          <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          Show archived
        </label>
      </div>
      <p className="muted">
        These templates drive every pay period and the whole forward projection. Changing an amount
        records it as “effective from a date” — history stays intact and the future recalculates.
        {baseAccounts.length > 1 && ' Showing the account selected in the top bar; new categories are created in it.'}
      </p>
      {section('expense', 'Expenses')}
      {section('income', 'Income')}
    </div>
  );
}
