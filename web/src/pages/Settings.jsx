import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { centsToInput, parseMoney } from '../format.js';
import { CadenceFields, cadenceBody } from './Onboarding.jsx';
import { THEME_MODES, useTheme } from '../App.jsx';
import HouseholdCard from '../components/HouseholdCard.jsx';
import AccountsCard from '../components/AccountsCard.jsx';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN', 'INR', 'ZAR'];

export default function Settings() {
  const { refreshUser } = useAuth();
  const { themeMode, setThemeMode } = useTheme();
  const [loaded, setLoaded] = useState(false);
  const [currency, setCurrency] = useState('USD');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailNotifications, setEmailNotifications] = useState(false);
  const [low, setLow] = useState('');
  const [healthy, setHealthy] = useState('');
  const [warning, setWarning] = useState('');
  const [drift, setDrift] = useState('5.00');
  const [payPeriodConfigs, setPayPeriodConfigs] = useState(null);
  const [editingAccountId, setEditingAccountId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState(null);
  const [scheduleMessage, setScheduleMessage] = useState(null);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState(null);
  const [passwordMessage, setPasswordMessage] = useState(null);
  const [passwordSubmitting, setPasswordSubmitting] = useState(false);

  // Focus management for the per-account schedule editor: expanding/collapsing
  // a row swaps the "Change…" button for the CadenceFields/Cancel/Save markup
  // (or back), which unmounts whatever was focused — without explicit handling
  // the browser drops focus to <body>. `scheduleSectionRef` lets us reach into
  // the just-rendered CadenceFields to focus its first field on open;
  // `triggerRefs`/`headingRefs` remember each account's "Change…" button and
  // heading so we can restore focus to a stable, guaranteed-present element on
  // close (same idiom as PeriodDetail.jsx's returnFocus / RuleDrawer.jsx's
  // triggerRefs Map in Transactions.jsx).
  const scheduleSectionRef = useRef(null);
  const sectionHeadingRef = useRef(null);
  const triggerRefs = useRef(new Map());
  const headingRefs = useRef(new Map());
  const prevEditingAccountId = useRef(null);

  const returnFocusToTrigger = (accountId) => {
    const btn = triggerRefs.current.get(accountId);
    if (btn && btn.isConnected) { btn.focus(); return; }
    const heading = headingRefs.current.get(accountId);
    if (heading && heading.isConnected) { heading.focus(); return; }
    sectionHeadingRef.current?.focus();
  };

  // Runs after every render where editingAccountId changed. Since the row's
  // markup swap happens in the same render as the state change, by the time
  // this effect runs the new markup (CadenceFields on open, the "Change…"
  // button on close) is already committed to the DOM, so a plain focus() call
  // here — no rAF needed — lands on it instead of <body>.
  useEffect(() => {
    const prev = prevEditingAccountId.current;
    if (editingAccountId != null) {
      const firstField = scheduleSectionRef.current?.querySelector('.cadence-options input');
      firstField?.focus();
    } else if (prev != null) {
      returnFocusToTrigger(prev);
    }
    prevEditingAccountId.current = editingAccountId;
  }, [editingAccountId]);

  useEffect(() => {
    api('/settings').then(({ user, payPeriodConfigs, emailEnabled: enabled }) => {
      setCurrency(user.currency);
      setEmailEnabled(enabled);
      setEmailNotifications(user.emailNotifications);
      setLow(centsToInput(user.thresholdLowCents));
      setHealthy(centsToInput(user.thresholdHealthyCents));
      setWarning(centsToInput(user.warningThresholdCents));
      setDrift(centsToInput(user.driftThresholdCents ?? 500));
      setPayPeriodConfigs(payPeriodConfigs);
      setLoaded(true);
    });
  }, []);

  if (!loaded) return <div className="page-loading">Loading…</div>;

  const startEditSchedule = (config) => {
    setScheduleError(null);
    setScheduleMessage(null);
    setEditingAccountId(config.accountId);
    setEditForm({
      cadence: config.cadence,
      anchorDate: config.anchorDate || '',
      intervalDays: config.intervalDays || 10,
      day1: config.day1 || 1,
      day2: config.day2 || 15,
    });
  };

  const cancelEditSchedule = () => {
    setEditingAccountId(null);
    setEditForm(null);
  };

  const saveSchedule = async (accountId) => {
    setScheduleSaving(true);
    setScheduleError(null);
    try {
      const { payPeriodConfigs: updated } = await api(`/settings/schedule/${accountId}`, {
        method: 'PUT', body: cadenceBody(editForm),
      });
      setPayPeriodConfigs(updated);
      setEditingAccountId(null);
      setEditForm(null);
      setScheduleMessage('Pay schedule saved.');
    } catch (err) {
      setScheduleError(err.message);
    } finally {
      setScheduleSaving(false);
    }
  };

  const cadenceSummary = (config) => (
    <>
      {config.cadence === 'custom' ? `Every ${config.intervalDays} days` : config.cadence}
      {config.cadence === 'semimonthly' && ` (days ${config.day1} & ${config.day2})`}
      {config.cadence === 'monthly' && ` (day ${config.day1})`}
    </>
  );

  const save = async (e) => {
    e.preventDefault();
    setMessage(null);
    setError(null);
    try {
      const body = {
        currency,
        emailNotifications,
        thresholdLowCents: parseMoney(low) ?? 0,
        thresholdHealthyCents: parseMoney(healthy) ?? 0,
        driftThresholdCents: parseMoney(drift) ?? 500,
        warningThresholdCents: parseMoney(warning) ?? 0,
      };
      await api('/settings', { method: 'PUT', body });
      await refreshUser();
      setMessage('Settings saved.');
    } catch (err) {
      setError(err.message);
    }
  };

  const changePassword = async (e) => {
    e.preventDefault();
    setPasswordError(null);
    setPasswordMessage(null);
    if (newPassword !== confirmPassword) {
      setPasswordError("New passwords don't match");
      return;
    }
    setPasswordSubmitting(true);
    try {
      await api('/auth/password', { method: 'POST', body: { currentPassword, newPassword } });
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setPasswordMessage('Password changed.');
    } catch (err) {
      setPasswordError(err.message);
    } finally {
      setPasswordSubmitting(false);
    }
  };

  return (
    <div className="settings-page">
      <form onSubmit={save}>
        <section className="card">
          <h2>Money</h2>
          <div className="field-row">
            <label>
              Currency
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
          </div>
          <p className="muted small">Starting balances are set per bank account below.</p>
        </section>

        <section className="card">
          <h2>Balance health colors</h2>
          <p className="muted small">
            Balances are color-coded: <strong>red</strong> below zero, <strong>amber</strong> up to the
            “thin” threshold, <strong>blue</strong> up to the “healthy” threshold, <strong>green</strong>{' '}
            above it. Tune these to your own risk tolerance.
          </p>
          <div className="field-row">
            <label>
              “Thin” threshold
              <input type="text" inputMode="decimal" value={low} onChange={(e) => setLow(e.target.value)} />
            </label>
            <label>
              “Healthy” threshold
              <input type="text" inputMode="decimal" value={healthy} onChange={(e) => setHealthy(e.target.value)} />
            </label>
            <label>
              Projection warning threshold
              <input
                type="text" inputMode="decimal" value={warning} onChange={(e) => setWarning(e.target.value)}
                title="Flag the first future period projected below this amount (0 = only flag negative)"
              />
            </label>
            <label>
              Drift alert threshold
              <input
                type="text" inputMode="decimal" value={drift} onChange={(e) => setDrift(e.target.value)}
                title="Suggest updating a recurring plan when a transaction differs from it by more than this (or 5%, whichever is larger)"
              />
            </label>
          </div>
        </section>

        <section className="card">
          <h2>Appearance</h2>
          <p className="muted small">
            Choose light or dark, or follow your device setting. This is stored on this browser only.
          </p>
          <div className="range-picker" role="group" aria-label="Theme">
            {THEME_MODES.map((m) => (
              <button
                key={m}
                type="button"
                className={`btn btn-ghost ${themeMode === m ? 'active' : ''}`}
                onClick={() => setThemeMode(m)}
              >
                {m[0].toUpperCase() + m.slice(1)}
              </button>
            ))}
          </div>
        </section>

        <section className="card">
          <h2>Notifications</h2>
          {emailEnabled ? (
            <label className="toggle-archived">
              <input
                type="checkbox" checked={emailNotifications}
                onChange={(e) => setEmailNotifications(e.target.checked)}
              />
              Email me new notifications (bills due, projection warnings) at my account address
            </label>
          ) : (
            <p className="muted small">
              In-app notifications are always on (the bell in the header). To also receive them by
              email, the server admin needs to configure SMTP — see the README.
            </p>
          )}
        </section>

        <section className="card" ref={scheduleSectionRef}>
          <h2 ref={sectionHeadingRef} tabIndex={-1}>Pay schedule</h2>
          {payPeriodConfigs.length === 1 ? (
            editingAccountId === payPeriodConfigs[0].accountId ? (
              <>
                <p className="muted small">
                  Existing recorded periods are kept as-is; the new schedule applies from your next period forward.
                </p>
                <CadenceFields form={editForm} setForm={setEditForm} />
                <div className="editor-actions">
                  <button type="button" className="btn btn-ghost" onClick={cancelEditSchedule}>Cancel</button>
                  <button
                    type="button" className="btn btn-primary" disabled={scheduleSaving}
                    onClick={() => saveSchedule(payPeriodConfigs[0].accountId)}
                  >
                    Save schedule
                  </button>
                </div>
              </>
            ) : (
              <div className="cadence-summary">
                <span className="muted">{cadenceSummary(payPeriodConfigs[0])}</span>
                <button
                  type="button" className="btn btn-ghost"
                  ref={(el) => {
                    if (el) triggerRefs.current.set(payPeriodConfigs[0].accountId, el);
                    else triggerRefs.current.delete(payPeriodConfigs[0].accountId);
                  }}
                  onClick={() => startEditSchedule(payPeriodConfigs[0])}
                >
                  Change…
                </button>
              </div>
            )
          ) : (
            payPeriodConfigs.map((config) => (
              <React.Fragment key={config.accountId}>
                <h3
                  tabIndex={-1}
                  ref={(el) => {
                    if (el) headingRefs.current.set(config.accountId, el);
                    else headingRefs.current.delete(config.accountId);
                  }}
                >
                  {config.accountName}
                </h3>
                {editingAccountId === config.accountId ? (
                  <>
                    <p className="muted small">
                      Existing recorded periods are kept as-is; the new schedule applies from your next period forward.
                    </p>
                    <CadenceFields form={editForm} setForm={setEditForm} />
                    <div className="editor-actions">
                      <button type="button" className="btn btn-ghost" onClick={cancelEditSchedule}>Cancel</button>
                      <button
                        type="button" className="btn btn-primary" disabled={scheduleSaving}
                        onClick={() => saveSchedule(config.accountId)}
                      >
                        Save schedule
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="cadence-summary">
                    <span className="muted">{cadenceSummary(config)}</span>
                    <button
                      type="button" className="btn btn-ghost"
                      aria-label={`Change ${config.accountName} pay schedule`}
                      ref={(el) => {
                        if (el) triggerRefs.current.set(config.accountId, el);
                        else triggerRefs.current.delete(config.accountId);
                      }}
                      onClick={() => startEditSchedule(config)}
                    >
                      Change…
                    </button>
                  </div>
                )}
              </React.Fragment>
            ))
          )}
          {scheduleError && <p className="form-error" role="alert">{scheduleError}</p>}
          {scheduleMessage && <p className="form-ok" role="status">{scheduleMessage}</p>}
        </section>

        {error && <p className="form-error" role="alert">{error}</p>}
        {message && <p className="form-ok" role="status">{message}</p>}
        <button className="btn btn-primary">Save settings</button>
      </form>

      <section className="card">
        <h2>Password</h2>
        <form onSubmit={changePassword}>
          <div className="field-row">
            <label>
              Current password
              <input
                type="password" autoComplete="current-password"
                value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)}
              />
            </label>
            <label>
              New password
              <input
                type="password" autoComplete="new-password"
                value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
              />
            </label>
            <label>
              Confirm new password
              <input
                type="password" autoComplete="new-password"
                value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </label>
          </div>
          {passwordError && <p className="form-error" role="alert">{passwordError}</p>}
          {passwordMessage && <p className="form-ok" role="status">{passwordMessage}</p>}
          <button className="btn btn-primary" disabled={passwordSubmitting}>Change password</button>
        </form>
      </section>

      <AccountsCard />
      <HouseholdCard />
    </div>
  );
}
