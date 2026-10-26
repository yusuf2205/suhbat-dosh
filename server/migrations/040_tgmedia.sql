-- Messages of a mirrored chat whose file cannot be fetched from Telegram (too big, deleted, a blocked type): not asked for again.
CREATE TABLE IF NOT EXISTS tg_media_skip (
  message_id INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  reason TEXT NOT NULL DEFAULT '',
  at INTEGER NOT NULL
);
