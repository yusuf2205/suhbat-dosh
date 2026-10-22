-- One-time photos and videos, several pinned messages, live location, chat appearance, working hours and greeting,
-- read times, note versions, join requests with several invite links, and public channel pages.

ALTER TABLE messages ADD COLUMN once INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS once_views (
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewed_at  INTEGER NOT NULL,
  PRIMARY KEY (message_id, user_id)
);

CREATE TABLE IF NOT EXISTS pins (
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by  INTEGER,
  pinned_at  INTEGER NOT NULL,
  PRIMARY KEY (chat_id, message_id)
);
INSERT OR IGNORE INTO pins (chat_id, message_id, pinned_by, pinned_at)
  SELECT id, pinned_message_id, owner_id, last_message_at FROM chats WHERE pinned_message_id IS NOT NULL;

ALTER TABLE messages ADD COLUMN live_until INTEGER;
ALTER TABLE uploads ADD COLUMN once INTEGER NOT NULL DEFAULT 0;

ALTER TABLE chats ADD COLUMN theme TEXT;
ALTER TABLE members ADD COLUMN theme TEXT;

ALTER TABLE users ADD COLUMN work TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN greeting TEXT NOT NULL DEFAULT '';

ALTER TABLE users ADD COLUMN read_receipts INTEGER NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS read_log (
  chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  upto_id INTEGER NOT NULL,
  at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_read_log ON read_log(chat_id, user_id, upto_id);

CREATE TABLE IF NOT EXISTS note_versions (
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  rev     INTEGER NOT NULL,
  body    TEXT NOT NULL,
  user_id INTEGER,
  at      INTEGER NOT NULL,
  PRIMARY KEY (note_id, rev)
);

ALTER TABLE chats ADD COLUMN join_approval INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS join_requests (
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE TABLE IF NOT EXISTS invite_links (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  code       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL DEFAULT '',
  expires_at INTEGER,
  max_uses   INTEGER,
  uses       INTEGER NOT NULL DEFAULT 0,
  approval   INTEGER NOT NULL DEFAULT 0,
  revoked    INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER,
  created_at INTEGER NOT NULL
);

ALTER TABLE chats ADD COLUMN slug TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_chats_slug ON chats(slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS greeted (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, peer_id)
);
