-- messages are shown by the time they were written (history that is copied later has higher ids but older times)
CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, created_at, id);
