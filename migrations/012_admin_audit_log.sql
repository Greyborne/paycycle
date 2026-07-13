-- Audit trail for admin actions (increment 2b: delete user). Intentionally
-- has no foreign keys to users - a log entry must survive the actor or the
-- target account later being deleted, so email addresses are stored as text
-- snapshots rather than joined live.
CREATE TABLE admin_audit_log (
  id              SERIAL PRIMARY KEY,
  actor_user_id   INTEGER,
  actor_email     TEXT NOT NULL,
  action          TEXT NOT NULL,
  target_user_id  INTEGER,
  target_email    TEXT NOT NULL,
  detail          JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_admin_audit_log_target ON admin_audit_log (target_user_id);
CREATE INDEX idx_admin_audit_log_created ON admin_audit_log (created_at);
