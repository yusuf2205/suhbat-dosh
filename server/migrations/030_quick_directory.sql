-- Quick replies (a person's own text snippets) and the directory of public channels and groups.
CREATE TABLE IF NOT EXISTS quick_replies (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  shortcut   TEXT NOT NULL,
  text       TEXT NOT NULL,
  position   INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_quick_user_shortcut ON quick_replies(user_id, shortcut);

ALTER TABLE chats ADD COLUMN is_public INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_chats_public ON chats(is_public) WHERE is_public = 1;
