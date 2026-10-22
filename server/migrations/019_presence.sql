-- "Busy" / "Away" presence and an optional auto-reply.
ALTER TABLE users ADD COLUMN presence TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN auto_reply TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN auto_reply_on INTEGER NOT NULL DEFAULT 0;
-- one auto-reply per sender per 12 hours
CREATE TABLE IF NOT EXISTS auto_replied (
  user_id INTEGER NOT NULL,
  peer_id INTEGER NOT NULL,
  at      INTEGER NOT NULL,
  PRIMARY KEY (user_id, peer_id)
);
