-- When a copied message was deleted in Telegram, and by whom when that is known (Telegram itself never says: only a deletion of the whole chat from here is certain).
ALTER TABLE messages ADD COLUMN tg_deleted_at INTEGER;
ALTER TABLE messages ADD COLUMN tg_deleted_by INTEGER;
