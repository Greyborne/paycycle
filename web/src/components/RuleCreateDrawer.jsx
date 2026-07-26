import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { parseMoney } from '../format.js';

// Side drawer to author a NEW rule for the focused (selected) account, opened
// from the "+ Add rule" button on the Rules page's selected-account group
// header. Mirrors RuleDrawer.jsx's focus-trap/Escape/return-focus idiom, but
// has no source transaction to prefill from and — per CONSTITUTION.md §8
// 2026-07-26 "Categorization rules are account-scoped through their
// category" — its `categories` prop MUST already be filtered by the caller
// to the focused account's own categories (the account-lock: authoring is
// only ever possible for the focused account).

const TEXT_FIELDS = [
  ['descriptionContains', 'Description contains'],
  ['accountContains', 'Account contains'],
  ['institutionContains', 'Institution contains'],
  ['accountNumberContains', 'Acct # contains'],
];
const AMOUNT_FIELDS = [
  ['amountMinCents', 'Amount min'],
  ['amountMaxCents', 'Amount max'],
  ['amountEqualsCents', 'Amount equals'],
];

const EMPTY = {
  categoryTemplateId: '', descriptionContains: '', accountContains: '', institutionContains: '',
  accountNumberContains: '', amountMinCents: '', amountMaxCents: '', amountEqualsCents: '',
  amountContains: '', notes: '',
};

// Dollars-in-the-input, cents-on-the-wire — same convention as Rules.jsx /
// RuleDrawer.jsx.
function fieldsForApi(state) {
  const out = { ...state };
  for (const [k] of AMOUNT_FIELDS) out[k] = state[k] === '' ? null : parseMoney(String(state[k]));
  return out;
}

// See RuleDrawer.jsx for why `summary` must be tracked as an ordinary
// mid-sequence focusable — kept for parity even though this drawer has none.
const FOCUSABLE = 'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function RuleCreateDrawer({ categories, accountName, onClose, onCreated }) {
  const [state, setState] = useState({ ...EMPTY, categoryTemplateId: categories[0]?.id ?? '' });
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

  const set = (k, v) => setState((s) => ({ ...s, [k]: v }));

  const submit = async () => {
    if (!state.categoryTemplateId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/rules', { method: 'POST', body: fieldsForApi(state) });
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
        aria-labelledby="rule-create-drawer-title"
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rule-drawer-head">
          <h2 id="rule-create-drawer-title" ref={headingRef} tabIndex={-1}>
            Add rule{accountName ? ` — ${accountName}` : ''}
          </h2>
          <button
            type="button" className="btn btn-ghost btn-small rule-drawer-close"
            onClick={requestClose} disabled={busy} aria-label="Close"
          >
            ×
          </button>
        </div>

        <label>
          Category
          <select
            value={state.categoryTemplateId}
            onChange={(e) => set('categoryTemplateId', e.target.value ? Number(e.target.value) : '')}
          >
            <option value="">Choose a category…</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}{c.categoryType === 'tag' ? ' (tag)' : ''}</option>
            ))}
          </select>
        </label>
        {categories.length === 0 && (
          <p className="muted small">This account has no categories yet — add one on the Categories page first.</p>
        )}

        <label>
          {TEXT_FIELDS[0][1]}
          <input type="text" value={state.descriptionContains} onChange={(e) => set('descriptionContains', e.target.value)} />
        </label>

        <details className="rule-drawer-more">
          <summary>More conditions</summary>
          {TEXT_FIELDS.slice(1).map(([k, label]) => (
            <label key={k}>
              {label}
              <input type="text" value={state[k]} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          {AMOUNT_FIELDS.map(([k, label]) => (
            <label key={k}>
              {label}
              <input type="text" inputMode="decimal" value={state[k]} onChange={(e) => set(k, e.target.value)} />
            </label>
          ))}
          <label>
            Amount contains
            <input type="text" value={state.amountContains} onChange={(e) => set('amountContains', e.target.value)} />
          </label>
          <label>
            Notes
            <input type="text" value={state.notes} onChange={(e) => set('notes', e.target.value)} />
          </label>
        </details>

        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={busy}>Cancel</button>
          <button
            type="button" className="btn btn-primary"
            onClick={submit} disabled={!state.categoryTemplateId || busy}
          >
            {busy ? 'Saving…' : 'Add rule'}
          </button>
        </div>
      </div>
    </div>
  );
}
