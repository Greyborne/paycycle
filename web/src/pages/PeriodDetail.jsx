import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useAccount, useAuth } from '../App.jsx';
import { centsToInput, fmtDate, fmtMoney, fmtRange, parseMoney, todayISO } from '../format.js';
import HealthBadge from '../components/HealthBadge.jsx';
import QuickAddTransaction from '../components/QuickAddTransaction.jsx';

// The page shows a window of consecutive periods side by side; the column
// count adapts to the available width (minimize the sidebar for more).
const MIN_COL_PX = 560;
const MAX_COLS = 5;

// Editing a planned amount asks whether the change is just this period or the
// recurring plan going forward — a one-off snapshot edit vs. a new
// effective-dated amount.
function PlannedCell({ item, currency, editable, onSave }) {
  const [mode, setMode] = useState('view'); // view | edit | scope
  const [value, setValue] = useState('');
  const [pending, setPending] = useState(null);

  if (!editable) {
    return <span className="cell-amount">{fmtMoney(item.planned_amount_cents, currency)}</span>;
  }
  if (mode === 'view') {
    return (
      <button
        className="cell-amount editable" title="Click to edit"
        onClick={() => { setValue(centsToInput(item.planned_amount_cents)); setMode('edit'); }}
      >
        {fmtMoney(item.planned_amount_cents, currency)}
      </button>
    );
  }
  if (mode === 'edit') {
    const next = () => {
      const cents = parseMoney(value);
      if (cents === null || cents === item.planned_amount_cents) { setMode('view'); return; }
      setPending(cents);
      setMode('scope');
    };
    return (
      <input
        className="cell-input" type="text" inputMode="decimal" value={value} autoFocus
        onChange={(e) => setValue(e.target.value)}
        onBlur={next}
        onKeyDown={(e) => { if (e.key === 'Enter') next(); if (e.key === 'Escape') setMode('view'); }}
      />
    );
  }
  // scope: choose whether the new amount is one-off or the recurring plan
  const choose = (scope) => { onSave(pending, scope); setMode('view'); };
  return (
    <span className="scope-choice">
      <span className="muted small">{fmtMoney(pending, currency)} —</span>
      <button className="btn btn-small" onMouseDown={(e) => e.preventDefault()} onClick={() => choose('period')}>
        This period
      </button>
      <button className="btn btn-small btn-primary" onMouseDown={(e) => e.preventDefault()} onClick={() => choose('forward')}>
        All future
      </button>
      <button className="btn btn-ghost btn-small" title="Cancel" onMouseDown={(e) => e.preventDefault()} onClick={() => setMode('view')}>✕</button>
    </span>
  );
}

function ItemTable({ title, items, currency, editable, onPatch, plannedTotal, clearedTotal, clearedNote }) {
  const cols = 3;
  return (
    <div className="period-table">
      <h3>{title}</h3>
      <table className="table">
        <thead>
          <tr>
            <th>Category</th>
            <th className="num">Planned</th>
            <th className="center">Cleared</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 && (
            <tr><td colSpan={cols} className="muted">No line items{editable ? ' — add categories to populate this period' : ''}.</td></tr>
          )}
          {items.map((item, i) => (
            <tr key={item.id ?? `v${item.category_template_id ?? i}`}>
              <td>
                {item.name}
                {item.recurrence === 'monthly' && <span className="muted small"> · due day {item.due_day}</span>}
              </td>
              <td className="num">
                <PlannedCell
                  item={item} currency={currency} editable={editable}
                  onSave={(cents, scope) => onPatch(item, { plannedAmountCents: cents, scope })}
                />
              </td>
              <td className="center">
                <input
                  type="checkbox" checked={item.cleared} disabled={!editable || item.id == null}
                  title={item.id == null
                    ? 'Set a planned amount first, then you can mark it cleared'
                    : (item.cleared_date ? `Cleared ${fmtDate(item.cleared_date)}` : 'Has this posted to your bank account?')}
                  onChange={(e) => onPatch(item, { cleared: e.target.checked })}
                />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total planned</td>
            <td className="num">{fmtMoney(plannedTotal, currency)}</td>
            <td colSpan={cols - 2} />
          </tr>
          <tr>
            <td>Total cleared{clearedNote ? <span className="muted small"> {clearedNote}</span> : null}</td>
            <td className="num">{fmtMoney(clearedTotal, currency)}</td>
            <td colSpan={cols - 2} />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

const STATUS_BADGES = {
  current: ['badge-current', 'Current', 'The period being worked and reconciled now'],
  open: ['health-danger', 'Open', 'A past period still waiting to be closed out'],
  closed: ['health-none', 'Closed', 'Closed out — its cleared balance is frozen'],
  projected: ['health-none', 'Projected', 'Computed from your categories'],
};

function ClosePeriodDialog({ period, currency, onCancel, onDone }) {
  const [preview, setPreview] = useState(null);
  const [resolutions, setResolutions] = useState({});
  const [discrepancy, setDiscrepancy] = useState('adjust');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api(`/periods/${period.start}/close-preview`)
      .then((d) => {
        setPreview(d);
        setResolutions(Object.fromEntries(d.uncleared.map((u) => [u.id, 'clear'])));
      })
      .catch((err) => setError(err.message));
  }, [period.start]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/periods/${period.start}/close`, {
        method: 'POST',
        body: {
          resolutions,
          discrepancy: preview.discrepancyCents !== 0 ? discrepancy : undefined,
        },
      });
      onDone();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <h3>Close out {fmtRange(period.start, period.end)}</h3>
        {!preview && !error && <p className="muted">Checking…</p>}
        {preview && (
          <>
            {preview.uncleared.length > 0 && (
              <>
                <p className="muted small">
                  These planned items haven't cleared. Decide what happens to each:
                </p>
                {preview.uncleared.map((item) => (
                  <div key={item.id} className="close-item">
                    <span>
                      {item.name}
                      <span className="muted small"> · {item.type} · {fmtMoney(item.plannedAmountCents, currency)}</span>
                    </span>
                    <select
                      value={resolutions[item.id]}
                      onChange={(e) => setResolutions({ ...resolutions, [item.id]: e.target.value })}
                      aria-label={`Resolution for ${item.name}`}
                    >
                      <option value="clear">Mark cleared</option>
                      <option value="carry">Carry to next period</option>
                      <option value="remove">Remove (this occurrence only)</option>
                    </select>
                  </div>
                ))}
              </>
            )}
            {preview.discrepancyCents !== 0 && (
              <div className="discrepancy-block warning-banner">
                <strong>Doesn't reconcile:</strong> even with every planned item cleared, the cleared
                balance ({fmtMoney(preview.predictedClearedCents, currency)}) would differ from the
                estimated running balance ({fmtMoney(preview.estBalanceCents, currency)}) by{' '}
                <strong>{fmtMoney(Math.abs(preview.discrepancyCents), currency)}</strong>.
                <label className="radio-row">
                  <input
                    type="radio" name="discrepancy" checked={discrepancy === 'adjust'}
                    onChange={() => setDiscrepancy('adjust')}
                  />
                  <span>
                    Log a close-out adjustment (recommended) — records the difference as an
                    adjustment line in this period so future estimates match reality
                  </span>
                </label>
                <label className="radio-row">
                  <input
                    type="radio" name="discrepancy" checked={discrepancy === 'accept'}
                    onChange={() => setDiscrepancy('accept')}
                  />
                  <span>Close without adjusting — keep the mismatch visible</span>
                </label>
              </div>
            )}
            {preview.uncleared.length === 0 && preview.discrepancyCents === 0 && (
              <p className="muted">
                Everything is cleared and the balances reconcile. The cleared balance will be frozen
                and the next period becomes current.
              </p>
            )}
          </>
        )}
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
          <button className="btn btn-primary" disabled={!preview || busy} onClick={submit}>
            Close period
          </button>
        </div>
      </div>
    </div>
  );
}

function PeriodColumn({ data, currency, userEmail, tags, onChanged }) {
  const { period, expenses, income, transactions, summary } = data;
  const editable = period.editable;
  const [closing, setClosing] = useState(false);
  const [badgeClass, badgeLabel, badgeTitle] = STATUS_BADGES[period.status] || STATUS_BADGES.projected;

  const patchItem = async (item, body) => {
    if (item.id == null) {
      // A read-only $0 placeholder — create the line item for this period.
      await api(`/periods/${period.start}/line-items`, {
        method: 'POST',
        body: { categoryTemplateId: item.category_template_id, ...body },
      });
    } else {
      await api(`/periods/line-items/${item.id}`, { method: 'PATCH', body });
    }
    onChanged();
  };
  const deleteTxn = async (id) => {
    await api(`/transactions/${id}`, { method: 'DELETE' });
    onChanged();
  };
  const reopen = async () => {
    const ok = window.confirm(
      `Reopen ${fmtRange(period.start, period.end)}?\n\n`
      + 'It becomes your Current period again, and every period after it — including the one that is '
      + 'currently active — reverts to Projected. Items that were carried forward or removed during '
      + 'close-out are restored.'
    );
    if (!ok) return;
    try {
      await api(`/periods/${period.start}/reopen`, { method: 'POST' });
      onChanged();
    } catch (err) {
      window.alert(err.message);
    }
  };

  return (
    <div className={`period-col ${period.status === 'current' ? 'period-col-current' : ''}`}>
      {/* The head + summary stay pinned while the item tables scroll, so the
          Cleared balance is always visible for reconciling against the bank. */}
      <div className="period-col-sticky">
        <div className="card period-col-head">
          <h2>{fmtRange(period.start, period.end)}</h2>
          <div className="period-col-actions">
            {period.canClose && (
              <button className="btn period-close-btn" onClick={() => setClosing(true)}>Close</button>
            )}
            {period.canReopen ? (
              <button
                type="button"
                className={`badge ${badgeClass} badge-reopen`}
                title="Click to reopen this pay period"
                onClick={reopen}
              >
                {badgeLabel} <span aria-hidden="true">↺</span>
              </button>
            ) : (
              <span
                className={`badge ${badgeClass}`}
                title={period.status === 'closed'
                  ? 'Reopen the more recent closed periods first — you can only step back one period at a time'
                  : badgeTitle}
              >
                {badgeLabel}
              </span>
            )}
          </div>
        </div>

        {summary && (
          <div className="card">
            <div className="period-summary">
              {summary.clearedBalance != null && (
                <div
                  className="stat"
                  title="The account balance entering this period plus everything cleared during it — match it against the bank balance the day before your next paycheck to reconcile"
                >
                  <div className="stat-label">Cleared balance</div>
                  <div className="stat-value">{fmtMoney(summary.clearedBalance, currency)}</div>
                </div>
              )}
              <div className="stat">
                <div className="stat-label">Estimated running balance</div>
                <div className="stat-value">
                  <HealthBadge health={summary.health}>{fmtMoney(summary.estBalance, currency)}</HealthBadge>
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Period loss / gain</div>
                <div className="stat-value">
                  <HealthBadge health={summary.empty ? 'none' : summary.lossGain < 0 ? 'negative' : 'healthy'}>
                    {fmtMoney(summary.lossGain, currency)}
                  </HealthBadge>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
      {closing && (
        <ClosePeriodDialog
          period={period}
          currency={currency}
          onCancel={() => setClosing(false)}
          onDone={() => { setClosing(false); onChanged(); }}
        />
      )}

      <ItemTable
        title="Planned Income" items={income} currency={currency} editable={editable} onPatch={patchItem}
        plannedTotal={summary?.plannedIncome ?? 0}
        clearedTotal={summary?.clearedIncome ?? 0}
        clearedNote="(cleared items + misc income)"
      />
      <ItemTable
        title="Planned Expenses" items={expenses} currency={currency} editable={editable} onPatch={patchItem}
        plannedTotal={summary?.plannedExpenses ?? 0}
        clearedTotal={summary?.clearedExpenses ?? 0}
        clearedNote="(cleared items + misc transactions)"
      />

      <section className="card period-misc">
        <h3>Misc transactions</h3>
        {summary && (
          <div className="totals-grid">
            <div className="stat">
              <div className="stat-label">Misc income</div>
              <div className="stat-value">{fmtMoney(summary.miscIncome, currency)}</div>
            </div>
            <div className="stat">
              <div className="stat-label">Misc expenses</div>
              <div className="stat-value">{fmtMoney(summary.miscExpenses, currency)}</div>
            </div>
          </div>
        )}
        {editable ? (
          <QuickAddTransaction
            onAdded={onChanged}
            defaultDate={summary?.isCurrent ? todayISO() : period.start}
            fixedAccountId={data.accountId}
            tags={tags}
          />
        ) : (
          <p className="muted small">
            {period.status === 'closed'
              ? 'This period is closed — reopen it to make changes.'
              : 'Transactions can be added once this period is reached.'}
          </p>
        )}
        {transactions.length > 0 && (
          <table className="table">
            <thead>
              <tr><th>Date</th><th>Description</th><th>Tag</th><th className="num">Amount</th><th /></tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id}>
                  <td className="nowrap">{fmtDate(t.date, { month: 'short', day: 'numeric' })}</td>
                  <td>
                    {t.description || <span className="muted">—</span>}
                    {t.entered_by && t.entered_by !== userEmail && (
                      <span className="muted small"> · {t.entered_by}</span>
                    )}
                    {t.account_currency && (
                      <span className="muted small" title="On a foreign-currency tracked account — not counted in period totals">
                        {' '}· {t.account_name} ({t.account_currency})
                      </span>
                    )}
                  </td>
                  <td>
                    {t.category_name
                      ? <span className="badge badge-tag">{t.category_name}</span>
                      : <span className="muted">—</span>}
                  </td>
                  <td className={`num ${t.type === 'expense' ? 'amount-neg' : ''}`}>
                    {t.type === 'expense' ? '−' : ''}{fmtMoney(t.amount_cents, t.account_currency || currency)}
                  </td>
                  <td className="center">
                    <button className="btn btn-ghost btn-small" onClick={() => deleteTxn(t.id)} aria-label="Delete transaction">✕</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

export default function PeriodDetail() {
  const { start } = useParams();
  const { user } = useAuth();
  const { accountId } = useAccount();
  const currency = user.currency;
  const [periods, setPeriods] = useState([]);
  const [tags, setTags] = useState([]);
  const [error, setError] = useState(null);
  const wrapRef = useRef(null);
  const reqRef = useRef(0);
  const [cols, setCols] = useState(1);
  // Offset the sticky column heads sit at: the app header's height, so they
  // pin flush beneath it (the header height changes on resize / mobile).
  const [stickyTop, setStickyTop] = useState(0);

  // Tag categories offered when quick-adding a misc transaction.
  useEffect(() => {
    api('/categories')
      .then((d) => setTags(d.categories.filter((c) => c.categoryType === 'tag' && !c.archived)))
      .catch(() => {});
  }, []);

  // Measure before the first fetch so the initial load already knows how many
  // columns fit; ResizeObserver keeps it in sync (sidebar minimize, resizes).
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const update = () => {
      setCols(Math.max(1, Math.min(MAX_COLS, Math.floor(el.clientWidth / MIN_COL_PX))));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Track the app header's height so the sticky heads pin right below it.
  useLayoutEffect(() => {
    const header = document.querySelector('.content-header');
    if (!header) return undefined;
    const measure = () => setStickyTop(header.getBoundingClientRect().height);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(header);
    return () => ro.disconnect();
  }, []);

  const load = useCallback(async () => {
    const req = ++reqRef.current;
    setError(null);
    try {
      const out = [];
      let next = start;
      while (out.length < cols && next) {
        let data;
        try {
          data = await api(`/periods/${next}?account=${accountId ?? ''}`);
        } catch (err) {
          if (out.length === 0) throw err;
          break; // window ran past the projection horizon; show what we have
        }
        out.push(data);
        next = data.nav.nextStart;
      }
      if (reqRef.current === req) setPeriods(out);
    } catch (err) {
      if (reqRef.current === req) setError(err.message);
    }
  }, [start, cols, accountId]);

  useEffect(() => { load(); }, [load]);

  const nav = periods[0]?.nav;

  return (
    <div className="periods-page" ref={wrapRef} style={{ '--sticky-top': `${stickyTop}px` }}>
      {error && <p className="form-error">{error}</p>}
      {!error && periods.length === 0 && <div className="page-loading">Loading…</div>}
      {periods.length > 0 && (
        <div className="periods-layout">
          {nav && (
            <Link className="period-nav-arrow" to={`/period/${nav.prevStart}`} aria-label="Previous periods" title="Previous periods">‹</Link>
          )}
          <div className="periods-grid" style={{ gridTemplateColumns: `repeat(${Math.max(periods.length, 1)}, minmax(0, 1fr))` }}>
            {periods.map((data) => (
              <PeriodColumn
                key={data.period.start}
                data={data}
                currency={currency}
                userEmail={user.email}
                tags={tags}
                onChanged={load}
              />
            ))}
          </div>
          {nav && (
            <Link className="period-nav-arrow" to={`/period/${nav.nextStart}`} aria-label="Next periods" title="Next periods">›</Link>
          )}
        </div>
      )}
    </div>
  );
}
