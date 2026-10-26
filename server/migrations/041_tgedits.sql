-- What a message said before it was edited in Telegram: the copy keeps every earlier version (nothing that disappears in Telegram disappears here).
CREATE TABLE IF NOT EXISTS tg_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tg_edits_message ON tg_edits(message_id);
