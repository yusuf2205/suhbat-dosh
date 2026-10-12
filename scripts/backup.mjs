// Consistent online backup: SQLite snapshot (VACUUM INTO) + uploaded files, then an integrity check.
// Usage: node scripts/backup.mjs        (env: DATA_DIR, BACKUP_DIR, BACKUP_KEEP)
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { verify } from './verify-lib.mjs';

const dataDir = path.resolve(process.env.DATA_DIR || './data');
const backupRoot = path.resolve(process.env.BACKUP_DIR || (fs.existsSync('/backups') ? '/backups' : './backups'));
const keep = Number(process.env.BACKUP_KEEP) || 14;

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = path.join(backupRoot, `suhbat-${stamp}`);
fs.mkdirSync(path.join(dest, 'files'), { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'suhbat.db'));
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`VACUUM INTO '${path.join(dest, 'suhbat.db').replace(/'/g, "''")}'`);
db.close();

const src = path.join(dataDir, 'files');
let copied = 0;
for (const f of fs.existsSync(src) ? fs.readdirSync(src) : []) {
  fs.copyFileSync(path.join(src, f), path.join(dest, 'files', f));
  copied++;
}

const report = verify(dest);
if (!report.ok) {
  console.error('BACKUP VERIFICATION FAILED:', report.problems.join('; '));
  process.exit(1);
}
console.log(`backup ok: ${dest} (${report.users} users, ${report.messages} messages, ${copied} files)`);

// retention
const all = fs.readdirSync(backupRoot).filter((n) => n.startsWith('suhbat-')).sort();
for (const old of all.slice(0, Math.max(0, all.length - keep))) {
  fs.rmSync(path.join(backupRoot, old), { recursive: true, force: true });
}
