import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { fmtDate } from '../format.js';

export default function Admin() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [message, setMessage] = useState(null);

  // Per-row delete-confirmation state, keyed by user id. `stage` is
  // 'confirm' (initial "are you sure") or 'strong' (server said this would
  // wipe the target's whole household — needs an explicit re-confirm).
  const [activeId, setActiveId] = useState(null);
  const [stage, setStage] = useState('confirm');
  const [rowError, setRowError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api('/admin/users')
      .then((d) => setUsers(d.users))
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => { load(); }, [load]);

  const startDelete = (id) => {
    setActiveId(id);
    setStage('confirm');
    setRowError(null);
    setMessage(null);
    setActionError(null);
  };

  const cancelDelete = () => {
    setActiveId(null);
    setStage('confirm');
    setRowError(null);
    setBusy(false);
  };

  const [resetBusyId, setResetBusyId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const sendReset = async (user) => {
    setResetBusyId(user.id);
    setActionError(null);
    setMessage(null);
    try {
      await api(`/admin/users/${user.id}/send-reset`, { method: 'POST' });
      setMessage(`Reset email sent to ${user.email}.`);
    } catch (err) {
      setActionError(err.message);
    } finally {
      setResetBusyId(null);
    }
  };

  const runDelete = async (user, confirm) => {
    setBusy(true);
    setRowError(null);
    setActionError(null);
    try {
      await api(`/admin/users/${user.id}`, { method: 'DELETE', body: { confirm: !!confirm } });
      setActiveId(null);
      setStage('confirm');
      setMessage(`${user.email} was deleted.`);
      load();
    } catch (err) {
      if (err.status === 409) {
        setStage('strong');
        setRowError(err.message);
      } else {
        setRowError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  if (error) return <p className="form-error" role="alert">{error}</p>;
  if (!users) return <div className="page-loading">Loading…</div>;

  return (
    <div className="admin-page">
      <section className="card">
        <h2>Users</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Household</th>
              <th>Role</th>
              <th className="num">Members</th>
              <th>Created</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>
                  {u.email}
                  {u.isSelf && <span className="muted small"> (you)</span>}
                  {u.isAdmin && <> <span className="badge badge-current">Admin</span></>}
                </td>
                <td>{u.household ?? <span className="muted">—</span>}</td>
                <td>{u.role ?? <span className="muted">—</span>}</td>
                <td className="num">{u.householdSize ?? <span className="muted">—</span>}</td>
                <td>{fmtDate(String(u.createdAt).slice(0, 10))}</td>
                <td className="center">
                  <button
                    type="button"
                    className="btn btn-ghost btn-small"
                    disabled={resetBusyId === u.id}
                    onClick={() => sendReset(u)}
                    aria-label={`Send reset email to ${u.email}`}
                  >
                    {resetBusyId === u.id ? 'Sending…' : 'Send reset email'}
                  </button>
                  {' '}
                  {u.isSelf || u.isAdmin ? (
                    <span className="muted">—</span>
                  ) : activeId !== u.id ? (
                    <button type="button" className="btn btn-ghost btn-small" onClick={() => startDelete(u.id)} aria-label={`Delete ${u.email}`}>
                      Delete
                    </button>
                  ) : stage === 'confirm' ? (
                    <div className="cancel-confirm" role="group" aria-label={`Delete ${u.email}`}>
                      <span className="muted small">Delete {u.email}? This can&apos;t be undone.</span>
                      <div>
                        <button type="button" className="btn btn-ghost" disabled={busy} onClick={cancelDelete}>
                          Cancel
                        </button>
                        <button
                          type="button" className="btn btn-primary" disabled={busy}
                          onClick={() => runDelete(u, false)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="warning-banner">
                      <div className="cancel-confirm" role="group" aria-label={`Confirm deleting ${u.email}'s household`}>
                        <strong className="form-error" role="alert">{rowError}</strong>
                        <div>
                          <button type="button" className="btn btn-ghost" disabled={busy} onClick={cancelDelete}>
                            Cancel
                          </button>
                          <button
                            type="button" className="btn btn-primary" disabled={busy}
                            onClick={() => runDelete(u, true)}
                          >
                            Yes, delete everything
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {activeId === u.id && stage === 'confirm' && rowError && (
                    <p className="form-error" role="alert">{rowError}</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {message && <p className="form-ok" role="status">{message}</p>}
        {actionError && <p className="form-error" role="alert">{actionError}</p>}
      </section>
    </div>
  );
}
