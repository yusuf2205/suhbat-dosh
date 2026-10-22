-- Shared notes inside a chat: one text edited by several people at once. The server keeps the text and a short history of edits.
CREATE TABLE IF NOT EXISTS notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  rev        INTEGER NOT NULL DEFAULT 0,
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS note_ops (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  rev     INTEGER NOT NULL,
  user_id INTEGER,
  pos     INTEGER NOT NULL,
  del     INTEGER NOT NULL,
  ins     TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (note_id, rev)
);
