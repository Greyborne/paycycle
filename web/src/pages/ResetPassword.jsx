import React, { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';

export default function ResetPassword() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (newPassword !== confirmPassword) {
      setError("New passwords don't match");
      return;
    }
    setBusy(true);
    try {
      await api('/auth/reset', { method: 'POST', body: { token, newPassword } });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="auth-card card">
        <h1 className="brand brand-lg">Pay<span>Cycle</span></h1>
        <p className="muted">Choose a new password.</p>
        {!token ? (
          <p className="form-error" role="alert">This reset link is missing its token.</p>
        ) : done ? (
          <p className="form-ok" role="status">Your password has been changed.</p>
        ) : (
          <form onSubmit={submit}>
            <label>
              New password
              <input
                type="password" autoComplete="new-password"
                value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
                required minLength={8} autoFocus
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password" autoComplete="new-password"
                value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
                required minLength={8}
              />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>Reset password</button>
          </form>
        )}
        <p className="muted small"><Link to="/login">Back to sign in</Link></p>
      </div>
    </div>
  );
}
