CREATE TABLE password_resets (
  id          SERIAL PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_password_resets_token_hash ON password_resets (token_hash);

ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();
