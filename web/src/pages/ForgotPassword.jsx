import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';

export default function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/auth/forgot', { method: 'POST', body: { email } });
      setSent(true);
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
        <p className="muted">Reset your password.</p>
        {sent ? (
          <p className="form-ok" role="status">
            If an account exists for that email, we've sent a reset link.
          </p>
        ) : (
          <form onSubmit={submit}>
            <label>
              Email
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-block" disabled={busy}>Send reset link</button>
          </form>
        )}
        <p className="muted small"><Link to="/login">Back to sign in</Link></p>
      </div>
    </div>
  );
}
