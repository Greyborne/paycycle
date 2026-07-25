import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { parseMoney, todayISO } from '../format.js';

// Add-transaction side drawer for the period page's Misc transactions
// section. Dialog mechanics (backdrop, focus trap, Escape-to-close) copied
// faithfully from RuleDrawer.jsx; form fields and submit behavior reproduce
// QuickAddTransaction.jsx exactly. Always opened with a fixedAccountId (the
// period column's own account), so there is no account picker here.

// Same focus-trap approach as RuleDrawer.jsx's FOCUSABLE: `summary` has no
// tabindex of its own but is natively focusable, so it must be tracked as an
// ordinary mid-sequence stop — otherwise the boundary-wrap logic below (which
// treats "focus landed somewhere untracked" as having hit an edge) misfires.
const FOCUSABLE = 'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function TransactionDrawer({ onAdded, onClose, defaultDate, fixedAccountId, tags = [] }) {
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('expense');
  const [tagId, setTagId] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(defaultDate || todayISO());
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const drawerRef = useRef(null);
  const headingRef = useRef(null);

  // Move focus into the drawer on open.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  const requestClose = () => { if (!busy) onClose(); };

  // Escape closes; Tab/Shift-Tab is trapped inside the drawer.
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
      // The initially-focused heading has tabindex="-1" so it's deliberately
      // NOT in `list` (it isn't part of the normal Tab order) — but that also
      // means it isn't `first`/`last`, so it must be treated as an implicit
      // boundary too: any active element that isn't one of our tracked
      // focusables (the heading, or focus that's somehow escaped already)
      // wraps just like being on the first/last one would.
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

  // Choosing a tag sets the transaction's type from the tag (income/expense).
  const chooseTag = (id) => {
    setTagId(id);
    const tag = tags.find((t) => String(t.id) === id);
    if (tag) setType(tag.type);
  };

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
          type: cents < 0 ? undefined : type,
          description,
          date,
          accountId: fixedAccountId ?? undefined,
          categoryTemplateId: tagId ? Number(tagId) : undefined,
        },
      });
      setAmount('');
      setDescription('');
      setTagId('');
      onAdded?.();
      onClose();
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
        aria-labelledby="txn-drawer-title"
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rule-drawer-head">
          <h2 id="txn-drawer-title" ref={headingRef} tabIndex={-1}>Add transaction</h2>
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
              type="text" inputMode="decimal" value={amount} aria-label="Amount"
              onChange={(e) => setAmount(e.target.value)}
            />
          </label>
          <label>
            Type
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type" disabled={Boolean(tagId)}>
              <option value="expense">Expense</option>
              <option value="income">Income</option>
            </select>
          </label>
          {tags.length > 0 && (
            <label>
              Tag
              <select value={tagId} onChange={(e) => chooseTag(e.target.value)} aria-label="Tag" title="Optional tag">
                <option value="">No tag</option>
                {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
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
              type="text" placeholder="Description (optional)" value={description} aria-label="Description"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {error && <p className="form-error" role="alert">{error}</p>}

          <div className="modal-actions">
            <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={busy}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={busy}>Add</button>
          </div>
        </form>
      </div>
    </div>
  );
}
