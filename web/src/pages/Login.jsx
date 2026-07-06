import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

export default function Login() {
  const { setUser, registrationOpen } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const data = await api(`/auth/${mode === 'login' ? 'login' : 'register'}`, {
        method: 'POST',
        body: { email, password, inviteCode: mode === 'register' ? inviteCode.trim() || undefined : undefined },
      });
      setUser(data.user);
      navigate(data.user.onboardingComplete ? '/' : '/onboarding');
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
        <p className="muted">Pay-period budgeting with a planned-vs-actual balance you can trust.</p>
        <form onSubmit={submit}>
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <label>
            Password
            <input
              type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              required minLength={mode === 'register' ? 8 : undefined}
            />
          </label>
          {mode === 'register' && (
            <label>
              Household invite code <span className="muted">(optional)</span>
              <input
                type="text" value={inviteCode} onChange={(e) => setInviteCode(e.target.value)}
                placeholder="Joining someone's budget? Paste their code"
              />
            </label>
          )}
          {error && <p className="form-error" role="alert">{error}</p>}
          <button className="btn btn-primary btn-block" disabled={busy}>
            {mode === 'login' ? 'Sign in' : 'Create account'}
          </button>
        </form>
        {registrationOpen && (
          <button
            className="btn btn-ghost btn-block"
            onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(null); }}
          >
            {mode === 'login' ? 'New here? Create an account' : 'Have an account? Sign in'}
          </button>
        )}
      </div>
    </div>
  );
}
