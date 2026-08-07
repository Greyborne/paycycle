import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAccount, useAuth } from '../App.jsx';
import { centsToInput, fmtDate, fmtMoney, parseMoney } from '../format.js';
import { useAccounts } from '../useAccounts.js';
import { withDisplayNames } from '../categoryScope.js';
import RuleCreateDrawer from '../components/RuleCreateDrawer.jsx';

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
// Account-metadata fields are a secondary within-account filter, not the
// scope-deciding axis (that's the category's owning account) - see
// CONSTITUTION.md §8 2026-07-26. Short tags for the summary badge.
const ACCOUNT_META_FIELDS = [
  ['accountContains', 'acct'],
  ['institutionContains', 'inst'],
  ['accountNumberContains', 'acct#'],
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

function AccountMetaBadge({ state }) {
  const parts = ACCOUNT_META_FIELDS.filter(([k]) => state[k]).map(([k, label]) => `${label}: "${state[k]}"`);
  if (parts.length === 0) return null;
  return (
    <span className="badge badge-tag rule-meta-badge" title="Secondary within-account filter (does not decide which account this rule belongs to)">
      {parts.join(' · ')}
    </span>
  );
}

function RuleRow({ rule, categories, defaultId, currency, onChanged, onMove, isFirst, isLast }) {
  const [state, setState] = useState({
    ...rule,
    amountMinCents: rule.amountMinCents != null ? centsToInput(rule.amountMinCents) : '',
    amountMaxCents: rule.amountMaxCents != null ? centsToInput(rule.amountMaxCents) : '',
    amountEqualsCents: rule.amountEqualsCents != null ? centsToInput(rule.amountEqualsCents) : '',
  });
  const [dirty, setDirty] = useState(false);
  const preview = usePreview(dirty ? fieldsForPreview(state) : EMPTY);

  // Category dropdown is constrained to categories owned by THIS rule's own
  // owning account (CONSTITUTION.md §8 2026-07-26) — editing a rule can never
  // move it into a cross-account, "can never fire" state. Safety net: if the
  // rule already points at an out-of-account category (a pre-existing dead
  // rule), that current option is still shown rather than silently dropped,
  // and a visible flag is rendered below.
  const currentCat = categories.find((c) => c.id === Number(state.categoryTemplateId));
  const inAccountCategories = categories.filter((c) => (c.accountId ?? defaultId) === rule.owningAccountId);
  const isDead = Boolean(currentCat) && (currentCat.accountId ?? defaultId) !== rule.owningAccountId;
  const categoryOptions = isDead && !inAccountCategories.some((c) => c.id === currentCat.id)
    ? [...inAccountCategories, currentCat]
    : inAccountCategories;

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
          {withDisplayNames(categoryOptions).map((c) => (
            <option key={c.id} value={c.id}>{c.displayName ?? c.name}{c.categoryType === 'tag' ? ' (tag)' : ''}</option>
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
      <AccountMetaBadge state={state} />
      {isDead && (
        <span
          className="badge badge-dead rule-dead-badge"
          title="This rule's category belongs to a different account, so it can never match a transaction."
        >
          Can never fire — category is in another account
        </span>
      )}
      {dirty && <MatchPreview preview={preview} currency={currency} />}
    </div>
  );
}

const RULE_GRID_HEAD = (
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
);

function RuleGroupRows({ list, categories, defaultId, currency, onChanged, onMove }) {
  return list.map((r, i) => (
    <RuleRow
      key={r.id} rule={r} categories={categories} defaultId={defaultId} currency={currency}
      onChanged={onChanged} onMove={onMove} isFirst={i === 0} isLast={i === list.length - 1}
    />
  ));
}

export default function Rules() {
  const { user } = useAuth();
  const { accountId } = useAccount();
  const { accounts, base: baseAccounts } = useAccounts();
  const [rules, setRules] = useState(null);
  const [categories, setCategories] = useState([]);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const addRuleBtnRef = useRef(null);

  const load = useCallback(async () => {
    const [r, c] = await Promise.all([api('/rules'), api('/categories')]);
    setRules(r.rules);
    setCategories(c.categories.filter((x) => !x.archived));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!rules || accounts === null) return <div className="rules-page"><div className="page-loading">Loading…</div></div>;

  // Grouping axis = the rule's category's owning account (CONSTITUTION.md
  // §8 2026-07-26), mirroring Categories.jsx's inAccount pattern - not the
  // account-metadata match fields, which are only a secondary within-account
  // filter (see AccountMetaBadge).
  const defaultId = baseAccounts.find((a) => a.isDefault)?.id ?? baseAccounts[0]?.id ?? null;
  const selectedId = baseAccounts.some((a) => a.id === accountId) ? accountId : defaultId;
  const catById = new Map(categories.map((c) => [c.id, c]));
  const owningAccountOf = (rule) => {
    if (rule.owningAccountId != null) return rule.owningAccountId;
    const cat = catById.get(rule.categoryTemplateId);
    return cat?.accountId ?? defaultId;
  };
  const accountName = (id) => baseAccounts.find((a) => a.id === id)?.name ?? `Account ${id}`;

  const move = async (rule, dir) => {
    const owner = owningAccountOf(rule);
    const groupRules = rules.filter((r) => owningAccountOf(r) === owner);
    const gi = groupRules.findIndex((r) => r.id === rule.id);
    const gj = gi + dir;
    if (gj < 0 || gj >= groupRules.length) return;
    // Swap the two group-mates at their true positions in the global,
    // budget-wide sort order - reordering only ever moves a rule against
    // another rule from the same (owning) account.
    const ids = rules.map((r) => r.id);
    const i = ids.indexOf(rule.id);
    const j = ids.indexOf(groupRules[gj].id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    await api('/rules/reorder', { method: 'POST', body: { ids } });
    load();
  };

  const selectedRules = rules.filter((r) => owningAccountOf(r) === selectedId);
  const otherGroups = baseAccounts
    .filter((a) => a.id !== selectedId)
    .map((a) => ({ id: a.id, name: a.name, list: rules.filter((r) => owningAccountOf(r) === a.id) }))
    .filter((g) => g.list.length > 0);
  const showGroups = otherGroups.length > 0;

  // Authoring is account-locked (CONSTITUTION.md §8 2026-07-26): the create
  // drawer's category dropdown only ever lists the focused account's own
  // categories.
  const categoriesForSelected = categories.filter((c) => (c.accountId ?? defaultId) === selectedId);

  // Return focus to the "+ Add rule" trigger on close — mirrors
  // Transactions.jsx's closeRuleDrawer/applyRuleDrawer idiom for RuleDrawer.
  const closeCreateDrawer = () => {
    // Nothing about the page changes on a plain close (Escape/backdrop/
    // Cancel), so the trigger button is guaranteed to still be there — focus
    // it BEFORE unmounting the drawer, same reasoning as Transactions.jsx.
    addRuleBtnRef.current?.focus();
    setDrawerOpen(false);
  };
  const onRuleCreated = async () => {
    setDrawerOpen(false);
    await load();
    requestAnimationFrame(() => requestAnimationFrame(() => addRuleBtnRef.current?.focus()));
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
          <div className="card-head">
            <h2 className="rule-group-head">{accountName(selectedId)}</h2>
            <button type="button" ref={addRuleBtnRef} className="btn btn-primary" onClick={() => setDrawerOpen(true)}>
              + Add rule
            </button>
          </div>
          {RULE_GRID_HEAD}
          {rules.length === 0 && (
            <p className="muted small">
              No rules yet. Use “Add rule” above, or confirm matches during a CSV import to learn them
              automatically.
            </p>
          )}
          <RuleGroupRows list={selectedRules} categories={categories} defaultId={defaultId} currency={user.currency} onChanged={load} onMove={move} />
          {showGroups && selectedRules.length === 0 && (
            <p className="muted small">No rules for this account yet.</p>
          )}
          {otherGroups.map((g) => (
            <details key={g.id} className="rule-group">
              <summary className="rule-group-summary">
                {g.name} <span className="muted small">({g.list.length} rule{g.list.length === 1 ? '' : 's'})</span>
              </summary>
              {RULE_GRID_HEAD}
              <RuleGroupRows list={g.list} categories={categories} defaultId={defaultId} currency={user.currency} onChanged={load} onMove={move} />
            </details>
          ))}
        </div>
      </section>
      {drawerOpen && (
        <RuleCreateDrawer
          categories={categoriesForSelected}
          accountName={accountName(selectedId)}
          onClose={closeCreateDrawer}
          onCreated={onRuleCreated}
        />
      )}
    </div>
  );
}
