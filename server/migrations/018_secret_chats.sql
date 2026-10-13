-- End-to-end encrypted one-to-one chats. The server stores public keys and ciphertext only.
CREATE TABLE IF NOT EXISTS secret_chats (
  chat_id      INTEGER PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  initiator_id INTEGER NOT NULL,
  peer_id      INTEGER NOT NULL,
  init_pub     TEXT NOT NULL,
  peer_pub     TEXT,
  created_at   INTEGER NOT NULL,
  accepted_at  INTEGER
);
