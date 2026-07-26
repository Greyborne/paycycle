import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { parseMoney, todayISO } from '../format.js';

// Side drawer to author a NEW transaction of any kind (recurring category,
// tag, or misc/uncategorized) for the focused (selected) account, opened from
// the "+ Add transaction" button on the Transactions page. Mirrors
// CategoryCreateDrawer.jsx / RuleCreateDrawer.jsx's outer-dialog/inner-form
// structure and focus-trap/Escape/return-focus idiom. Per CONSTITUTION.md §8
// 2026-07-26 "Manual add moves to account-locked drawers" and the same day's
// Transactions entry: the drawer is account-locked to the page's focused
// account — `accountId` fixes the transaction to that account, and
// `categories` MUST already be filtered by the caller to that account's own
// categories (categoriesForAccount). Choosing a recurring category records
// the actual and clears that bill's line item via the server's assignCategory
// path (POST /transactions); choosing a tag or nothing behaves like the
// existing quick-add.

const FOCUSABLE = 'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function TransactionCreateDrawer({ categories, accountId, accountName, onClose, onCreated }) {
  const [amount, setAmount] = useState('');
  const [categoryTemplateId, setCategoryTemplateId] = useState('');
  const [type, setType] = useState('expense');
  const [date, setDate] = useState(todayISO());
  const [description, setDescription] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const drawerRef = useRef(null);
  const headingRef = useRef(null);

  useEffect(() => {
    headingRef.current?.focus();
  }, []);

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

  const recurring = categories.filter((c) => c.categoryType === 'recurring');
  const tags = categories.filter((c) => c.categoryType === 'tag');

  const submit = async (e) => {
    e.preventDefault();
    const cents = parseMoney(amount);
    if (cents === null || cents === 0) {
      setError('Enter a non-zero amount');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api('/transactions', {
        method: 'POST',
        body: {
          amountCents: cents,
          // A chosen category (recurring or tag) decides the type
          // server-side; for misc, mirror QuickAddTransaction's convention —
          // a negative amount flips to expense on its own, otherwise send the
          // toggled type.
          type: categoryTemplateId || cents < 0 ? undefined : type,
          description,
          date,
          accountId: accountId ?? undefined,
          categoryTemplateId: categoryTemplateId ? Number(categoryTemplateId) : undefined,
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
        aria-labelledby="transaction-create-drawer-title"
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rule-drawer-head">
          <h2 id="transaction-create-drawer-title" ref={headingRef} tabIndex={-1}>
            Add transaction{accountName ? ` — ${accountName}` : ''}
          </h2>
          <button
            type="button" className="btn btn-ghost btn-small rule-drawer-close"
            onClick={requestClose} disabled={busy} aria-label="Close"
          >
            ×
          </button>
        </div>

        <form className="txn-drawer-form" onSubmit={submit}>
          <label>
            Amount
            <input
              value={amount} onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal" placeholder="0.00" aria-label="Amount" required
            />
          </label>

          <label>
            Category
            <select
              value={categoryTemplateId} aria-label="Category"
              onChange={(e) => setCategoryTemplateId(e.target.value)}
            >
              <option value="">None (misc / unplanned)</option>
              {recurring.length > 0 && (
                <optgroup label="Bills & income (recurring)">
                  {recurring.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
              {tags.length > 0 && (
                <optgroup label="Tags (one-off)">
                  {tags.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>

          {!categoryTemplateId && (
            <label>
              Type
              <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
                <option value="expense">Expense</option>
                <option value="income">Income</option>
              </select>
            </label>
          )}

          <label>
            Date
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
          </label>

          <label>
            Description
            <input
              type="text" value={description} onChange={(e) => setDescription(e.target.value)}
              aria-label="Description" placeholder="Optional"
            />
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!amount || busy}>
              {busy ? 'Saving…' : 'Add transaction'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
