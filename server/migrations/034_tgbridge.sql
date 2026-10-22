-- Bridge to the owner's own Telegram account: which chats are mirrored, and whether they may be answered from here.
CREATE TABLE IF NOT EXISTS tg_bridge (
  user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tg_name     TEXT NOT NULL DEFAULT '',
  tg_username TEXT NOT NULL DEFAULT '',
  keep_days   INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tg_chats (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tg_chat TEXT NOT NULL,
  title   TEXT NOT NULL,
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  two_way INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, tg_chat)
);
CREATE INDEX IF NOT EXISTS idx_tg_chats_chat ON tg_chats(chat_id);
