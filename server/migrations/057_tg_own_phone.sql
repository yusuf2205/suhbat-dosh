-- The phone number of the Telegram account itself (what Telegram tells the bridge about its owner): the admin console shows both sides of a copied chat.
ALTER TABLE tg_bridge ADD COLUMN tg_phone TEXT NOT NULL DEFAULT '';
