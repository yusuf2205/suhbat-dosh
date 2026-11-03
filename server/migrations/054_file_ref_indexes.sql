-- The hourly search for unattached files read every message once per file (37 000 x 94 000 rows: about four minutes,
-- during which the server answered nobody). With these it looks each file up directly.
CREATE INDEX IF NOT EXISTS idx_messages_file ON messages(file_id) WHERE file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_users_avatar_file ON users(avatar_file) WHERE avatar_file IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_profile_photos_file ON profile_photos(file_id);
CREATE INDEX IF NOT EXISTS idx_stories_file ON stories(file_id);
