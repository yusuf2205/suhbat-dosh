-- Resumable, chunked uploads: the partial file lives next to the stored files until it is complete.
CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  chat_id    INTEGER NOT NULL,
  client_id  TEXT NOT NULL,
  name       TEXT NOT NULL,
  size       INTEGER NOT NULL,
  caption    TEXT NOT NULL DEFAULT '',
  voice      INTEGER NOT NULL DEFAULT 0,
  duration   INTEGER,
  reply_to   INTEGER,
  waveform   TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS uploads_client ON uploads(user_id, client_id);
