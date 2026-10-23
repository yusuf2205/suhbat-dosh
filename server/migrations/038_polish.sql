-- Search that stays fast (FTS5, trigrams: finds any part of a word, any letter case, Cyrillic too), automatic folders,
-- scheduled messages that can be silent / wait until the person is online, replies counted per message.

-- ---- search index: the text, the speech-to-text of voice messages and the name of the attached file
CREATE VIRTUAL TABLE IF NOT EXISTS msg_fts USING fts5(body, tokenize = 'trigram case_sensitive 0');

INSERT INTO msg_fts (rowid, body)
  SELECT m.id, TRIM(COALESCE(m.text, '') || ' ' || COALESCE(t.text, '') || ' ' || COALESCE(f.name, ''))
  FROM messages m
  LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'done'
  LEFT JOIN files f ON f.id = m.file_id
  WHERE m.kind NOT IN ('secret', 'call');

CREATE TRIGGER IF NOT EXISTS msg_fts_ai AFTER INSERT ON messages WHEN NEW.kind NOT IN ('secret', 'call') BEGIN
  INSERT INTO msg_fts (rowid, body)
    VALUES (NEW.id, TRIM(COALESCE(NEW.text, '') || ' ' || COALESCE((SELECT name FROM files WHERE id = NEW.file_id), '')));
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_au AFTER UPDATE OF text ON messages WHEN NEW.kind NOT IN ('secret', 'call') BEGIN
  DELETE FROM msg_fts WHERE rowid = NEW.id;
  INSERT INTO msg_fts (rowid, body)
    VALUES (NEW.id, TRIM(COALESCE(NEW.text, '') || ' ' || COALESCE((SELECT text FROM transcripts WHERE message_id = NEW.id AND status = 'done'), '')
      || ' ' || COALESCE((SELECT name FROM files WHERE id = NEW.file_id), '')));
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_ad AFTER DELETE ON messages BEGIN
  DELETE FROM msg_fts WHERE rowid = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_tr AFTER INSERT ON transcripts WHEN NEW.status = 'done' BEGIN
  DELETE FROM msg_fts WHERE rowid = NEW.message_id;
  INSERT INTO msg_fts (rowid, body)
    SELECT m.id, TRIM(COALESCE(m.text, '') || ' ' || COALESCE(NEW.text, '') || ' ' || COALESCE((SELECT name FROM files WHERE id = m.file_id), ''))
    FROM messages m WHERE m.id = NEW.message_id;
END;
CREATE TRIGGER IF NOT EXISTS msg_fts_tu AFTER UPDATE OF text, status ON transcripts WHEN NEW.status = 'done' BEGIN
  DELETE FROM msg_fts WHERE rowid = NEW.message_id;
  INSERT INTO msg_fts (rowid, body)
    SELECT m.id, TRIM(COALESCE(m.text, '') || ' ' || COALESCE(NEW.text, '') || ' ' || COALESCE((SELECT name FROM files WHERE id = m.file_id), ''))
    FROM messages m WHERE m.id = NEW.message_id;
END;

-- ---- replies (a thread of answers to one message)
CREATE INDEX IF NOT EXISTS idx_messages_reply ON messages(reply_to) WHERE reply_to IS NOT NULL;

-- ---- folders: the chats come by a rule too (JSON: { include: [...], exclude: [...] })
ALTER TABLE folders ADD COLUMN rules TEXT NOT NULL DEFAULT '';

-- ---- scheduled messages
ALTER TABLE scheduled ADD COLUMN silent INTEGER NOT NULL DEFAULT 0;
ALTER TABLE scheduled ADD COLUMN when_online INTEGER NOT NULL DEFAULT 0;   -- direct chat: wait until the other person is online
