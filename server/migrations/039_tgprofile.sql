-- What Telegram knows about the other side of a mirrored chat: @username, phone number, profile photo (the chat shows it like a contact).
ALTER TABLE tg_chats ADD COLUMN tg_username TEXT NOT NULL DEFAULT '';
ALTER TABLE tg_chats ADD COLUMN tg_phone TEXT NOT NULL DEFAULT '';
ALTER TABLE tg_chats ADD COLUMN tg_photo TEXT NOT NULL DEFAULT '';   -- Telegram's id of the photo that is stored now
ALTER TABLE chats ADD COLUMN avatar_file TEXT;
