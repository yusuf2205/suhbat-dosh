-- Cached link previews (title, description, picture); the picture file is kept next to the other files as lp-<hash>.
CREATE TABLE IF NOT EXISTS link_previews (
  key         TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  ok          INTEGER NOT NULL DEFAULT 0,
  title       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  site        TEXT NOT NULL DEFAULT '',
  image_file  TEXT,
  hash        TEXT,
  fetched_at  INTEGER NOT NULL
);
