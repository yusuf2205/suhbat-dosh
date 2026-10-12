-- per-member chat controls: timed mute, "clear history" watermark, "delete chat" (hide until a new message)
ALTER TABLE members ADD COLUMN muted_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN cleared_before INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
