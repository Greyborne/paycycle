import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { fmtDate } from '../format.js';

export default function HouseholdCard() {
  const { user, refreshUser } = useAuth();
  const [data, setData] = useState(null);
  const [name, setName] = useState('');
  const [joinCode, setJoinCode] = useState('');
  const [needsConfirm, setNeedsConfirm] = useState(false);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  const load = useCallback(async () => {
    const d = await api('/household');
    setData(d);
    setName(d.name);
  }, []);

  useEffect(() => { load(); }, [load]);

  if (!data) return null;
  const isOwner = data.role === 'owner';

  const act = async (fn, okMessage) => {
    setError(null);
    setMessage(null);
    try {
      await fn();
      await load();
      await refreshUser();
      if (okMessage) setMessage(okMessage);
    } catch (err) {
      setError(err.message);
    }
  };

  const rename = () => act(async () => {
    if (name.trim() && name.trim() !== data.name) {
      await api('/household', { method: 'PATCH', body: { name: name.trim() } });
    }
  }, 'Household renamed.');

  const createInvite = () => act(
    () => api('/household/invites', { method: 'POST' }),
    'Invite code created — share it with the person joining.'
  );

  const join = async () => {
    setError(null);
    setMessage(null);
    try {
      await api('/household/join', { method: 'POST', body: { code: joinCode, confirm: needsConfirm } });
      setJoinCode('');
      setNeedsConfirm(false);
      await refreshUser();
      await load();
      setMessage('Joined household.');
    } catch (err) {
      if (err.status === 409) {
        setNeedsConfirm(true);
        setError(`${err.message}. Click "Join household" again to confirm.`);
      } else {
        setError(err.message);
      }
    }
  };

  return (
    <section className="card">
      <h2>Household</h2>
      <p className="muted small">
        Everyone in the household shares this budget — same periods, categories, and balances.
      </p>

      <label>
        Household name
        <div className="quick-add">
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 1 }} />
          <button type="button" className="btn btn-ghost" onClick={rename} disabled={!name.trim() || name.trim() === data.name}>
            Rename
          </button>
        </div>
      </label>

      <h3>Members</h3>
      <table className="table">
        <thead>
          <tr><th>Email</th><th>Role</th><th>Joined</th><th /></tr>
        </thead>
        <tbody>
          {data.members.map((m) => (
            <tr key={m.id}>
              <td>{m.email}{m.id === user.id && <span className="muted small"> (you)</span>}</td>
              <td>{m.role}</td>
              <td>{fmtDate(m.joinedAt.slice(0, 10))}</td>
              <td className="center">
                {isOwner && m.id !== user.id && (
                  <button
                    type="button" className="btn btn-ghost btn-small"
                    onClick={() => {
                      if (window.confirm(`Remove ${m.email}? They'll get a fresh empty budget of their own.`)) {
                        act(() => api(`/household/members/${m.id}`, { method: 'DELETE' }), 'Member removed.');
                      }
                    }}
                  >
                    Remove
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {isOwner && (
        <>
          <h3>Invites</h3>
          {data.invites.length === 0 && <p className="muted small">No active invite codes.</p>}
          {data.invites.map((inv) => (
            <div key={inv.id} className="quick-add">
              <code className="invite-code">{inv.code}</code>
              <span className="muted small">expires {fmtDate(inv.expiresAt.slice(0, 10))}</span>
              <button
                type="button" className="btn btn-ghost btn-small"
                onClick={() => navigator.clipboard?.writeText(inv.code).then(() => setMessage('Code copied.'))}
              >
                Copy
              </button>
              <button
                type="button" className="btn btn-ghost btn-small"
                onClick={() => act(() => api(`/household/invites/${inv.id}`, { method: 'DELETE' }), 'Invite revoked.')}
              >
                Revoke
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={createInvite}>+ New invite code</button>
          <p className="muted small">
            Codes last 7 days. New people can enter one when creating their account (this works even
            if registration is disabled), and existing users can enter one below.
          </p>
        </>
      )}

      <h3>Move households</h3>
      {data.members.length > 1 && (
        <p>
          <button
            type="button" className="btn btn-ghost"
            onClick={() => {
              if (window.confirm('Leave this household? You will get a fresh empty budget of your own.')) {
                act(() => api('/household/leave', { method: 'POST' }), 'You left the household.');
              }
            }}
          >
            Leave this household
          </button>
        </p>
      )}
      <div className="quick-add">
        <input
          type="text" value={joinCode} onChange={(e) => { setJoinCode(e.target.value); setNeedsConfirm(false); }}
          placeholder="Invite code" aria-label="Invite code"
        />
        <button type="button" className="btn btn-ghost" disabled={!joinCode.trim()} onClick={join}>
          Join household
        </button>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}
      {message && <p className="form-ok" role="status">{message}</p>}
    </section>
  );
}
