-- Whether the other side of a mirrored chat is in Telegram right now, and when they were last there (as much as their privacy settings tell).
ALTER TABLE tg_chats ADD COLUMN tg_online_until INTEGER NOT NULL DEFAULT 0;   -- online until this moment (ms); 0 = not online
ALTER TABLE tg_chats ADD COLUMN tg_seen INTEGER NOT NULL DEFAULT 0;           -- last seen (ms); 0 = unknown
ALTER TABLE tg_chats ADD COLUMN tg_approx TEXT NOT NULL DEFAULT '';           -- 'recently' | 'week' | 'month' when Telegram hides the exact time
