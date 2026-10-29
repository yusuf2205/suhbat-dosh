-- The daily check that everything is recorded: one row per run (when, how it started, the verdict, every check with its result).
CREATE TABLE IF NOT EXISTS integrity_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  trigger     TEXT NOT NULL DEFAULT 'auto',
  ok          INTEGER NOT NULL DEFAULT 1,
  bad         INTEGER NOT NULL DEFAULT 0,
  warn        INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  checks      TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_integrity_ts ON integrity_runs(ts);
