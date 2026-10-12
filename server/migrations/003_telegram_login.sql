ALTER TABLE users ADD COLUMN telegram_id TEXT;
ALTER TABLE users ADD COLUMN telegram_username TEXT;
CREATE UNIQUE INDEX idx_users_telegram ON users(telegram_id) WHERE telegram_id IS NOT NULL;

-- One row per "Sign in with Telegram" attempt started from an app/browser.
-- The secret token is only ever stored hashed; status moves pending -> awaiting_* -> approved -> consumed.
CREATE TABLE login_tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending',
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT NOT NULL DEFAULT '',
  device       TEXT NOT NULL DEFAULT '',
  telegram_id  TEXT,
  chat_id      TEXT,
  user_id      INTEGER REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_login_tokens_chat ON login_tokens(chat_id, status);
