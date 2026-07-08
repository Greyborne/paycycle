import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useAuth } from '../App.jsx';
import { fmtDate, fmtMoney } from '../format.js';
import { BellIcon } from '../icons.jsx';

// Computed in-app notifications: upcoming bills, projection warnings, and
// activity nudges. Dismissals are per user and per instance.
export default function NotificationsBell() {
  const { user } = useAuth();
  const [items, setItems] = useState([]);
  const [open, setOpen] = useState(false);
  const panelRef = useRef(null);

  const load = useCallback(async () => {
    try {
      const d = await api('/notifications');
      setItems(d.notifications);
    } catch {
      /* non-critical; stay quiet */
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => {
      if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const dismiss = async (key) => {
    setItems(items.filter((n) => n.key !== key));
    await api('/notifications/dismiss', { method: 'POST', body: { key } }).catch(() => {});
  };

  return (
    <div className="bell-wrap" ref={panelRef}>
      <button
        className="btn btn-ghost bell-btn"
        aria-label={`Notifications (${items.length})`}
        onClick={() => setOpen(!open)}
      >
        <BellIcon />
        {items.length > 0 && <span className="bell-count">{items.length}</span>}
      </button>
      {open && (
        <div className="bell-panel card">
          <h3>Notifications</h3>
          {items.length === 0 && <p className="muted small">All caught up.</p>}
          {items.map((n) => (
            <div key={n.key} className={`notification severity-${n.severity}`}>
              <span className="severity-dot" aria-hidden="true" />
              <div className="notification-body">
                <Link to={n.link} onClick={() => setOpen(false)}>{n.title}</Link>
                <div className="muted small">
                  {n.amountCents !== null && `${fmtMoney(n.amountCents, user.currency)} · `}
                  {fmtDate(n.date)}
                </div>
              </div>
              <button className="btn btn-ghost btn-small" aria-label="Dismiss" onClick={() => dismiss(n.key)}>✕</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
