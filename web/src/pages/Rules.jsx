import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { centsToInput, fmtDate, fmtMoney, parseMoney } from '../format.js';

// Spreadsheet-style rule editor: one row per rule, all filled-in fields must
// match (AND), first matching rule in order wins.

const TEXT_FIELDS = [
  ['descriptionContains', 'Description contains'],
  ['accountContains', 'Account contains'],
  ['institutionContains', 'Institution contains'],
  ['accountNumberContains', 'Acct # contains'],
];
const AMOUNT_FIELDS = [
  ['amountMinCents', 'Min'],
  ['amountMaxCents', 'Max'],
  ['amountEqualsCents', 'Equals'],
];

function usePreview(fields) {
  const [preview, setPreview] = useState(null);
  const timer = useRef(null);
  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const hasCriteria = TEXT_FIELDS.some(([k]) => fields[k])
      || AMOUNT_FIELDS.some(([k]) => fields[k] !== null && fields[k] !== undefined && fields[k] !== '')
      || fields.amountContains;
    if (!hasCriteria) { setPreview(null); return undefined; }
    timer.current = setTimeout(async () => {
      try {
        setPreview(await api('/rules/preview', { method: 'POST', body: fields }));
      } catch {
        setPreview(null);
      }
    }, 350);
    return () => clearTimeout(timer.current);
  }, [JSON.stringify(fields)]); // eslint-disable-line react-hooks/exhaustive-deps
  return preview;
}

function MatchPreview({ preview, currency }) {
  const [open, setOpen] = useState(false);
  if (!preview) return null;
  return (
    <div className={`rule-preview small ${preview.count === 0 ? 'muted' : ''}`}>
      {preview.count === 0 ? (
        'Matches no existing transactions — check the conditions aren’t too narrow.'
      ) : (
        <>
          Matches <strong>{preview.count}</strong> existing transaction(s)
          {' '}
          <button className="btn btn-ghost btn-small" onClick={() => setOpen(!open)}>
            {open ? 'hide' : 'show'}
          </button>
          {open && (
            <ul>
              {preview.sample.map((t) => (
                <li key={t.id}>{fmtDate(t.date)} · {t.description || '—'} · {fmtMoney(t.amountCents, currency)}</li>
              ))}
              {preview.count > preview.sample.length && <li className="muted">…and {preview.count - preview.sample.length} more</li>}
            </ul>
          )}
        </>
      )}
    </div>
  );
}

const EMPTY = {
  categoryTemplateId: '', descriptionContains: '', accountContains: '', institutionContains: '',
  accountNumberContains: '', amountMinCents: '', amountMaxCents: '', amountEqualsCents: '',
  amountContains: '', notes: '',
};

function fieldsForPreview(state) {
  const out = { ...state };
  for (const [k] of AMOUNT_FIELDS) out[k] = state[k] === '' ? null : parseMoney(String(state[k]));
  return out;
}

function RuleRow({ rule, categories, currency, onChanged, onMove, isFirst, isLast }) {
  const [state, setState] = useState({
    ...rule,
    amountMinCents: rule.amountMinCents != null ? centsToInput(rule.amountMinCents) : '',
    amountMaxCents: rule.amountMaxCents != null ? centsToInput(rule.amountMaxCents) : '',
    amountEqualsCents: rule.amountEqualsCents != null ? centsToInput(rule.amountEqualsCents) : '',
  });
  const [dirty, setDirty] = useState(false);
  const preview = usePreview(dirty ? fieldsForPreview(state) : EMPTY);

  const set = (k, v) => { setState((s) => ({ ...s, [k]: v })); setDirty(true); };
  const save = async () => {
    if (!dirty) return;
    try {
      await api(`/rules/${rule.id}`, { method: 'PATCH', body: fieldsForPreview(state) });
      setDirty(false);
      onChanged();
    } catch (err) {
      window.alert(err.message);
    }
  };
  const del = async () => {
    if (!window.confirm('Delete this rule?')) return;
    await api(`/rules/${rule.id}`, { method: 'DELETE' });
    onChanged();
  };

  return (
    <div className="rule-row" onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) save(); }}>
      <div className="rule-grid">
        <div className="reorder">
          <button className="btn btn-ghost btn-small" disabled={isFirst} onClick={() => onMove(rule, -1)} aria-label="Move up">↑</button>
          <button className="btn btn-ghost btn-small" disabled={isLast} onClick={() => onMove(rule, 1)} aria-label="Move down">↓</button>
        </div>
        <select
          value={state.categoryTemplateId} aria-label="Category"
          onChange={(e) => set('categoryTemplateId', Number(e.target.value))}
        >
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.categoryType === 'tag' ? ' (tag)' : ''}</option>
          ))}
        </select>
        {TEXT_FIELDS.map(([k, label]) => (
          <input key={k} type="text" value={state[k] ?? ''} placeholder={label} aria-label={label}
            onChange={(e) => set(k, e.target.value)} />
        ))}
        {AMOUNT_FIELDS.map(([k, label]) => (
          <input key={k} type="text" inputMode="decimal" value={state[k]} placeholder={label} aria-label={`Amount ${label}`}
            onChange={(e) => set(k, e.target.value)} />
        ))}
        <input type="text" value={state.amountContains ?? ''} placeholder="Amt contains" aria-label="Amount contains"
          onChange={(e) => set('amountContains', e.target.value)} />
        <input type="text" value={state.notes ?? ''} placeholder="Notes" aria-label="Notes"
          onChange={(e) => set('notes', e.target.value)} />
        <button className="btn btn-ghost btn-small" onClick={del} aria-label="Delete rule">✕</button>
      </div>
      {dirty && <MatchPreview preview={preview} currency={currency} />}
    </div>
  );
}

function AddRule({ categories, currency, onAdded }) {
  const [state, setState] = useState({ ...EMPTY, categoryTemplateId: categories[0]?.id ?? '' });
  const preview = usePreview(fieldsForPreview(state));
  const [error, setError] = useState(null);

  const set = (k, v) => setState((s) => ({ ...s, [k]: v }));
  const add = async () => {
    setError(null);
    try {
      await api('/rules', { method: 'POST', body: fieldsForPreview(state) });
      setState({ ...EMPTY, categoryTemplateId: state.categoryTemplateId });
      onAdded();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="rule-row rule-add">
      <div className="rule-grid">
        <span className="muted small">new</span>
        <select value={state.categoryTemplateId} aria-label="Category" onChange={(e) => set('categoryTemplateId', Number(e.target.value))}>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>{c.name}{c.categoryType === 'tag' ? ' (tag)' : ''}</option>
          ))}
        </select>
        {TEXT_FIELDS.map(([k, label]) => (
          <input key={k} type="text" value={state[k]} placeholder={label} aria-label={label}
            onChange={(e) => set(k, e.target.value)} />
        ))}
        {AMOUNT_FIELDS.map(([k, label]) => (
          <input key={k} type="text" inputMode="decimal" value={state[k]} placeholder={label} aria-label={`Amount ${label}`}
            onChange={(e) => set(k, e.target.value)} />
        ))}
        <input type="text" value={state.amountContains} placeholder="Amt contains" aria-label="Amount contains"
          onChange={(e) => set('amountContains', e.target.value)} />
        <input type="text" value={state.notes} placeholder="Notes" aria-label="Notes"
          onChange={(e) => set('notes', e.target.value)} />
        <button className="btn btn-primary btn-small" onClick={add}>Add</button>
      </div>
      <MatchPreview preview={preview} currency={currency} />
      {error && <p className="form-error small">{error}</p>}
    </div>
  );
}

export default function Rules() {
  const { user } = useAuth();
  const [rules, setRules] = useState(null);
  const [categories, setCategories] = useState([]);

  const load = useCallback(async () => {
    const [r, c] = await Promise.all([api('/rules'), api('/categories')]);
    setRules(r.rules);
    setCategories(c.categories.filter((x) => !x.archived));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!rules) return <div className="page-loading">Loading…</div>;

  const move = async (rule, dir) => {
    const ids = rules.map((r) => r.id);
    const i = ids.indexOf(rule.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('/rules/reorder', { method: 'POST', body: { ids } });
    load();
  };

  return (
    <div className="rules-page">
      <p className="muted">
        Rules auto-categorize imported and synced transactions. Within a rule every filled-in field
        must match; across rules the <strong>first match from the top wins</strong>, so order matters.
        Manually categorized transactions are never touched.
      </p>
      <section className="card">
        <div className="rules-scroll">
          <div className="rule-grid rule-grid-head muted small" aria-hidden="true">
            <span />
            <span>Category</span>
            <span>Description</span>
            <span>Account</span>
            <span>Institution</span>
            <span>Acct #</span>
            <span>Min</span>
            <span>Max</span>
            <span>Equals</span>
            <span>Amt has</span>
            <span>Notes</span>
            <span />
          </div>
          {rules.length === 0 && (
            <p className="muted small">
              No rules yet. Add one below, or confirm matches during a CSV import to learn them
              automatically.
            </p>
          )}
          {rules.map((r, i) => (
            <RuleRow
              key={r.id} rule={r} categories={categories} currency={user.currency}
              onChanged={load} onMove={move} isFirst={i === 0} isLast={i === rules.length - 1}
            />
          ))}
          <AddRule categories={categories} currency={user.currency} onAdded={load} />
        </div>
      </section>
    </div>
  );
}
