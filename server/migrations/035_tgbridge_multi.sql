-- Telegram bridge for several accounts: the administrator decides who may link; personal chats are mirrored by default.
ALTER TABLE tg_bridge ADD COLUMN auto_private INTEGER NOT NULL DEFAULT 1;
ALTER TABLE tg_chats ADD COLUMN kind TEXT NOT NULL DEFAULT 'user';
CREATE TABLE IF NOT EXISTS tg_allowed (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  by_id   INTEGER,
  at      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_excluded (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_chat TEXT NOT NULL,
  PRIMARY KEY (user_id, tg_chat)
);
