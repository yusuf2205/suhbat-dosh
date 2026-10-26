-- "Договорились": a card in a chat with what was agreed, who is responsible and until when; the people in the chat agree to it.
CREATE TABLE IF NOT EXISTS deals (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  creator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  owner_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  due_at      INTEGER,
  done        INTEGER NOT NULL DEFAULT 0,
  done_at     INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals(owner_id, done);
CREATE INDEX IF NOT EXISTS idx_deals_chat ON deals(chat_id);
CREATE TABLE IF NOT EXISTS deal_ok (
  deal_id INTEGER NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  PRIMARY KEY (deal_id, user_id)
);
