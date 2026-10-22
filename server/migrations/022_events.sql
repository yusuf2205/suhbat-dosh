-- Meetings / events posted into chats, with RSVP and reminders.
CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id  INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  chat_id     INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  creator_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  location    TEXT NOT NULL DEFAULT '',
  start_at    INTEGER NOT NULL,
  end_at      INTEGER NOT NULL,
  meeting     INTEGER NOT NULL DEFAULT 0,
  canceled    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_at);
CREATE INDEX IF NOT EXISTS idx_events_chat ON events(chat_id);

CREATE TABLE IF NOT EXISTS event_rsvp (
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status   TEXT NOT NULL CHECK (status IN ('yes','maybe','no')),
  PRIMARY KEY (event_id, user_id)
);

-- a reminder row can point at the event it belongs to, so it is removed when the answer changes
ALTER TABLE scheduled ADD COLUMN ref TEXT;
CREATE INDEX IF NOT EXISTS idx_scheduled_ref ON scheduled(ref);
