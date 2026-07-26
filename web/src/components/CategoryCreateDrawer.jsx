import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { parseMoney, todayISO } from '../format.js';

// Side drawer to author a NEW category for the focused (selected) account,
// opened from either card's "+ Add category" button on the Categories page.
// Mirrors TransactionDrawer.jsx / RuleCreateDrawer.jsx's outer-dialog/inner-
// form structure and focus-trap/Escape/return-focus idiom. Per
// CONSTITUTION.md §8 2026-07-26 "Manual add moves to account-locked
// drawers": the drawer is account-locked — `accountId` is the same value the
// old inline AddForm received (null when the selected account is the
// default), and the category is created in that account only. The
// Expense⇄Income toggle is seeded by which card's button was clicked but is
// switchable inside the drawer without closing it.

const FOCUSABLE = 'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function CategoryCreateDrawer({ seedType, accountId, accountName, defaultValidFrom, onClose, onCreated }) {
  const [type, setType] = useState(seedType);
  const [name, setName] = useState('');
  const [amount, setAmount] = useState('');
  const [recurrence, setRecurrence] = useState('every_period');
  const [dueDay, setDueDay] = useState(1);
  const [validFrom, setValidFrom] = useState(defaultValidFrom ?? todayISO());
  const [validFromTouched, setValidFromTouched] = useState(false);
  const [validUntil, setValidUntil] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const drawerRef = useRef(null);
  const headingRef = useRef(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // `defaultValidFrom` (the selected account's current pay-period start) may
  // arrive asynchronously, after this component's first render. Adopt it
  // once it becomes available, but never clobber a value the user already
  // edited by hand.
  useEffect(() => {
    if (defaultValidFrom && !validFromTouched) setValidFrom(defaultValidFrom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [defaultValidFrom]);

  const requestClose = () => { if (!busy) onClose(); };

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        requestClose();
        return;
      }
      if (e.key !== 'Tab' || !drawerRef.current) return;
      const list = Array.from(drawerRef.current.querySelectorAll(FOCUSABLE));
      if (list.length === 0) return;
      const first = list[0];
      const last = list[list.length - 1];
      const isTracked = list.includes(document.activeElement);
      if (e.shiftKey) {
        if (!isTracked || document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else if (!isTracked || document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const submit = async (e) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
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
          startDate: recurrence === 'tag' ? undefined : (validFrom || undefined),
          endDate: recurrence === 'tag' ? undefined : (validUntil || undefined),
          // New categories belong to the account being viewed — same
          // account-lock the old inline AddForm used.
          accountId: accountId ?? undefined,
        },
      });
      onCreated();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop rule-drawer-backdrop" onClick={requestClose}>
      <div
        className="rule-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="category-create-drawer-title"
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rule-drawer-head">
          <h2 id="category-create-drawer-title" ref={headingRef} tabIndex={-1}>
            Add category{accountName ? ` — ${accountName}` : ''}
          </h2>
          <button
            type="button" className="btn btn-ghost btn-small rule-drawer-close"
            onClick={requestClose} disabled={busy} aria-label="Close"
          >
            ×
          </button>
        </div>

        <form className="txn-drawer-form" onSubmit={submit}>
          <div className="range-picker" role="group" aria-label="Category type">
            <button
              type="button" className={`btn btn-ghost ${type === 'expense' ? 'active' : ''}`}
              aria-pressed={type === 'expense'} onClick={() => setType('expense')}
            >
              Expense
            </button>
            <button
              type="button" className={`btn btn-ghost ${type === 'income' ? 'active' : ''}`}
              aria-pressed={type === 'income'} onClick={() => setType('income')}
            >
              Income
            </button>
          </div>

          <label>
            Name
            <input
              value={name} onChange={(e) => setName(e.target.value)}
              placeholder={`New ${type} category`} aria-label="Name" required
            />
          </label>

          <label>
            Repeats
            <select
              value={recurrence} onChange={(e) => setRecurrence(e.target.value)} aria-label="Repeats"
              title="Recurring categories plan an amount every period; tags just label one-off spending"
            >
              <option value="every_period">Every period</option>
              <option value="monthly">Monthly</option>
              <option value="tag">Tag (one-off)</option>
            </select>
          </label>

          {recurrence === 'monthly' && (
            <label>
              Due day
              <input
                type="number" min="1" max="31" value={dueDay} aria-label="Due day"
                onChange={(e) => setDueDay(e.target.value)}
              />
            </label>
          )}

          {recurrence !== 'tag' && (
            <label>
              Amount
              <input
                value={amount} onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal" placeholder="0.00" aria-label="Amount"
              />
            </label>
          )}

          {recurrence !== 'tag' && (
            <label title="Valid from — the first date this category applies">
              Valid from
              <input
                type="date" value={validFrom}
                aria-label="Valid from — the first date this category applies"
                onChange={(e) => { setValidFromTouched(true); setValidFrom(e.target.value); }}
              />
            </label>
          )}

          {recurrence !== 'tag' && (
            <label title="Valid until — the last date this category applies (blank = ongoing)">
              Valid until
              <input
                type="date" value={validUntil}
                aria-label="Valid until — the last date this category applies (blank = ongoing)"
                onChange={(e) => setValidUntil(e.target.value)}
              />
            </label>
          )}

          {error && <p className="form-error" role="alert">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!name.trim() || busy}>
              {busy ? 'Saving…' : 'Add category'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
