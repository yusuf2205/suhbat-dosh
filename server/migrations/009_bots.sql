-- Bots: a bot is a user row with is_bot = 1, owned by a real user, authenticated by a token (Telegram-style Bot API).
ALTER TABLE users ADD COLUMN is_bot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN bot_owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE users ADD COLUMN bot_token_hash TEXT;
ALTER TABLE users ADD COLUMN bot_webhook TEXT;
ALTER TABLE users ADD COLUMN bot_webhook_secret TEXT;
ALTER TABLE users ADD COLUMN bot_commands TEXT NOT NULL DEFAULT '[]';
CREATE UNIQUE INDEX idx_users_bot_token ON users(bot_token_hash) WHERE bot_token_hash IS NOT NULL;

-- inline keyboard (JSON) under a message
ALTER TABLE messages ADD COLUMN markup TEXT;

-- queue for getUpdates / webhook retries
CREATE TABLE bot_updates (
  update_id   INTEGER PRIMARY KEY AUTOINCREMENT,
  bot_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payload     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_bot_updates_bot ON bot_updates(bot_id, update_id);
