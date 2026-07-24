import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAccounts } from '../useAccounts.js';
import { fmtDate } from '../format.js';

const TOKEN_HELP_ID = 'simplefin-token-help';

// Live bank sync via SimpleFIN Bridge. Opt-in via BANK_SYNC_ENABLED - the
// card renders nothing until /simplefin/status reports enabled: true. Synced
// transactions reuse the import pipeline: duplicate-safe, auto-categorized by
// learned rules, rule matches clear the period's line item.
export default function BankSync() {
  const { base: baseAccounts } = useAccounts();
  const [status, setStatus] = useState(null);
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setStatus(await api('/simplefin/status'));
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!status || !status.enabled) return null;

  const connect = async (e) => {
    e.preventDefault();
    const trimmed = setupToken.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api('/simplefin/claim', { method: 'POST', body: { setupToken: trimmed } });
      setSetupToken('');
      setMessage('Bank connected — choose which PayCycle account each bank account syncs into, then hit Sync.');
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const setMapping = async (linkId, accountId) => {
    setError(null);
    try {
      await api(`/simplefin/links/${linkId}`, {
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
      const r = await api('/simplefin/sync', { method: 'POST' });
      setMessage(
        `Sync complete: ${r.added} new, ${r.cleared} line items cleared, ${r.updated} updated` +
        `${r.duplicates ? `, ${r.duplicates} already imported` : ''}` +
        `${r.replanned ? `, ${r.replanned} recurring plan(s) updated going forward` : ''}` +
        `${r.skipped ? `, ${r.skipped} outside your recorded periods` : ''}.`
      );
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const unlink = async (connectionId) => {
    if (!window.confirm('Disconnect this bank? Already-synced transactions stay in your budget.')) return;
    await api(`/simplefin/connections/${connectionId}`, { method: 'DELETE' });
    load();
  };

  const hasConnections = status.connections.length > 0;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Bank sync</h2>
      </div>
      <p className="muted small">
        Connect your bank through SimpleFIN and pull posted transactions straight into
        your budget. Learned import rules categorize them automatically; matched bills
        are marked cleared.
      </p>

      {status.connections.map((connection) => (
        <div key={connection.id} className="bank-connection">
          <div className="card-head">
            <strong>{connection.label}</strong>
            <span className="muted small">
              {connection.lastSyncedAt ? `last synced ${fmtDate(connection.lastSyncedAt.slice(0, 10))}` : 'never synced'}
              {' '}
              <button className="btn btn-ghost btn-small" onClick={() => unlink(connection.id)}>Disconnect</button>
            </span>
          </div>
          {connection.accounts.map((a) => (
            <div key={a.id} className="quick-add">
              <span className="bank-account-name">
                {a.name}{a.org ? ` · ${a.org}` : ''}
              </span>
              <span className="muted small">syncs into</span>
              <select
                value={a.accountId ?? ''}
                onChange={(e) => setMapping(a.id, e.target.value)}
                aria-label={`Account for ${a.name}`}
              >
                <option value="">Not synced</option>
                {baseAccounts.map((acct) => (
                  <option key={acct.id} value={acct.id}>{acct.name}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      ))}

      {!hasConnections && (
        <p className="muted small" id={TOKEN_HELP_ID}>
          Get a setup token from your SimpleFIN Bridge account, then paste it below. The
          token is used once and never stored — PayCycle keeps only the access URL it
          returns, encrypted.
        </p>
      )}

      <form onSubmit={connect}>
        <label htmlFor="simplefin-setup-token">Setup token</label>
        <textarea
          id="simplefin-setup-token"
          className="mono-input"
          value={setupToken}
          onChange={(e) => setSetupToken(e.target.value)}
          aria-describedby={hasConnections ? undefined : TOKEN_HELP_ID}
          rows={3}
        />
        <div className="quick-add">
          <button className="btn btn-primary" type="submit" disabled={busy || !setupToken.trim()}>
            {hasConnections ? '+ Connect another bank' : 'Connect a bank'}
          </button>
        </div>
      </form>

      {status.connections.some((c) => c.accounts.some((a) => a.accountId)) && (
        <div className="quick-add">
          <button className="btn btn-primary" disabled={busy} onClick={sync}>Sync now</button>
        </div>
      )}
      {message && <p className="form-ok" role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  );
}
