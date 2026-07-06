import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { parseMoney, todayISO } from '../format.js';

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'NZD', 'JPY', 'CHF', 'SEK', 'NOK', 'DKK', 'PLN', 'BRL', 'MXN', 'INR', 'ZAR'];

const CADENCES = [
  { value: 'biweekly', label: 'Biweekly', hint: 'Every 14 days — the most common payroll schedule' },
  { value: 'weekly', label: 'Weekly', hint: 'Every 7 days' },
  { value: 'semimonthly', label: 'Semi-monthly', hint: 'Two fixed days per month, e.g. the 1st and the 15th' },
  { value: 'monthly', label: 'Monthly', hint: 'Once per month on a fixed day' },
  { value: 'custom', label: 'Custom interval', hint: 'Any fixed number of days' },
];

const SUGGESTED = [
  { name: 'Rent / Mortgage', type: 'expense', recurrence: 'monthly', dueDay: 1 },
  { name: 'Electric', type: 'expense', recurrence: 'monthly', dueDay: 5 },
  { name: 'Internet', type: 'expense', recurrence: 'monthly', dueDay: 15 },
  { name: 'Groceries', type: 'expense', recurrence: 'every_period' },
  { name: 'Gas / Transport', type: 'expense', recurrence: 'every_period' },
  { name: 'Paycheck', type: 'income', recurrence: 'every_period' },
];

export function CadenceFields({ form, setForm }) {
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });
  return (
    <>
      <div className="cadence-options">
        {CADENCES.map((c) => (
          <label key={c.value} className={`cadence-option ${form.cadence === c.value ? 'selected' : ''}`}>
            <input
              type="radio" name="cadence" value={c.value}
              checked={form.cadence === c.value}
              onChange={() => setForm({ ...form, cadence: c.value })}
            />
            <span>
              <strong>{c.label}</strong>
              <small className="muted">{c.hint}</small>
            </span>
          </label>
        ))}
      </div>
      <div className="cadence-detail">
        {(form.cadence === 'weekly' || form.cadence === 'biweekly' || form.cadence === 'custom') && (
          <label>
            First day of any pay period (e.g. your most recent payday)
            <input type="date" value={form.anchorDate} onChange={set('anchorDate')} required />
          </label>
        )}
        {form.cadence === 'custom' && (
          <label>
            Days per period
            <input type="number" min="2" max="185" value={form.intervalDays} onChange={set('intervalDays')} required />
          </label>
        )}
        {form.cadence === 'semimonthly' && (
          <div className="field-row">
            <label>
              First start day of month
              <input type="number" min="1" max="31" value={form.day1} onChange={set('day1')} required />
            </label>
            <label>
              Second start day of month
              <input type="number" min="1" max="31" value={form.day2} onChange={set('day2')} required />
            </label>
          </div>
        )}
        {form.cadence === 'monthly' && (
          <label>
            Start day of month
            <input type="number" min="1" max="31" value={form.day1} onChange={set('day1')} required />
          </label>
        )}
        {(form.cadence === 'semimonthly' || form.cadence === 'monthly') && (
          <p className="muted small">Days past a month&apos;s end (e.g. the 31st) fall back to the last day of that month.</p>
        )}
      </div>
    </>
  );
}

export function cadenceBody(form) {
  const body = { cadence: form.cadence };
  if (['weekly', 'biweekly', 'custom'].includes(form.cadence)) body.anchorDate = form.anchorDate;
  if (form.cadence === 'custom') body.intervalDays = Number(form.intervalDays);
  if (form.cadence === 'semimonthly') { body.day1 = Number(form.day1); body.day2 = Number(form.day2); }
  if (form.cadence === 'monthly') body.day1 = Number(form.day1);
  return body;
}

export default function Onboarding() {
  const { user, refreshUser } = useAuth();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    cadence: 'biweekly', anchorDate: todayISO(), intervalDays: 10, day1: 1, day2: 15,
  });
  const [balance, setBalance] = useState('');
  const [currency, setCurrency] = useState(user.currency || 'USD');
  const [cats, setCats] = useState(SUGGESTED.map((c) => ({ ...c, amount: '', include: true })));
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState(null);

  const setCat = (i, patch) => setCats(cats.map((c, j) => (j === i ? { ...c, ...patch } : c)));

  const join = async () => {
    setJoinError(null);
    try {
      await api('/household/join', { method: 'POST', body: { code: joinCode, confirm: true } });
      await refreshUser();
      navigate('/');
    } catch (err) {
      setJoinError(err.message);
    }
  };

  const finish = async (skipCategories) => {
    setBusy(true);
    setError(null);
    try {
      const categories = skipCategories ? [] : cats
        .filter((c) => c.include && c.name.trim())
        .map((c) => ({
          name: c.name.trim(),
          type: c.type,
          recurrence: c.recurrence,
          dueDay: c.recurrence === 'monthly' ? Number(c.dueDay) : undefined,
          amountCents: parseMoney(c.amount) ?? 0,
        }));
      await api('/setup', {
        method: 'POST',
        body: {
          ...cadenceBody(form),
          startingBalanceCents: parseMoney(balance) ?? 0,
          currency,
          categories,
        },
      });
      await refreshUser();
      navigate('/');
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="auth-page">
      <div className="card onboarding-card">
        <h1 className="brand brand-lg">Pay<span>Cycle</span></h1>
        <div className="steps muted small">Step {step + 1} of 3</div>

        {step === 0 && (
          <>
            <h2>How are you paid?</h2>
            <p className="muted">Your budget is organized around pay periods. You can change this later in Settings.</p>
            <CadenceFields form={form} setForm={setForm} />
            <div className="wizard-nav">
              <span />
              <button className="btn btn-primary" onClick={() => setStep(1)}>Continue</button>
            </div>
            <details className="join-household">
              <summary className="muted">Joining someone else&apos;s budget instead?</summary>
              <p className="muted small">
                Enter the invite code from their Settings page to share their household budget —
                you can skip the rest of this setup.
              </p>
              <div className="quick-add">
                <input
                  type="text" value={joinCode} onChange={(e) => setJoinCode(e.target.value)}
                  placeholder="Invite code" aria-label="Invite code"
                />
                <button className="btn btn-primary" disabled={!joinCode.trim()} onClick={join}>Join household</button>
              </div>
              {joinError && <p className="form-error" role="alert">{joinError}</p>}
            </details>
          </>
        )}

        {step === 1 && (
          <>
            <h2>Where does your balance stand?</h2>
            <p className="muted small">
              This seeds your first bank account — you can add more accounts (savings, credit, cash)
              in Settings later.
            </p>
            <label>
              Current bank account balance
              <input
                type="text" inputMode="decimal" placeholder="0.00" value={balance}
                onChange={(e) => setBalance(e.target.value)}
              />
            </label>
            <label>
              Currency
              <select value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </label>
            <div className="wizard-nav">
              <button className="btn btn-ghost" onClick={() => setStep(0)}>Back</button>
              <button className="btn btn-primary" onClick={() => setStep(2)}>Continue</button>
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Recurring bills &amp; income</h2>
            <p className="muted">
              Set up the amounts you plan around. Per-period items repeat every pay period; monthly items
              land in whichever period contains their due day. Add, remove, or skip — you can manage these
              anytime under Categories.
            </p>
            <div className="onboarding-cats">
              {cats.map((c, i) => (
                <div key={i} className={`onboarding-cat ${c.include ? '' : 'excluded'}`}>
                  <input type="checkbox" checked={c.include} onChange={(e) => setCat(i, { include: e.target.checked })} aria-label="Include" />
                  <input type="text" value={c.name} onChange={(e) => setCat(i, { name: e.target.value })} placeholder="Name" />
                  <select value={c.type} onChange={(e) => setCat(i, { type: e.target.value })}>
                    <option value="expense">Expense</option>
                    <option value="income">Income</option>
                  </select>
                  <select
                    value={c.recurrence}
                    onChange={(e) => setCat(i, { recurrence: e.target.value })}
                  >
                    <option value="every_period">Every period</option>
                    <option value="monthly">Monthly</option>
                  </select>
                  {c.recurrence === 'monthly' ? (
                    <input
                      type="number" min="1" max="31" value={c.dueDay || 1} title="Due day of month"
                      onChange={(e) => setCat(i, { dueDay: e.target.value })}
                    />
                  ) : <span />}
                  <input
                    type="text" inputMode="decimal" placeholder="0.00" value={c.amount}
                    onChange={(e) => setCat(i, { amount: e.target.value })} aria-label="Amount"
                  />
                </div>
              ))}
            </div>
            <button
              className="btn btn-ghost"
              onClick={() => setCats([...cats, { name: '', type: 'expense', recurrence: 'every_period', dueDay: 1, amount: '', include: true }])}
            >
              + Add another
            </button>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="wizard-nav">
              <button className="btn btn-ghost" onClick={() => setStep(1)}>Back</button>
              <div>
                <button className="btn btn-ghost" disabled={busy} onClick={() => finish(true)}>Skip for now</button>
                <button className="btn btn-primary" disabled={busy} onClick={() => finish(false)}>Finish setup</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
