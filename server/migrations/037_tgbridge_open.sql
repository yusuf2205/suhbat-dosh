-- Everybody may link a Telegram account to the messenger; the administrator can forbid it for a person (and remove what was linked).
CREATE TABLE IF NOT EXISTS tg_denied (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  by_id   INTEGER,
  at      INTEGER NOT NULL
);
