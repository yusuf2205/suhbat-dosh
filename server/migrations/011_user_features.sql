-- Per-user chat extras: pinned chats, notification sound; chat folders; scheduled messages and reminders; polls.
ALTER TABLE members ADD COLUMN pinned_at INTEGER;
ALTER TABLE members ADD COLUMN sound TEXT;

CREATE TABLE folders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '',
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_folders_user ON folders(user_id);

CREATE TABLE folder_chats (
  folder_id  INTEGER NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  PRIMARY KEY (folder_id, chat_id)
);

-- kind 'message': posted into chat_id at send_at; kind 'reminder': delivered to the author by the service account
CREATE TABLE scheduled (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     INTEGER REFERENCES chats(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'message',
  text        TEXT NOT NULL,
  reply_to    INTEGER,
  send_at     INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_scheduled_due ON scheduled(send_at);
CREATE INDEX idx_scheduled_user ON scheduled(user_id);

CREATE TABLE polls (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  question    TEXT NOT NULL,
  options     TEXT NOT NULL,           -- JSON array of strings
  multiple    INTEGER NOT NULL DEFAULT 0,
  closed      INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE poll_votes (
  poll_id   INTEGER NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option    INTEGER NOT NULL,
  PRIMARY KEY (poll_id, user_id, option)
);
