-- Whose conversations each administrator may read: everybody, everybody but these people, or only these people.
ALTER TABLE users ADD COLUMN admin_read_mode TEXT NOT NULL DEFAULT 'all';
CREATE TABLE admin_read_people (
  admin_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (admin_id, user_id)
) WITHOUT ROWID;
CREATE INDEX idx_messages_sender ON messages(sender_id, chat_id);
