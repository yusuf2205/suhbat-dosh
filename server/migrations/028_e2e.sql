-- End-to-end encrypted groups. The server stores device public keys and the group key wrapped separately for every device;
-- it never sees a group key or a plaintext message. A new key (epoch) is made when somebody leaves or is removed.
ALTER TABLE chats ADD COLUMN e2e INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN e2e_epoch INTEGER NOT NULL DEFAULT 0;
ALTER TABLE chats ADD COLUMN e2e_rotate INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS e2e_devices (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  pub        TEXT NOT NULL,
  name       TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  seen_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_e2e_devices_user ON e2e_devices(user_id);

CREATE TABLE IF NOT EXISTS e2e_keys (
  chat_id    INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  epoch      INTEGER NOT NULL,
  device_id  TEXT NOT NULL REFERENCES e2e_devices(id) ON DELETE CASCADE,
  wrapped    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, epoch, device_id)
);
