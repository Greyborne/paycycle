-- Email notification delivery (opt-in per user) and foreign-currency
-- tracked accounts.

-- Per-user opt-in for emailed notifications (only honored when the server
-- has SMTP configured).
ALTER TABLE users ADD COLUMN email_notifications BOOLEAN NOT NULL DEFAULT FALSE;

-- One email per notification instance, ever.
CREATE TABLE notification_emails (
  id      SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key     TEXT NOT NULL,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, key)
);

-- Account currency. NULL = the household's base currency. An account in any
-- other currency is a "tracked" account: its balance is kept in its own
-- currency, its transactions do not enter period budget math, and it cannot
-- carry line items or be the default account.
ALTER TABLE accounts ADD COLUMN currency TEXT;
