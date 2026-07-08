import React, { useState } from 'react';
import { api } from '../api.js';
import { parseMoney, todayISO } from '../format.js';
import { useAccounts } from '../useAccounts.js';

// Quick-add for misc/uncategorized transactions (the spreadsheet's Misc_Trans
// tab and Misc Income rows, unified). Entering a negative amount flips the
// type to expense automatically server-side. With a fixedAccountId (a page
// already scoped to one account) the account picker is hidden and every
// transaction lands in that account.
export default function QuickAddTransaction({ onAdded, defaultDate, fixedAccountId, tags = [] }) {
  const { active } = useAccounts();
  const [amount, setAmount] = useState('');
  const [type, setType] = useState('expense');
  const [tagId, setTagId] = useState('');
  const [description, setDescription] = useState('');
  const [date, setDate] = useState(defaultDate || todayISO());
  const [accountId, setAccountId] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

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
          accountId: fixedAccountId ?? (accountId ? Number(accountId) : undefined),
          categoryTemplateId: tagId ? Number(tagId) : undefined,
        },
      });
      setAmount('');
      setDescription('');
      setTagId('');
      onAdded?.();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  // Field order matters: amount first, Add within reach, description last —
  // the common flow is "type an amount, hit Add", description is an
  // afterthought.
  return (
    <form className="quick-add" onSubmit={submit}>
      <input
        type="text" inputMode="decimal" placeholder="Amount" value={amount} aria-label="Amount"
        onChange={(e) => setAmount(e.target.value)}
      />
      <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Type" disabled={Boolean(tagId)}>
        <option value="expense">Expense</option>
        <option value="income">Income</option>
      </select>
      {tags.length > 0 && (
        <select value={tagId} onChange={(e) => chooseTag(e.target.value)} aria-label="Tag" title="Optional tag">
          <option value="">No tag</option>
          {tags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      )}
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
      <button className="btn btn-primary" disabled={busy}>Add</button>
      <input
        type="text" placeholder="Description (optional)" value={description} aria-label="Description"
        onChange={(e) => setDescription(e.target.value)}
      />
      {fixedAccountId == null && active.length > 1 && (
        <select value={accountId} onChange={(e) => setAccountId(e.target.value)} aria-label="Account">
          {active.map((a) => (
            <option key={a.id} value={a.isDefault ? '' : a.id}>
              {a.name}{a.currency ? ` (${a.currency})` : ''}
            </option>
          ))}
        </select>
      )}
      {error && <span className="form-error" role="alert">{error}</span>}
    </form>
  );
}
