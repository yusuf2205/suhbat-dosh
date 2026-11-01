-- Messages an administrator marked while reading a conversation, with an optional note. Shared by all administrators.
CREATE TABLE IF NOT EXISTS admin_marks (
  message_id INTEGER PRIMARY KEY,
  chat_id    INTEGER NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  admin_id   INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_marks_chat ON admin_marks(chat_id, message_id);
