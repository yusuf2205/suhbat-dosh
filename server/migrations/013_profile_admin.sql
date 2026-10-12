-- Admin sign-in with login + password, birthday, profile photo album.
ALTER TABLE users ADD COLUMN admin_login TEXT;
ALTER TABLE users ADD COLUMN admin_pass TEXT;
CREATE UNIQUE INDEX idx_users_admin_login ON users(admin_login) WHERE admin_login IS NOT NULL;

ALTER TABLE users ADD COLUMN birthday TEXT;                       -- 'YYYY-MM-DD' or '--MM-DD' (no year)
ALTER TABLE users ADD COLUMN privacy_birthday TEXT NOT NULL DEFAULT 'contacts';

CREATE TABLE profile_photos (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_profile_photos_user ON profile_photos(user_id, id);

-- existing avatars become the first album photo
INSERT INTO profile_photos (user_id, file_id, created_at)
  SELECT id, avatar_file, created_at FROM users WHERE avatar_file IS NOT NULL;
