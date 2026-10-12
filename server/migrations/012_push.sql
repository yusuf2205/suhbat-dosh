-- Web Push subscriptions (browser / installed web app): messages reach the device while the app is closed.
CREATE TABLE push_subs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  ua          TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_push_user ON push_subs(user_id);
