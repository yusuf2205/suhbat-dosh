CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  phone         TEXT NOT NULL UNIQUE,
  username      TEXT UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  bio           TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT '',
  avatar_file   TEXT,
  privacy_photo      TEXT NOT NULL DEFAULT 'everyone',
  privacy_status     TEXT NOT NULL DEFAULT 'everyone',
  privacy_last_seen  TEXT NOT NULL DEFAULT 'everyone',
  last_seen     INTEGER NOT NULL,
  created_at    INTEGER NOT NULL
);

CREATE TABLE otp_codes (
  phone       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

CREATE TABLE sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE,
  device       TEXT NOT NULL DEFAULT '',
  ip           TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_active  INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE blocks (
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, blocked_id)
);

CREATE TABLE chats (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  type             TEXT NOT NULL CHECK (type IN ('direct','group','channel')),
  title            TEXT NOT NULL DEFAULT '',
  description      TEXT NOT NULL DEFAULT '',
  owner_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  invite_code      TEXT UNIQUE,
  direct_key       TEXT UNIQUE,            -- "minId:maxId" for direct chats
  pinned_message_id INTEGER,
  last_message_id  INTEGER,
  last_message_at  INTEGER NOT NULL,
  created_at       INTEGER NOT NULL
);

CREATE TABLE members (
  chat_id            INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  user_id            INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  muted              INTEGER NOT NULL DEFAULT 0,
  can_send           INTEGER NOT NULL DEFAULT 1,
  banned             INTEGER NOT NULL DEFAULT 0,
  last_read_id       INTEGER NOT NULL DEFAULT 0,
  last_delivered_id  INTEGER NOT NULL DEFAULT 0,
  draft              TEXT NOT NULL DEFAULT '',
  joined_at          INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX idx_members_user ON members(user_id);

CREATE TABLE files (
  id          TEXT PRIMARY KEY,            -- random 128-bit id, not guessable
  owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id     INTEGER REFERENCES chats(id) ON DELETE CASCADE,  -- NULL for avatars
  name        TEXT NOT NULL,
  mime        TEXT NOT NULL,               -- detected server-side, never trusted from client
  size        INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id      INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  sender_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  client_id    TEXT,                       -- idempotency key from the sending device
  kind         TEXT NOT NULL DEFAULT 'text',
  text         TEXT NOT NULL DEFAULT '',
  reply_to     INTEGER REFERENCES messages(id) ON DELETE SET NULL,
  forward_from TEXT,
  file_id      TEXT REFERENCES files(id) ON DELETE SET NULL,
  duration     INTEGER,
  edited_at    INTEGER,
  created_at   INTEGER NOT NULL
);
CREATE INDEX idx_messages_chat ON messages(chat_id, id);
CREATE UNIQUE INDEX idx_messages_client ON messages(chat_id, sender_id, client_id) WHERE client_id IS NOT NULL;

CREATE TABLE reactions (
  message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,
  PRIMARY KEY (message_id, user_id, emoji)
);
