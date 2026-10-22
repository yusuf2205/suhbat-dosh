-- Tasks made from messages, focus mode (quiet hours with exceptions) and urgent messages.
CREATE TABLE IF NOT EXISTS tasks (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  source_id   INTEGER,
  creator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  assignee_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  due_at      INTEGER,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     INTEGER,
  done_by     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee_id, done);
CREATE INDEX IF NOT EXISTS idx_tasks_chat ON tasks(chat_id);

ALTER TABLE users ADD COLUMN focus TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
