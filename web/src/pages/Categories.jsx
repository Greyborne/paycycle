import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAccount, useAuth } from '../App.jsx';
import CategoryCreateDrawer from '../components/CategoryCreateDrawer.jsx';
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

export default function Categories() {
  const { user } = useAuth();
  const { accountId } = useAccount();
  const { accounts, base: baseAccounts } = useAccounts();
  const [categories, setCategories] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const [createDrawer, setCreateDrawer] = useState(null); // { seedType } | null
  const addExpenseBtnRef = useRef(null);
  const addIncomeBtnRef = useRef(null);

  const [periodStart, setPeriodStart] = useState(null);

  const load = useCallback(async () => {
    const data = await api('/categories');
    setCategories(data.categories);
  }, []);

  useEffect(() => { load(); }, [load]);

  // The page is scoped to the account selected in the top bar, like the
  // dashboard and pay-period views (a NULL category account = the default).
  const defaultId = baseAccounts.find((a) => a.isDefault)?.id ?? baseAccounts[0]?.id ?? null;
  const selectedId = baseAccounts.some((a) => a.id === accountId) ? accountId : defaultId;

  // Default "Valid from" for the create drawer is the first day of the
  // selected account's current pay period. Refetched whenever the selected
  // account changes; a fetch failure just leaves the default null (drawer
  // falls back to today).
  useEffect(() => {
    let cancelled = false;
    api(`/periods/current?account=${selectedId ?? ''}`)
      .then((d) => { if (!cancelled) setPeriodStart(d?.period?.start ?? null); })
      .catch(() => { if (!cancelled) setPeriodStart(null); });
    return () => { cancelled = true; };
  }, [selectedId]);

  if (!categories || accounts === null) return <div className="page-loading">Loading…</div>;

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

  const openCreateDrawer = (seedType, triggerRef) => setCreateDrawer({ seedType, triggerRef });

  // Return focus to whichever "+ Add category" button opened the drawer —
  // mirrors Rules.jsx's closeCreateDrawer/onRuleCreated idiom for
  // RuleCreateDrawer. The toggle inside the drawer may have switched away
  // from the seed type by the time it closes; focus still goes back to the
  // button that actually opened it.
  const closeCreateDrawer = () => {
    createDrawer?.triggerRef?.current?.focus();
    setCreateDrawer(null);
  };
  const onCategoryCreated = async () => {
    const triggerRef = createDrawer?.triggerRef;
    setCreateDrawer(null);
    await load();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (triggerRef?.current?.isConnected) triggerRef.current.focus();
    }));
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

  const section = (type, title, triggerRef) => {
    const active = categories.filter((c) => c.type === type && !c.archived && inAccount(c));
    const archived = categories.filter((c) => c.type === type && c.archived && inAccount(c));
    return (
      <section className="card">
        <div className="card-head">
          <h2>{title}</h2>
          <button
            type="button" ref={triggerRef} className="btn btn-primary"
            onClick={() => openCreateDrawer(type, triggerRef)}
          >
            + Add category
          </button>
        </div>
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
      {section('expense', 'Expenses', addExpenseBtnRef)}
      {section('income', 'Income', addIncomeBtnRef)}
      {createDrawer && (
        <CategoryCreateDrawer
          seedType={createDrawer.seedType}
          accountId={selectedId === defaultId ? null : selectedId}
          accountName={baseAccounts.length > 1 ? baseAccounts.find((a) => a.id === selectedId)?.name : undefined}
          defaultValidFrom={periodStart}
          onClose={closeCreateDrawer}
          onCreated={onCategoryCreated}
        />
      )}
    </div>
  );
}
