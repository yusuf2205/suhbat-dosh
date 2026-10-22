-- History imported from another messenger (Telegram Desktop export) into a private chat of the person who imported it.
ALTER TABLE chats ADD COLUMN imported_from TEXT;
ALTER TABLE chats ADD COLUMN import_me TEXT;
ALTER TABLE messages ADD COLUMN import_author TEXT;
ALTER TABLE messages ADD COLUMN import_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_import ON messages(chat_id, import_key) WHERE import_key IS NOT NULL;
