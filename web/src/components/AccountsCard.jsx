import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { centsToInput, fmtMoney, parseMoney } from '../format.js';
import { useAccounts } from '../useAccounts.js';

const TYPES = ['checking', 'savings', 'credit', 'cash', 'other'];

function AccountRow({ account, currency, onPatch }) {
  const [starting, setStarting] = useState(centsToInput(account.startingBalanceCents));
  const displayCurrency = account.currency || currency;
  return (
    <tr className={account.archived ? 'row-muted' : ''}>
      <td>
        <input
          className="category-name" defaultValue={account.name} disabled={account.archived}
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
          onChange={(e) => onPatch(account.id, { type: e.target.value })}
        >
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </td>
      <td className="num">
        <input
          className="cell-input" type="text" inputMode="decimal" value={starting} disabled={account.archived}
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
      <td className="num">{fmtMoney(account.balanceCents, displayCurrency)}</td>
      <td className="center">
        <input
          type="radio" name="default-account" checked={account.isDefault}
          disabled={account.archived || Boolean(account.currency)}
          onChange={() => onPatch(account.id, { isDefault: true })}
          title={account.currency ? 'Foreign-currency accounts cannot be the default' : 'Default account for new items'}
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
  const [accountCurrency, setAccountCurrency] = useState('');
  const [error, setError] = useState(null);

  if (!accounts) return null;

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
          currency: accountCurrency.trim() || undefined,
        },
      });
      setName('');
      setStarting('');
      setAccountCurrency('');
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
        Actual balances are tracked per account; cleared items and transactions are attributed to
        one. The projection always covers the household total ({fmtMoney(total, user.currency)}).
        Archiving hides an account from pickers but keeps its history in the totals.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th><th>Type</th><th className="num">Starting balance</th>
            <th className="num">Current balance</th><th className="center">Default</th><th />
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <AccountRow key={a.id} account={a} currency={user.currency} onPatch={patch} />
          ))}
        </tbody>
      </table>
      <form className="quick-add" onSubmit={add}>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New account name" required />
        <select value={type} onChange={(e) => setType(e.target.value)}>
          {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input value={starting} onChange={(e) => setStarting(e.target.value)} inputMode="decimal" placeholder="Starting balance" />
        <input
          value={accountCurrency} onChange={(e) => setAccountCurrency(e.target.value.toUpperCase())}
          maxLength={3} placeholder={user.currency} style={{ width: '5.5rem' }}
          title="Currency (leave as household currency, or a different code for a tracked foreign-currency account)"
        />
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
