import React, { useState } from 'react';
import { api } from '../api.js';
import { parseMoney, todayISO } from '../format.js';
import { useAccounts } from '../useAccounts.js';

// Quick-add for misc/uncategorized transactions (the spreadsheet's Misc_Trans
// tab and Misc Income rows, unified). Entering a negative amount flips the
// type to expense automatically server-side.
export default function QuickAddTransaction({ onAdded }) {
  const { active } = useAccounts();
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('expense');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(todayISO());
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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
          accountId: accountId ? Number(accountId) : undefined,
        },
      });
      setAmount('');
      setDescription('');
      onAdded?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="quick-add" onSubmit={submit}>
      <input
        type="text" inputMode="decimal" placeholder="Amount" value={amount} aria-label="Amount"
        onChange={(e) => setAmount(e.target.value)}
      />
      <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type">
        <option value="expense">Expense</option>
        <option value="income">Income</option>
      </select>
      <input
        type="text" placeholder="Description (optional)" value={description} aria-label="Description"
        onChange={(e) => setDescription(e.target.value)}
      />
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      {active.length > 1 && (
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
          {active.map((a) => (
            <option key={a.id} value={a.isDefault ? '' : a.id}>
              {a.name}{a.currency ? ` (${a.currency})` : ''}
            </option>
          ))}
        </select>
      )}
      <button className="btn btn-primary" disabled={busy}>Add</button>
      {error && <span className="form-error" role="alert">{error}</span>}
    </form>
  );
}
