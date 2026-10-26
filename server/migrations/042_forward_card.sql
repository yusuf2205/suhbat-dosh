-- A forwarded message carries a personal note from the person who passed it on and the path it travelled (who wrote it, who passed it on).
ALTER TABLE messages ADD COLUMN forward_note TEXT;
ALTER TABLE messages ADD COLUMN forward_hops TEXT;   -- JSON array of names, the author first
