-- Telegram bridge, full synchronisation: what was deleted in Telegram is marked here (never removed); personal chats may be answered from here.
ALTER TABLE messages ADD COLUMN tg_deleted INTEGER NOT NULL DEFAULT 0;
UPDATE tg_chats SET two_way = 1 WHERE kind = 'user';
