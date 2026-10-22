-- Personal cloud drive (references to stored files), public share links, and time-limited access to files in chats.
CREATE TABLE IF NOT EXISTS drive_items (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id    TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  folder     TEXT    NOT NULL DEFAULT '',
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (user_id, file_id)
);
CREATE INDEX IF NOT EXISTS idx_drive_user ON drive_items(user_id, folder);

CREATE TABLE IF NOT EXISTS drive_shares (
  token         TEXT PRIMARY KEY,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id       TEXT    NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  pw_hash       TEXT,
  expires_at    INTEGER,
  max_downloads INTEGER,
  downloads     INTEGER NOT NULL DEFAULT 0,
  revoked       INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON drive_shares(user_id);

-- after this moment the recipients of a message can no longer open its file (the sender always can)
ALTER TABLE messages ADD COLUMN access_until INTEGER;
