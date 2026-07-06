import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';

export default function Login() {
  const { setUser } = useAuth();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [mode, setMode] = useState('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [error, setError] = useState(searchParams.get('error'));
  const [busy, setBusy] = useState(false);
  const [serverConfig, setServerConfig] = useState({ registrationOpen: true, oidc: { enabled: false } });

  useEffect(() => {
    api('/auth/config').then(setServerConfig).catch(() => {});
  }, []);

  const registrationOpen = serverConfig.registrationOpen;
  const oidc = serverConfig.oidc;
  const ssoHref = `/api/auth/oidc/start${inviteCode.trim() ? `?invite=${encodeURIComponent(inviteCode.trim())}` : ''}`;

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
        {oidc.enabled && (
          <>
            <div className="sso-divider muted small">or</div>
            <a className="btn btn-block sso-btn" href={ssoHref}>
              Continue with {oidc.name}
            </a>
            {mode === 'register' && inviteCode.trim() && (
              <p className="muted small">Your invite code will be applied to the {oidc.name} sign-in too.</p>
            )}
          </>
        )}
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
