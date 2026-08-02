import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAccount, useAuth } from '../App.jsx';
import { fmtDate, fmtMoney } from '../format.js';
import { useAccounts } from '../useAccounts.js';

// Cross-source duplicate review, scoped to the top-bar selected account.
// Renders nothing until GET /transactions/duplicates?account= reports at
// least one unresolved pair for that account — no loading/empty-state UI,
// per the "flag for review, never auto-resolve" design (see CONSTITUTION.md
// §8, 2026-08-01). A fetch failure is treated the same as "no pairs found":
// this card is a convenience surface, not a page-blocking one, so it just
// stays absent rather than showing an error banner on page load.
export default function PossibleDuplicates() {
  const { accountId } = useAccount();
  const { base: baseAccounts } = useAccounts();
  const { user } = useAuth();
  const currency = user.currency;
  const [pairs, setPairs] = useState([]);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);

  // Same "resolve the top-bar selection against the base-account list,
  // falling back to the default account" pattern used by Categories.jsx —
  // the /transactions/duplicates route treats a blank `account` query param
  // as "no filter" (all accounts), not "default account", so an unresolved
  // null selection must not be sent through as-is.
  const defaultAccountId = baseAccounts.find((a) => a.isDefault)?.id ?? baseAccounts[0]?.id ?? null;
  const selectedAccountId = baseAccounts.some((a) => a.id === accountId) ? accountId : defaultAccountId;

  const load = useCallback(async () => {
    if (selectedAccountId == null) { setPairs([]); return; }
    try {
      const d = await api(`/transactions/duplicates?account=${selectedAccountId}`);
      setPairs(d.pairs || []);
    } catch {
      setPairs([]);
    }
  }, [selectedAccountId]);

  useEffect(() => { load(); }, [load]);

  if (pairs.length === 0) return null;

  const dismiss = async (pair) => {
    setError(null);
    setBusyId(pair.id);
    try {
      await api(`/transactions/${pair.id}/dismiss-duplicate`, { method: 'PATCH' });
      setPairs((prev) => prev.filter((p) => p.id !== pair.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  // Same delete call/label used for a single transaction on the pay-period
  // page (PeriodDetail.jsx's deleteTxn: DELETE /transactions/:id, button
  // aria-label "Delete transaction") — reused here, not reimplemented.
  const deleteTxn = async (pair, id) => {
    setError(null);
    setBusyId(id);
    try {
      await api(`/transactions/${id}`, { method: 'DELETE' });
      setPairs((prev) => prev.filter((p) => p.id !== pair.id));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusyId(null);
    }
  };

  // The base "Delete transaction" label is reused from PeriodDetail.jsx's
  // deleteTxn button, but there it's never visible next to a second,
  // identical delete button — here two sit side by side in the same small
  // table, both representing the transaction the user is choosing between.
  // The accessible name has to carry that row's own date/description/amount
  // so a screen-reader user knows which one they're about to delete.
  const side = (pair, id, date, description, type, amountCents, disabled, onDelete) => {
    const amountLabel = `${type === 'expense' ? '−' : ''}${fmtMoney(amountCents, currency)}`;
    return (
      <tr>
        <td>{fmtDate(date)}</td>
        <td>{description || <span className="muted">—</span>}</td>
        <td className={`num ${type === 'expense' ? 'amount-neg' : ''}`}>
          {amountLabel}
        </td>
        <td className="center">
          <button
            className="btn btn-ghost btn-small"
            aria-label={`Delete transaction: ${fmtDate(date)}, ${description || 'no description'}, ${amountLabel}`}
            disabled={disabled}
            onClick={onDelete}
          >✕</button>
        </td>
      </tr>
    );
  };

  return (
    <section className="card">
      <h2>Possible duplicates</h2>
      <p className="muted">
        These look like the same transaction entered from two different sources. Keep both, or delete one below.
      </p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dupe-list">
        {pairs.map((pair) => {
          const pairBusy = busyId === pair.id || busyId === pair.original_id;
          return (
            <div className="dupe-pair" key={pair.id}>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">Date</th>
                      <th scope="col">Description</th>
                      <th scope="col" className="num">Amount</th>
                      <th scope="col"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {side(
                      pair, pair.id, pair.date, pair.description, pair.type, pair.amount_cents,
                      pairBusy, () => deleteTxn(pair, pair.id)
                    )}
                    {side(
                      pair, pair.original_id, pair.original_date, pair.original_description,
                      pair.original_type, pair.original_amount_cents,
                      pairBusy, () => deleteTxn(pair, pair.original_id)
                    )}
                  </tbody>
                </table>
              </div>
              <div className="dupe-pair-actions">
                <button
                  className="btn btn-ghost btn-small"
                  disabled={pairBusy}
                  onClick={() => dismiss(pair)}
                >Not a duplicate</button>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
