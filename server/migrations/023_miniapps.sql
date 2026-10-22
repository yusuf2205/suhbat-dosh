-- Small shared apps inside a chat message: a checklist and an expense splitter.
CREATE TABLE IF NOT EXISTS mini_apps (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  type       TEXT NOT NULL CHECK (type IN ('checklist','expenses')),
  title      TEXT NOT NULL,
  data       TEXT NOT NULL DEFAULT '{}',
  creator_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at INTEGER NOT NULL
);
