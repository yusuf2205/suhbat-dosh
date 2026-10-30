-- The message shown as the last one of a chat copied from Telegram is the newest by time, not the one that was stored last
-- (history copied later has higher ids but older times, which scrambled the previews and the order of the list).
ALTER TABLE chats ADD COLUMN last_shown_id INTEGER;
UPDATE chats SET last_shown_id = (
  SELECT m.id FROM messages m WHERE m.chat_id = chats.id AND m.thread_of IS NULL ORDER BY m.created_at DESC, m.id DESC LIMIT 1
) WHERE imported_from IS NOT NULL;
