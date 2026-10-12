// Verify that a backup is restorable without touching live data.
// Usage: node scripts/restore-check.mjs [backup-dir]   (default: newest backup)
import fs from 'node:fs';
import path from 'node:path';
import { verify } from './verify-lib.mjs';

const root = path.resolve(process.env.BACKUP_DIR || (fs.existsSync('/backups') ? '/backups' : './backups'));
let dir = process.argv[2];
if (!dir) {
  const all = fs.existsSync(root) ? fs.readdirSync(root).filter((n) => n.startsWith('suhbat-')).sort() : [];
  if (!all.length) { console.error('no backups found in', root); process.exit(1); }
  dir = path.join(root, all.at(-1));
}
const r = verify(path.resolve(dir));
if (!r.ok) {
  console.error(`NOT restorable: ${dir}\n - ${r.problems.join('\n - ')}`);
  process.exit(1);
}
console.log(`restorable: ${dir} (${r.users} users, ${r.messages} messages)`);
