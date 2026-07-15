import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { fmtDate, fmtMoney, parseMoney } from '../format.js';

// Quick-rule side drawer: opened from an uncategorized transaction row on the
// Transactions page. Lets the user build+save a category_rules row prefilled
// from that transaction, then re-runs categorization so the row updates in
// place — without leaving the page or hand-copying the description to /rules.

const AMOUNT_KEYS = ['amountMinCents', 'amountMaxCents', 'amountEqualsCents'];

function hasCriteria(s) {
  return Boolean(
    s.descriptionContains || s.accountContains || s.institutionContains
    || s.accountNumberContains || s.amountContains
    || s.amountMinCents !== '' || s.amountMaxCents !== '' || s.amountEqualsCents !== ''
  );
}

// Dollars-in-the-input, cents-on-the-wire — same convention as the Rules page.
function toApiFields(s) {
  const out = { ...s };
  delete out.categoryTemplateId;
  for (const k of AMOUNT_KEYS) out[k] = s[k] === '' ? null : parseMoney(String(s[k]));
  return out;
}

function CategoryOptions({ categories }) {
  const group = (type, categoryType) => categories
    .filter((c) => !c.archived && c.type === type && c.categoryType === categoryType);
  const renderOptions = (list) => list.map((c) => <option key={c.id} value={c.id}>{c.name}</option>);
  return (
    <>
      <option value="">Choose a category…</option>
      <optgroup label="Bills & income (recurring)">
        {renderOptions(group('expense', 'recurring'))}
        {renderOptions(group('income', 'recurring'))}
      </optgroup>
      <optgroup label="Tags (one-off)">
        {renderOptions(group('expense', 'tag'))}
        {renderOptions(group('income', 'tag'))}
      </optgroup>
    </>
  );
}

// `summary` is natively focusable/tabbable without a tabindex, so it MUST be
// tracked as an ordinary mid-sequence stop here — otherwise the boundary-wrap
// logic below (which treats "focus landed somewhere untracked" as having hit
// an edge) misfires the moment real Tab traffic reaches it, snapping focus
// away instead of letting it continue naturally through the rest of the form.
const FOCUSABLE = 'summary, a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), '
  + 'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function RuleDrawer({ txn, categories, currency, onClose, onApplied }) {
  const [state, setState] = useState({
    categoryTemplateId: '',
    descriptionContains: txn.description || '',
    accountContains: '',
    institutionContains: '',
    accountNumberContains: '',
    amountMinCents: '',
    amountMaxCents: '',
    amountEqualsCents: '',
    amountContains: '',
  });
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const drawerRef = useRef(null);
  const headingRef = useRef(null);

  const set = (k, v) => setState((s) => ({ ...s, [k]: v }));

  // Move focus into the drawer on open.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  // Debounced live match preview — don't fire while no condition is filled.
  useEffect(() => {
    if (!hasCriteria(state)) {
      setPreview(null);
      return undefined;
    }
    const timer = setTimeout(async () => {
      try {
        const res = await api('/rules/preview', { method: 'POST', body: toApiFields(state) });
        setPreview(res);
      } catch {
        setPreview(null);
      }
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(state)]);

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

  const submit = async () => {
    if (!state.categoryTemplateId || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api('/rules', {
        method: 'POST',
        body: { categoryTemplateId: state.categoryTemplateId, ...toApiFields(state) },
      });
      const res = await api('/transactions/recategorize', { method: 'POST' });
      const notice = `Rule created · matched ${res.matched} of ${res.examined} uncategorized transaction(s)`
        + `${res.skippedClosed ? ` · ${res.skippedClosed} in closed periods skipped` : ''}`;
      onApplied(notice);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  let previewText;
  if (!hasCriteria(state)) previewText = 'No matches yet — add a condition';
  else if (!preview) previewText = 'Checking…';
  else if (preview.count === 0) previewText = 'No matches yet — add a condition';
  else previewText = `Matches ${preview.count} transaction(s)`;

  const sample = preview && preview.count > 0 ? preview.sample.slice(0, 5) : [];

  return (
    <div className="modal-backdrop rule-drawer-backdrop" onClick={requestClose}>
      <div
        className="rule-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rule-drawer-title"
        ref={drawerRef}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="rule-drawer-head">
          <h2 id="rule-drawer-title" ref={headingRef} tabIndex={-1}>New rule</h2>
          <button
            type="button" className="btn btn-ghost btn-small rule-drawer-close"
            onClick={requestClose} disabled={busy} aria-label="Close"
          >
            ×
          </button>
        </div>

        <dl className="rule-drawer-source">
          <dt>Date</dt>
          <dd>{fmtDate(txn.date)}</dd>
          <dt>Description</dt>
          <dd>{txn.description || '—'}</dd>
          <dt>Amount</dt>
          <dd className={txn.type === 'expense' ? 'amount-neg' : ''}>
            {txn.type === 'expense' ? '−' : ''}{fmtMoney(txn.amount_cents, currency)}
          </dd>
        </dl>

        <label>
          Category
          <select
            value={state.categoryTemplateId}
            onChange={(e) => set('categoryTemplateId', e.target.value ? Number(e.target.value) : '')}
          >
            <CategoryOptions categories={categories} />
          </select>
        </label>
        {!state.categoryTemplateId && <p className="muted small">Pick a category to assign</p>}

        <label>
          Description contains
          <input
            type="text" value={state.descriptionContains}
            onChange={(e) => set('descriptionContains', e.target.value)}
          />
        </label>

        <details className="rule-drawer-more">
          <summary>More conditions</summary>
          <label>
            Account contains
            <input type="text" value={state.accountContains} onChange={(e) => set('accountContains', e.target.value)} />
          </label>
          <label>
            Institution contains
            <input type="text" value={state.institutionContains} onChange={(e) => set('institutionContains', e.target.value)} />
          </label>
          <label>
            Account number contains
            <input type="text" value={state.accountNumberContains} onChange={(e) => set('accountNumberContains', e.target.value)} />
          </label>
          <label>
            Amount min
            <input type="text" inputMode="decimal" value={state.amountMinCents} onChange={(e) => set('amountMinCents', e.target.value)} />
          </label>
          <label>
            Amount max
            <input type="text" inputMode="decimal" value={state.amountMaxCents} onChange={(e) => set('amountMaxCents', e.target.value)} />
          </label>
          <label>
            Amount equals
            <input type="text" inputMode="decimal" value={state.amountEqualsCents} onChange={(e) => set('amountEqualsCents', e.target.value)} />
          </label>
          <label>
            Amount contains
            <input type="text" value={state.amountContains} onChange={(e) => set('amountContains', e.target.value)} />
          </label>
        </details>

        <div
          className={`rule-drawer-preview small ${!preview || preview.count === 0 ? 'muted' : ''}`}
          aria-live="polite"
        >
          {previewText}
          {sample.length > 0 && (
            <ul className="rule-drawer-sample">
              {sample.map((s) => (
                <li key={s.id}>{fmtDate(s.date)} · {s.description || '—'} · {fmtMoney(s.amountCents, currency)}</li>
              ))}
              {preview.count > sample.length && <li>…and {preview.count - sample.length} more</li>}
            </ul>
          )}
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}

        <div className="modal-actions">
          <button type="button" className="btn btn-ghost" onClick={requestClose} disabled={busy}>Cancel</button>
          <button
            type="button" className="btn btn-primary"
            onClick={submit} disabled={!state.categoryTemplateId || busy}
          >
            {busy ? 'Saving…' : 'Save & apply'}
          </button>
        </div>
      </div>
    </div>
  );
}
