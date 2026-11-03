import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { log } from './util.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(here, '../migrations');

// A restore requested from the admin console is applied here, before the database is opened.
(function applyPendingRestore() {
  const flag = path.join(config.dataDir, 'restore.pending');
  if (!fs.existsSync(flag)) return;
  try {
    const name = path.basename(fs.readFileSync(flag, 'utf8').trim());
    const src = path.join(config.backupDir, name);
    if (name.endsWith('.db') && fs.existsSync(src)) {
      fs.mkdirSync(config.backupDir, { recursive: true });
      if (fs.existsSync(config.dbFile)) fs.copyFileSync(config.dbFile, path.join(config.backupDir, `pre-restore-${Date.now()}.db`));
      for (const ext of ['-wal', '-shm']) fs.rmSync(config.dbFile + ext, { force: true });
      fs.copyFileSync(src, config.dbFile);
      log('info', 'database restored from backup', { name });
    }
  } catch (e) {
    log('error', 'restore failed', { err: e.message });
  } finally {
    fs.rmSync(flag, { force: true });
  }
}());

// Uploaded files but no database: the disk holding the database is not mounted yet (an SSD volume after a reboot), and Docker
// gave the container an empty folder in its place. Starting would make a new empty messenger there; failing makes Docker try
// again until the disk is back. ALLOW_NEW_DB=1 starts afresh on purpose.
(function refuseMissingDatabase() {
  if (fs.existsSync(config.dbFile) || process.env.ALLOW_NEW_DB === '1') return;
  let dir;
  try { dir = fs.opendirSync(config.filesDir); } catch { return; }
  try {
    for (let e = dir.readSync(); e; e = dir.readSync()) {
      if (e.name.startsWith('.')) continue;
      log('error', 'database missing while uploaded files exist: is its disk mounted?', { db: config.dbFile });
      process.exit(1);
    }
  } finally { try { dir.closeSync(); } catch { /* already closed */ } }
}());

// The only place that talks to the database driver: everything else goes through q, tx and the helpers below,
// so that another engine (PostgreSQL) means rewriting this file and the SQL dialect, not 40 modules.
const db = new DatabaseSync(config.dbFile);
// SQLite's own LIKE and LOWER know only Latin letters: searching "привет" must also find "Привет"
db.function('lc', { deterministic: true }, (s) => (s == null ? '' : String(s).toLowerCase()));
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA busy_timeout = 5000;');
db.exec('PRAGMA synchronous = NORMAL;');

export function migrate() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');
  const applied = new Set(db.prepare('SELECT name FROM schema_migrations').all().map((r) => r.name));
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, f), 'utf8');
    tx(() => {
      db.exec(sql);
      db.prepare('INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)').run(f, Date.now());
    });
    log('info', 'migration applied', { name: f });
  }
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export const q = {
  get: (sql, ...p) => db.prepare(sql).get(...p),
  all: (sql, ...p) => db.prepare(sql).all(...p),
  run: (sql, ...p) => db.prepare(sql).run(...p),
};

/** Answers while the database answers (the health check). */
export function ping() {
  db.prepare('SELECT 1').get();
}

/** A consistent copy of the whole database in a new file, made while the server keeps working. */
export function snapshotTo(dest) {
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
}

/** At shutdown: the write-ahead log is folded into the main file, then the file is closed. */
export function closeDatabase() {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}
