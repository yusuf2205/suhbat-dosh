-- Exports of messages (a chat, or everything one person wrote) that the administrator hands out as a link with limits:
-- how long it works, how many times it can be opened, an optional password; it can be revoked at any moment.
CREATE TABLE IF NOT EXISTS export_links (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  token          TEXT NOT NULL UNIQUE,
  scope          TEXT NOT NULL,                 -- 'chat' | 'user'
  scope_id       INTEGER NOT NULL,
  title          TEXT NOT NULL DEFAULT '',
  format         TEXT NOT NULL DEFAULT 'zip',   -- zip | html | txt | json
  media          INTEGER NOT NULL DEFAULT 0,    -- the files of the messages go into the archive
  since          INTEGER,
  until          INTEGER,
  note           TEXT NOT NULL DEFAULT '',
  created_by     INTEGER NOT NULL,
  created_at     INTEGER NOT NULL,
  expires_at     INTEGER NOT NULL,
  max_downloads  INTEGER,                       -- NULL: no limit
  downloads      INTEGER NOT NULL DEFAULT 0,
  pass_hash      TEXT,
  revoked_at     INTEGER,
  last_download_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_export_links_created ON export_links(created_at);
