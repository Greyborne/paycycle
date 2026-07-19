import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { centsToInput, fmtMoney, parseMoney } from '../format.js';
import { useAccounts } from '../useAccounts.js';

const TYPES = ['checking', 'savings', 'credit', 'cash', 'other'];
const CADENCES = ['weekly', 'biweekly', 'semimonthly', 'monthly', 'custom'];

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

export default function AccountsCard() {
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
    <section className="card">
      <h2>Bank accounts</h2>
      <p className="muted small">
        Balances and projections are tracked per account — use the switcher in the top bar to change
        which one you're viewing, and set each category's account on the Categories page. The starting
        balance is what the account held going into its <em>tracking from</em> date; categories on the
        account default to that date. Net worth across all accounts is {fmtMoney(total, user.currency)}.
        Archiving hides an account from pickers but keeps its history in the totals.
      </p>
      <table className="table">
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
