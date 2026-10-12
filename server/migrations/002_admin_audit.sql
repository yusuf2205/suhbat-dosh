ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

-- Append-only activity journal, readable only by super admins.
-- Stores what a user did and, for edits/deletions, the content that was replaced or removed.
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  chat_id     INTEGER,
  details     TEXT,                 -- JSON
  ip          TEXT
);
CREATE INDEX idx_audit_ts ON audit_log(ts DESC);
CREATE INDEX idx_audit_actor ON audit_log(actor_id, ts DESC);
CREATE INDEX idx_audit_chat ON audit_log(chat_id, ts DESC);
CREATE INDEX idx_audit_action ON audit_log(action, ts DESC);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);
