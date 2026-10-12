-- Auto-delete timers, abuse reports, storage quotas, stories.
ALTER TABLE chats ADD COLUMN ttl_seconds INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN quota_bytes INTEGER;               -- NULL = server default

CREATE TABLE reports (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  reporter_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  message_id   INTEGER,
  chat_id      INTEGER,
  sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reason       TEXT NOT NULL,
  snapshot     TEXT NOT NULL DEFAULT '',                          -- the reported text, kept even if it is deleted later
  status       TEXT NOT NULL DEFAULT 'open',                      -- open | resolved
  resolution   TEXT,
  created_at   INTEGER NOT NULL,
  resolved_at  INTEGER,
  resolved_by  INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_reports_status ON reports(status, id);

CREATE TABLE stories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id     TEXT REFERENCES files(id) ON DELETE SET NULL,
  text        TEXT NOT NULL DEFAULT '',
  bg          TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL                                    -- after this it moves to the owner's archive
);
CREATE INDEX idx_stories_user ON stories(user_id, id);

CREATE TABLE story_views (
  story_id  INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  at        INTEGER NOT NULL,
  PRIMARY KEY (story_id, user_id)
);
