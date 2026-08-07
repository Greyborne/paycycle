import React, { useState } from 'react';

// "This looks like it belongs in the adjacent period" — dismissible
// suggestions (from the recurring-match auto-detect on PATCH
// /transactions/assign) to move a transaction to the previous or next
// pay period via the existing move action.
// suggestions: [{ transactionId, direction: 'prev'|'next', reason, description }]
export default function MoveSuggestions({ suggestions, onAccept }) {
  const [hidden, setHidden] = useState(new Set());
  const [applied, setApplied] = useState(new Set());

  const keyOf = (s) => `${s.transactionId}:${s.direction}`;
  const visible = (suggestions || []).filter((s) => !hidden.has(keyOf(s)));
  if (!visible.length) return null;

  const dismiss = (s) => setHidden(new Set([...hidden, keyOf(s)]));
  const accept = async (s) => {
    await onAccept(s.transactionId, s.direction);
    setApplied(new Set([...applied, keyOf(s)]));
  };

  return (
    <section className="warning-banner drift-notices" role="status">
      <strong>Possible period mismatch</strong>
      {visible.map((s) => {
        const k = keyOf(s);
        const dirLabel = s.direction === 'prev' ? 'previous' : 'next';
        const bodyText = `${s.reason} Move it to the ${dirLabel} period?`;
        return (
          <div key={k} className="drift-notice">
            <span>
              <strong>{s.description || 'This transaction'}</strong>: {bodyText}
            </span>
            {applied.has(k) ? (
              <span className="form-ok small">Moved</span>
            ) : (
              <span className="drift-actions">
                <button className="btn btn-small" onClick={() => accept(s)}>
                  Move to {dirLabel} period
                </button>
                <button className="btn btn-ghost btn-small" onClick={() => dismiss(s)} aria-label="Dismiss">✕</button>
              </span>
            )}
          </div>
        );
      })}
    </section>
  );
}
