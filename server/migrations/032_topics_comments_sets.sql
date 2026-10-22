-- Topics in groups, comments under channel posts, sticker and emoji sets made by people, and the index for search by meaning.

ALTER TABLE chats ADD COLUMN forum INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS topics (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '',
  closed     INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_chat ON topics(chat_id);
ALTER TABLE messages ADD COLUMN topic_id INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_topic ON messages(chat_id, topic_id, id);
-- where a person has read up to in every topic (topic 0 is the "General" one)
CREATE TABLE IF NOT EXISTS topic_reads (
  chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id     INTEGER NOT NULL DEFAULT 0,
  last_read_id INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, user_id, topic_id)
);

ALTER TABLE chats ADD COLUMN comments INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN thread_of INTEGER;
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_of, id) WHERE thread_of IS NOT NULL;

CREATE TABLE IF NOT EXISTS sticker_sets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug       TEXT NOT NULL UNIQUE,
  title      TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'sticker' CHECK (kind IN ('sticker','emoji')),
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sticker_set_items (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  set_id   INTEGER NOT NULL REFERENCES sticker_sets(id) ON DELETE CASCADE,
  file_id  TEXT NOT NULL,
  emoji    TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_set_items_file ON sticker_set_items(file_id);
CREATE TABLE IF NOT EXISTS sticker_installed (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  set_id  INTEGER NOT NULL REFERENCES sticker_sets(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, set_id)
);

-- vectors of messages for search by meaning (only text of chats the server can read)
CREATE TABLE IF NOT EXISTS embeddings (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  vec        BLOB NOT NULL
);

ALTER TABLE uploads ADD COLUMN topic_id INTEGER;
