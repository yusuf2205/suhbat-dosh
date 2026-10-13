-- Personal sticker collection (animated TGS / Lottie, WebP, PNG) and the cache of animated emoji.
CREATE TABLE IF NOT EXISTS stickers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id    TEXT NOT NULL,
  emoji      TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stickers_user ON stickers(user_id);
CREATE TABLE IF NOT EXISTS anim_files (
  cp      TEXT PRIMARY KEY,
  file_id TEXT NOT NULL
);
