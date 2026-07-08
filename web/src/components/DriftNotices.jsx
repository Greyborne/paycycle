import React, { useState } from 'react';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { fmtDate, fmtMoney } from '../format.js';

// "Electric cleared at $260 but you plan $250" — dismissible suggestions to
// roll a recurring category's planned amount forward from the actual figure.
// notices: [{ categoryTemplateId, name, plannedCents, actualCents, date }]
export default function DriftNotices({ notices, onChanged }) {
  const { user } = useAuth();
  const [hidden, setHidden] = useState(new Set());
  const [applied, setApplied] = useState(new Set());

  const keyOf = (n) => `${n.categoryTemplateId}:${n.date}:${n.actualCents}`;
  const visible = (notices || []).filter((n) => !hidden.has(keyOf(n)));
  if (!visible.length) return null;

  const dismiss = (n) => setHidden(new Set([...hidden, keyOf(n)]));
  const accept = async (n) => {
    await api(`/categories/${n.categoryTemplateId}/amounts`, {
      method: 'POST',
      body: { amountCents: n.actualCents, effectiveStartDate: n.date },
    });
    setApplied(new Set([...applied, keyOf(n)]));
    onChanged?.();
  };

  return (
    <section className="warning-banner drift-notices" role="status">
      <strong>Planned vs actual drift</strong>
      {visible.map((n) => {
        const k = keyOf(n);
        return (
          <div key={k} className="drift-notice">
            <span>
              {n.name} cleared at <strong>{fmtMoney(n.actualCents, user.currency)}</strong> on {fmtDate(n.date)},
              but the plan is <strong>{fmtMoney(n.plannedCents, user.currency)}</strong>.
            </span>
            {applied.has(k) ? (
              <span className="form-ok small">Plan updated</span>
            ) : (
              <span className="drift-actions">
                <button className="btn btn-small" onClick={() => accept(n)}>
                  Plan {fmtMoney(n.actualCents, user.currency)} going forward
                </button>
                <button className="btn btn-ghost btn-small" onClick={() => dismiss(n)} aria-label="Dismiss">✕</button>
              </span>
            )}
          </div>
        );
      })}
    </section>
  );
}
