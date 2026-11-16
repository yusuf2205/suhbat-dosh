-- An album: several pictures / videos sent as one block. Each one stays a message of its own (so forwarding, deleting, reading
-- and the copy from Telegram keep working as before); the messages of one album share this key and are drawn together.
ALTER TABLE messages ADD COLUMN album_id TEXT;
ALTER TABLE uploads ADD COLUMN album_id TEXT;
CREATE INDEX IF NOT EXISTS idx_messages_album ON messages(chat_id, album_id) WHERE album_id IS NOT NULL;
