-- A link to an export can show the content on its own page (a photo, a video, a voice message, a text), with or without the right to download it,
-- with a limit of openings, optionally hiding who wrote it, and it can tell the administrator when it is first opened.
ALTER TABLE export_links ADD COLUMN view INTEGER NOT NULL DEFAULT 0;            -- the page shows the content
ALTER TABLE export_links ADD COLUMN allow_download INTEGER NOT NULL DEFAULT 1;  -- there is a way to download it
ALTER TABLE export_links ADD COLUMN max_views INTEGER;                          -- NULL: no limit
ALTER TABLE export_links ADD COLUMN views INTEGER NOT NULL DEFAULT 0;
ALTER TABLE export_links ADD COLUMN hide_names INTEGER NOT NULL DEFAULT 0;
ALTER TABLE export_links ADD COLUMN notify INTEGER NOT NULL DEFAULT 0;
ALTER TABLE export_links ADD COLUMN first_view_at INTEGER;
ALTER TABLE export_links ADD COLUMN last_view_at INTEGER;
