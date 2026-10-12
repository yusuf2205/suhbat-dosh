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

export const db = new DatabaseSync(config.dbFile);
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
