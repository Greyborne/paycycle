import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { centsToInput, fmtMoney, parseMoney } from '../format.js';
import { useAccounts } from '../useAccounts.js';

const TYPES = ['checking', 'savings', 'credit', 'cash', 'other'];
const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'custom'];

// Type-to-confirm gate (Tier 2/3 of docs/plans/data-reset.md — "Confirmation
// UI (all three tiers)"): the caller must type an exact expected string
// before the guarded action is allowed to run. Built from existing
// input/.btn tokens (§4), not a new visual component — just a new
// interaction shape. Reuse this hook as-is for Tier 3 (delete account):
// `const confirm = useTypeToConfirm(account.name)`, spread
// `confirm.inputProps` onto a labeled text input, gate the destructive
// button on `confirm.matched`, and call `confirm.reset()` after a
// successful (or abandoned) action.
function useTypeToConfirm(expected) {
  const [value, setValue] = useState('');
  return {
    value,
    matched: value.length > 0 && value === expected,
    reset: () => setValue(''),
    inputProps: {
      type: 'text',
      value,
      autoComplete: 'off',
      onChange: (e) => setValue(e.target.value),
    },
  };
}

// Tier 2 data reset: re-date an account's tracking-start and wipe its open
// periods/transactions down to that new starting line (closed periods and
// categories are never touched — server/routes/accounts.js). This is a
// harder-to-undo action than deleting transactions alone (Tier 1): it also
// deletes the open pay_periods/line_items themselves, not just the
// transactions in them. Gated by the type-to-confirm control above.
function ResetAccountRow({ account, label, resetting, blocked, onReset }) {
  const [startedOn, setStartedOn] = useState('');
  const confirm = useTypeToConfirm(account.name);
  const canSubmit = Boolean(startedOn) && confirm.matched && !resetting;

  return (
    <div className="reset-account-row">
      <div className="quick-add">
        <label htmlFor={`reset-date-${account.id}`} className="muted small">
          New tracking-start date
        </label>
        <input
          id={`reset-date-${account.id}`}
          type="date"
          value={startedOn}
          onChange={(e) => setStartedOn(e.target.value)}
          aria-label={`New tracking-start date for ${label}`}
        />
        <label htmlFor={`reset-confirm-${account.id}`} className="sr-only">
          Type {account.name} to confirm resetting {label}
        </label>
        <input
          id={`reset-confirm-${account.id}`}
          {...confirm.inputProps}
          placeholder={`Type "${account.name}" to confirm`}
          aria-label={`Type ${account.name} to confirm resetting ${label}`}
        />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!canSubmit}
          onClick={() => onReset(account, startedOn, confirm.reset)}
          aria-label={resetting ? `Resetting ${label}…` : `Reset account for ${label}`}
        >
          {resetting ? 'Resetting…' : 'Reset account'}
        </button>
      </div>
      {blocked && (
        <div className="reset-block">
          <p className="form-error" role="alert">{blocked.message}</p>
          <button
            type="button"
            className="btn btn-ghost"
            disabled={resetting}
            onClick={() => onReset(account, blocked.startedOn, confirm.reset, { closedPeriods: 'confirm' })}
          >
            I understand, reset anyway
          </button>
        </div>
      )}
    </div>
  );
}

// Tier 3 data reset: hard-delete the account itself (server/routes/accounts.js
// DELETE /:id — 204 on success). This is the most severe tier of the three:
// unlike Tier 1/2, it also deletes this account's CLOSED periods and their
// frozen closed_snapshot records (the one deliberate exception to "closed
// periods are frozen" elsewhere in this app). Categories and rules the
// account owned survive and fall back to the household's default account.
// There is no down path from this action short of a full database restore —
// no in-app undo, unlike Tier 1/2's "re-enter it" recovery. Gated by the same
// type-to-confirm control as Tier 2.
function DeleteAccountRow({ account, label, deleting, onDelete }) {
  const confirm = useTypeToConfirm(account.name);
  return (
    <div className="reset-account-row">
      <div className="quick-add">
        <label htmlFor={`delete-confirm-${account.id}`} className="sr-only">
          Type {account.name} to confirm deleting {label}
        </label>
        <input
          id={`delete-confirm-${account.id}`}
          {...confirm.inputProps}
          placeholder={`Type "${account.name}" to confirm`}
          aria-label={`Type ${account.name} to confirm deleting ${label}`}
        />
        <button
          type="button"
          className="btn btn-ghost"
          disabled={!confirm.matched || deleting}
          aria-label={`Delete account for ${label}`}
          onClick={() => onDelete(account, confirm.reset)}
        >
          {deleting ? 'Deleting…' : 'Delete account'}
        </button>
      </div>
    </div>
  );
}

function AccountRow({ account, currency, onPatch }) {
  const [starting, setStarting] = useState(centsToInput(account.startingBalanceCents));
  const displayCurrency = account.currency || currency;
  return (
    <tr className={account.archived ? 'row-muted' : ''}>
      <td>
        <input
          className="category-name" defaultValue={account.name} disabled={account.archived}
          aria-label={`Name for ${account.name}`}
          onBlur={(e) => {
            const v = e.target.value.trim();
            if (v && v !== account.name) onPatch(account.id, { name: v });
          }}
        />
        {account.currency && (
          <span className="badge health-none" title="Tracked in its own currency, outside period budget math">
            {account.currency}
          </span>
        )}
      </td>
      <td>
        <select
          value={account.type} disabled={account.archived}
          aria-label={`Type for ${account.name}`}
          onChange={(e) => onPatch(account.id, { type: e.target.value })}
        >
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </td>
      <td className="num">
        <input
          className="cell-input" type="text" inputMode="decimal" value={starting} disabled={account.archived}
          aria-label={`Starting balance for ${account.name}`}
          onChange={(e) => setStarting(e.target.value)}
          onBlur={() => {
            const cents = parseMoney(starting);
            if (cents !== null && cents !== account.startingBalanceCents) {
              onPatch(account.id, { startingBalanceCents: cents });
            } else {
              setStarting(centsToInput(account.startingBalanceCents));
            }
          }}
        />
      </td>
      <td>
        <input
          type="date" defaultValue={account.startedOn ?? ''} disabled={account.archived}
          title="When tracking began — the starting balance is as of the day before, and new categories on this account default to it"
          aria-label={`Tracking from for ${account.name}`}
          onChange={(e) => { if (e.target.value) onPatch(account.id, { startedOn: e.target.value }); }}
        />
      </td>
      <td className="num">{fmtMoney(account.balanceCents, displayCurrency)}</td>
      <td className="center">
        <input
          type="radio" name="default-account" checked={account.isDefault}
          disabled={account.archived || Boolean(account.currency)}
          onChange={() => onPatch(account.id, { isDefault: true })}
          title={account.currency ? 'Foreign-currency accounts cannot be the default' : 'Default account for new items'}
          aria-label={`Default for ${account.name}`}
        />
      </td>
      <td className="center">
        {!account.isDefault && (
          <button type="button" className="btn btn-ghost btn-small" onClick={() => onPatch(account.id, { archived: !account.archived })}>
            {account.archived ? 'Restore' : 'Archive'}
          </button>
        )}
      </td>
    </tr>
  );
}

// Bank accounts table + add-account form + archive/restore. Split out of the
// former single AccountsCard so it can render in its own tab panel (Settings
// "Accounts" tab) without pulling in the Danger zone actions below.
export function BankAccountsCard() {
  const { user } = useAuth();
  const { accounts, reload } = useAccounts();
  const [name, setName] = useState('');
  const [type, setType] = useState('checking');
  const [starting, setStarting] = useState('');
  const [startedOn, setStartedOn] = useState('');
  const [accountCurrency, setAccountCurrency] = useState('');
  const [cadence, setCadence] = useState('biweekly');
  const [intervalDays, setIntervalDays] = useState('14');
  const [error, setError] = useState(null);

  if (!accounts) return null;

  const isForeign = Boolean(accountCurrency.trim()) && accountCurrency.trim() !== (user?.currency ?? '');

  const patch = async (id, body) => {
    setError(null);
    try {
      await api(`/accounts/${id}`, { method: 'PATCH', body });
      reload();
    } catch (err) {
      setError(err.message);
      reload();
    }
  };

  const add = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await api('/accounts', {
        method: 'POST',
        body: {
          name,
          type,
          startingBalanceCents: parseMoney(starting) ?? 0,
          startedOn: startedOn || undefined,
          currency: accountCurrency.trim() || undefined,
          cadence: isForeign ? undefined : cadence,
          intervalDays: !isForeign && cadence === 'custom' ? Number(intervalDays) : undefined,
        },
      });
      setName('');
      setStarting('');
      setStartedOn('');
      setAccountCurrency('');
      setCadence('biweekly');
      setIntervalDays('14');
      reload();
    } catch (err) {
      setError(err.message);
    }
  };

  const total = accounts.reduce((s, a) => s + a.balanceCents, 0);

  return (
    <section className="card grid-full">
      <h2>Bank accounts</h2>
      <p className="muted small">
        Balances and projections are tracked per account — use the switcher in the top bar to change
        which one you're viewing, and set each category's account on the Categories page. The starting
        balance is what the account held going into its <em>tracking from</em> date; categories on the
        account default to that date. Net worth across all accounts is {fmtMoney(total, user.currency)}.
        Archiving hides an account from pickers but keeps its history in the totals.
      </p>
      <div className="table-scroll">
        <table className="table table-plain-head">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th className="num">Starting balance</th><th>Tracking from</th>
              <th className="num">Current balance</th><th className="center">Default</th><th><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {accounts.map((a) => (
              <AccountRow key={a.id} account={a} currency={user.currency} onPatch={patch} />
            ))}
          </tbody>
        </table>
      </div>
      <form className="quick-add" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New account name" aria-label="New account name" required />
        <select value={type} onChange={(e) => setType(e.target.value)} aria-label="New account type">
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={starting} onChange={(e) => setStarting(e.target.value)} inputMode="decimal" placeholder="Starting balance" aria-label="Starting balance" />
        <input
          type="date" value={startedOn} onChange={(e) => setStartedOn(e.target.value)}
          title="Tracking start — defaults to the current pay period"
          aria-label="Tracking from"
        />
        <input
          value={accountCurrency} onChange={(e) => setAccountCurrency(e.target.value.toUpperCase())}
          maxLength={3} placeholder={user.currency} style={{ width: '5.5rem' }}
          title="Currency (leave as household currency, or a different code for a tracked foreign-currency account)"
          aria-label="Currency"
        />
        {!isForeign && (
          <>
            <select
              value={cadence} onChange={(e) => setCadence(e.target.value)}
              aria-label="Pay cadence"
              title="How often this account's pay periods repeat"
            >
              {CADENCES.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {cadence === 'custom' && (
              <input
                type="number" min="2" max="185" required
                value={intervalDays} onChange={(e) => setIntervalDays(e.target.value)}
                className="cell-input" style={{ width: '5rem' }}
                aria-label="Days per period"
                title="Days per period"
              />
            )}
          </>
        )}
        <button className="btn btn-primary">Add account</button>
      </form>
      <p className="muted small">
        An account in a different currency is tracked in that currency and stays outside period
        budget math — no exchange-rate guessing.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}

// The three per-account destructive actions (delete transactions / reset
// account / delete account), split out of the former single AccountsCard so
// it can render in its own tab panel (Settings "Maintenance" tab), fenced
// visually as a danger zone. Shares useAccounts() with BankAccountsCard
// above rather than lifting state up: the two never render at the same time
// (different Tabs panels — Tabs unmounts the inactive one), so there is no
// duplicate concurrent fetch, and each keeps its own independent state.
export function DangerZoneCard() {
  const { user } = useAuth();
  const { accounts, reload } = useAccounts();
  const [deletingTxnsId, setDeletingTxnsId] = useState(null);
  const [resetError, setResetError] = useState(null);
  const [resetMessage, setResetMessage] = useState(null);
  const [resettingId, setResettingId] = useState(null);
  // Set when POST /accounts/:id/reset 400s because the chosen startedOn
  // would predate/land on a closed period. Holds the account id and the
  // startedOn already typed in, so the "reset anyway" retry (closedPeriods:
  // 'confirm') doesn't make the user re-enter anything.
  const [resetBlock, setResetBlock] = useState(null);
  const [deleteError, setDeleteError] = useState(null);
  const [deleteMessage, setDeleteMessage] = useState(null);
  const [deletingAccountId, setDeletingAccountId] = useState(null);

  if (!accounts) return null;

  // Tier 1 data reset: wipe every transaction sitting in this account's OPEN
  // pay periods (closed periods are the frozen audited record and are never
  // touched — see server/routes/accounts.js). There's no cheap endpoint to
  // get an exact open-period transaction count without fetching the rows
  // themselves (GET /transactions?account= returns full rows, capped at
  // 1000), so the confirm names the account instead of a number — same
  // "no exact number" fallback the task brief allows.
  const deleteAllTransactions = async (account) => {
    if (!window.confirm(
      `Delete all transactions in ${account.name}'s open pay periods? This cannot be undone.`
    )) return;
    setResetError(null);
    setResetMessage(null);
    setDeletingTxnsId(account.id);
    try {
      const res = await api(`/accounts/${account.id}/transactions`, { method: 'DELETE' });
      setResetMessage(`Deleted ${res.deleted} transaction(s) from ${account.name}.`);
      reload();
    } catch (err) {
      setResetError(err.message);
    } finally {
      setDeletingTxnsId(null);
    }
  };

  // Tier 2 data reset: "fresh start, keep structure." Wipes this account's
  // open pay_periods (and everything in them — transactions, line_items)
  // down to a new tracking-start date; closed periods and categories are
  // never touched. On a 400 (startedOn at/before a closed period), the
  // server names the earliest one; that's surfaced as-is rather than a
  // generic error, with an explicit second step to retry with
  // closedPeriods: 'confirm' if the user chooses to. Never silently retried.
  const resetAccount = async (account, startedOnValue, clearConfirmText, opts = {}) => {
    setResetError(null);
    setResetMessage(null);
    setResettingId(account.id);
    try {
      const body = { startedOn: startedOnValue };
      if (opts.closedPeriods) body.closedPeriods = opts.closedPeriods;
      const res = await api(`/accounts/${account.id}/reset`, { method: 'POST', body });
      setResetMessage(
        `Reset ${res.deletedPeriods} period(s), deleted ${res.deletedTransactions} transaction(s) ` +
        `for ${account.name}. Tracking now starts ${res.startedOn}.`
      );
      setResetBlock(null);
      clearConfirmText();
      reload();
    } catch (err) {
      if (err.status === 400 && !opts.closedPeriods) {
        setResetBlock({ accountId: account.id, startedOn: startedOnValue, message: err.message });
      } else {
        setResetError(err.message);
        setResetBlock(null);
      }
    } finally {
      setResettingId(null);
    }
  };

  // Tier 3 data reset: hard-delete the account (server/routes/accounts.js
  // DELETE /:id). The server's 400 refusals ("only account" / "live default")
  // are actionable and surfaced verbatim, not paraphrased — same as the 404
  // and Tier 1/2 error handling above. On success the account is gone from
  // the API's own list, so the same `reload()` used everywhere else in this
  // file removes it from the UI.
  const deleteAccount = async (account, clearConfirmText) => {
    setDeleteError(null);
    setDeleteMessage(null);
    setDeletingAccountId(account.id);
    try {
      await api(`/accounts/${account.id}`, { method: 'DELETE' });
      setDeleteMessage(`Deleted ${account.name} and all of its data, including any closed periods.`);
      clearConfirmText();
      reload();
    } catch (err) {
      setDeleteError(err.message);
    } finally {
      setDeletingAccountId(null);
    }
  };

  return (
    <section className="card card-danger-zone grid-full">
      <h2>Danger zone</h2>
      <p className="muted small">
        Delete every transaction sitting in one account's open pay periods. Pay periods, categories
        and closed periods are untouched, and open-period actuals are recomputed afterward. This
        cannot be undone.
      </p>
      <p className="muted small">
        <strong>Reset account</strong> goes further: it deletes this account's open pay periods
        themselves — not just the transactions in them — and re-dates tracking to a new start.
        Categories, rules and closed periods are kept. This deletes real transaction and period
        history and is harder to undo than deleting transactions alone; recovering means
        re-importing or re-entering everything from the new start date forward.
      </p>
      <p className="muted small">
        <strong>Delete account</strong> is the most severe action here: it permanently deletes the
        account itself, including its closed, audited periods — this is the one
        place in PayCycle where closed-period history is not kept forever. There is no undo and no
        in-app recovery; getting any of it back would require a full database restore. Categories
        and rules this account owned are kept and fall back to the household's default account. You
        can't delete a household's only account, or its live default account — make another account
        default first.
      </p>
      {accounts.map((a) => {
        const isDupeName = accounts.filter((o) => o.name === a.name).length > 1;
        const label = isDupeName
          ? `${a.name} · ${a.type} · ${fmtMoney(a.balanceCents, a.currency || user.currency)}`
          : a.name;
        return (
          <div className="bank-connection" key={a.id}>
            <div className="card-head">
              <h3>{label}</h3>
              <button
                type="button" className="btn btn-ghost"
                disabled={deletingTxnsId === a.id}
                aria-label={`Delete all transactions for ${label}`}
                onClick={() => deleteAllTransactions(a)}
              >
                {deletingTxnsId === a.id ? 'Deleting…' : 'Delete all transactions'}
              </button>
            </div>
            <ResetAccountRow
              account={a}
              label={label}
              resetting={resettingId === a.id}
              blocked={resetBlock && resetBlock.accountId === a.id ? resetBlock : null}
              onReset={resetAccount}
            />
            <DeleteAccountRow
              account={a}
              label={label}
              deleting={deletingAccountId === a.id}
              onDelete={deleteAccount}
            />
          </div>
        );
      })}
      {resetError && <p className="form-error" role="alert">{resetError}</p>}
      {resetMessage && <p className="form-ok" role="status">{resetMessage}</p>}
      {deleteError && <p className="form-error" role="alert">{deleteError}</p>}
      {deleteMessage && <p className="form-ok" role="status">{deleteMessage}</p>}
    </section>
  );
}
