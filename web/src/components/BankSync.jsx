import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAccounts } from '../useAccounts.js';
import { fmtDate } from '../format.js';

const PLAID_SCRIPT = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

function loadPlaidScript() {
  return new Promise((resolve, reject) => {
    if (window.Plaid) return resolve();
    const el = document.createElement('script');
    el.src = PLAID_SCRIPT;
    el.onload = resolve;
    el.onerror = () => reject(new Error('Could not load Plaid Link'));
    document.head.appendChild(el);
  });
}

// Live bank sync via Plaid. Hidden entirely unless the server has Plaid
// credentials configured. Synced transactions reuse the import pipeline:
// duplicate-safe, auto-categorized by learned rules, rule matches clear the
// period's line item.
export default function BankSync() {
  const { base: baseAccounts } = useAccounts();
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setStatus(await api('/plaid/status'));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!status?.enabled) return null;

  const connect = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { linkToken } = await api('/plaid/link-token', { method: 'POST' });
      await loadPlaidScript();
      const handler = window.Plaid.create({
        token: linkToken,
        onSuccess: async (publicToken, metadata) => {
          try {
            await api('/plaid/exchange', {
              method: 'POST',
              body: { publicToken, institutionName: metadata?.institution?.name },
            });
            setMessage('Bank connected — choose which PayCycle account each bank account syncs into, then hit Sync.');
            await load();
          } catch (err) {
            setError(err.message);
          } finally {
            setBusy(false);
          }
        },
        onExit: () => setBusy(false),
      });
      handler.open();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  const setMapping = async (linkId, accountId) => {
    setError(null);
    try {
      await api(`/plaid/links/${linkId}`, {
        method: 'PATCH',
        body: { accountId: accountId ? Number(accountId) : null },
      });
      await load();
    } catch (err) {
      setError(err.message);
    }
  };

  const sync = async () => {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await api('/plaid/sync', { method: 'POST' });
      if (r.notReady) {
        setMessage('The bank is still preparing transaction history — try again in a minute.');
      } else {
        setMessage(
          `Sync complete: ${r.added} new, ${r.cleared} line items cleared, ${r.updated} updated, ` +
          `${r.removed} removed${r.duplicates ? `, ${r.duplicates} already imported` : ''}` +
          `${r.skipped ? `, ${r.skipped} outside your recorded periods` : ''}.`
        );
      }
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (itemId) => {
    if (!window.confirm('Disconnect this bank? Already-synced transactions stay in your budget.')) return;
    await api(`/plaid/items/${itemId}`, { method: 'DELETE' });
    load();
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Bank sync</h2>
        {status.environment !== 'production' && (
          <span className="badge health-none">{status.environment} mode</span>
        )}
      </div>
      <p className="muted small">
        Connect your bank through Plaid and pull posted transactions straight into your budget.
        Learned import rules categorize them automatically; matched bills are marked cleared.
      </p>

      {status.items.map((item) => (
        <div key={item.id} className="plaid-item">
          <div className="card-head">
            <strong>{item.institution}</strong>
            <span className="muted small">
              {item.lastSyncedAt ? `last synced ${fmtDate(item.lastSyncedAt.slice(0, 10))}` : 'never synced'}
              {' '}
              <button className="btn btn-ghost btn-small" onClick={() => unlink(item.id)}>Disconnect</button>
            </span>
          </div>
          {item.accounts.map((a) => (
            <div key={a.id} className="quick-add">
              <span className="plaid-account-name">
                {a.name}{a.mask ? ` ••${a.mask}` : ''}
              </span>
              <span className="muted small">syncs into</span>
              <select value={a.accountId ?? ''} onChange={(e) => setMapping(a.id, e.target.value)}>
                <option value="">Not synced</option>
                {baseAccounts.map((acct) => (
                  <option key={acct.id} value={acct.id}>{acct.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ))}

      <div className="quick-add">
        <button className="btn btn-primary" disabled={busy} onClick={connect}>
          {status.items.length ? '+ Connect another bank' : 'Connect a bank'}
        </button>
        {status.items.some((i) => i.accounts.some((a) => a.accountId)) && (
          <button className="btn btn-primary" disabled={busy} onClick={sync}>Sync now</button>
        )}
      </div>
      {message && <p className="form-ok" role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
