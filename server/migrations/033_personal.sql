-- Safety checks of a conversation partner, a different name and animal avatar in each group, stories for chosen people only.
CREATE TABLE IF NOT EXISTS verified_peers (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  peer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  number  TEXT NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, peer_id)
);

ALTER TABLE members ADD COLUMN alias_name TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN alias_animal TEXT NOT NULL DEFAULT '';

ALTER TABLE stories ADD COLUMN restricted INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS story_audience (
  story_id INTEGER NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (story_id, user_id)
);
CREATE TABLE IF NOT EXISTS story_lists (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name     TEXT NOT NULL,
  members  TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_story_lists_owner ON story_lists(owner_id);
