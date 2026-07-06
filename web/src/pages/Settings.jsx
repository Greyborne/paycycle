import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { centsToInput, parseMoney } from '../format.js';
import { CadenceFields, cadenceBody } from './Onboarding.jsx';
import HouseholdCard from '../components/HouseholdCard.jsx';
import AccountsCard from '../components/AccountsCard.jsx';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN', 'INR', 'ZAR'];

export default function Settings() {
  const { refreshUser } = useAuth();
  const [loaded, setLoaded] = useState(false);
  const [currency, setCurrency] = useState('USD');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [emailNotifications, setEmailNotifications] = useState(false);
  const [low, setLow] = useState('');
  const [healthy, setHealthy] = useState('');
  const [warning, setWarning] = useState('');
  const [cadenceForm, setCadenceForm] = useState(null);
  const [changeCadence, setChangeCadence] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api('/settings').then(({ user, payPeriodConfig, emailEnabled: enabled }) => {
      setCurrency(user.currency);
      setEmailEnabled(enabled);
      setEmailNotifications(user.emailNotifications);
      setLow(centsToInput(user.thresholdLowCents));
      setHealthy(centsToInput(user.thresholdHealthyCents));
      setWarning(centsToInput(user.warningThresholdCents));
      setCadenceForm({
        cadence: payPeriodConfig.cadence,
        anchorDate: payPeriodConfig.anchorDate || '',
        intervalDays: payPeriodConfig.intervalDays || 10,
        day1: payPeriodConfig.day1 || 1,
        day2: payPeriodConfig.day2 || 15,
      });
      setLoaded(true);
    });
  }, []);

  if (!loaded) return <div className="page-loading">Loading…</div>;

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
        warningThresholdCents: parseMoney(warning) ?? 0,
      };
      if (changeCadence) Object.assign(body, cadenceBody(cadenceForm));
      await api('/settings', { method: 'PUT', body });
      await refreshUser();
      setMessage('Settings saved.');
      setChangeCadence(false);
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <div className="settings-page">
      <h1>Settings</h1>
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
            Balances are color-coded: <strong>red</strong> below zero, <strong>pink</strong> up to the
            “thin” threshold, <strong>light blue</strong> up to the “healthy” threshold, <strong>solid
            blue</strong> above it. Tune these to your own risk tolerance.
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

        <section className="card">
          <h2>Pay schedule</h2>
          {!changeCadence ? (
            <div className="cadence-summary">
              <span className="muted">
                {cadenceForm.cadence === 'custom' ? `Every ${cadenceForm.intervalDays} days` : cadenceForm.cadence}
                {cadenceForm.cadence === 'semimonthly' && ` (days ${cadenceForm.day1} & ${cadenceForm.day2})`}
                {cadenceForm.cadence === 'monthly' && ` (day ${cadenceForm.day1})`}
              </span>
              <button type="button" className="btn btn-ghost" onClick={() => setChangeCadence(true)}>Change…</button>
            </div>
          ) : (
            <>
              <p className="muted small">
                Existing recorded periods are kept as-is; the new schedule applies from your next period forward.
              </p>
              <CadenceFields form={cadenceForm} setForm={setCadenceForm} />
              <button type="button" className="btn btn-ghost" onClick={() => setChangeCadence(false)}>Cancel schedule change</button>
            </>
          )}
        </section>

        {error && <p className="form-error" role="alert">{error}</p>}
        {message && <p className="form-ok" role="status">{message}</p>}
        <button className="btn btn-primary">Save settings</button>
      </form>
      <AccountsCard />
      <HouseholdCard />
    </div>
  );
}
