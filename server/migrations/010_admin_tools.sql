-- Admin tools: account bans, runtime settings, invitation links.
ALTER TABLE users ADD COLUMN banned_at INTEGER;
ALTER TABLE users ADD COLUMN ban_reason TEXT;

CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

CREATE TABLE invites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE,
  note        TEXT NOT NULL DEFAULT '',
  created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER,
  max_uses    INTEGER NOT NULL DEFAULT 1,
  uses        INTEGER NOT NULL DEFAULT 0
);

-- an invitation code carried through "Sign in with Telegram"
ALTER TABLE login_tokens ADD COLUMN invite TEXT;
