-- Automatic text of voice messages (made on this server by the speech-to-text service, never by an outside API).
CREATE TABLE IF NOT EXISTS transcripts (
  message_id   INTEGER PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  status       TEXT NOT NULL CHECK (status IN ('pending','done','error')),
  lang         TEXT,
  text         TEXT,
  words        TEXT,           -- JSON [[word, probability], ...]
  model        TEXT,
  error        TEXT,
  requested_by INTEGER,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
