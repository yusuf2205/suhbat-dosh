-- Topics of a Telegram forum group copied by the bridge: each one remembers the id it has in Telegram.
ALTER TABLE topics ADD COLUMN tg_topic INTEGER;
ALTER TABLE topics ADD COLUMN color INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_topics_tg ON topics(chat_id, tg_topic) WHERE tg_topic IS NOT NULL;
