import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Open a backup directory read-only and check it is a restorable copy. */
export function verify(dir) {
  const problems = [];
  const dbFile = path.join(dir, 'suhbat.db');
  if (!fs.existsSync(dbFile)) return { ok: false, problems: ['suhbat.db missing'], users: 0, messages: 0 };
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const ic = db.prepare('PRAGMA integrity_check').get();
    if (Object.values(ic)[0] !== 'ok') problems.push(`integrity_check: ${Object.values(ic)[0]}`);
    const fk = db.prepare('PRAGMA foreign_key_check').all();
    if (fk.length) problems.push(`${fk.length} foreign key violations`);
    const users = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
    const messages = db.prepare('SELECT COUNT(*) AS n FROM messages').get().n;
    for (const f of db.prepare('SELECT id, size FROM files').all()) {
      const p = path.join(dir, 'files', f.id);
      if (!fs.existsSync(p)) problems.push(`file ${f.id} missing`);
      else if (fs.statSync(p).size !== f.size) problems.push(`file ${f.id} size mismatch`);
    }
    return { ok: problems.length === 0, problems, users, messages };
  } finally {
    db.close();
  }
}
