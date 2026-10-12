// Grant or revoke super-admin rights.  Usage: node scripts/make-admin.mjs +998901234567 [--revoke]
// In Docker:  docker exec suhbat-suhbat-1 node scripts/make-admin.mjs +998901234567
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [phone, flag] = process.argv.slice(2);
if (!/^\+\d{8,15}$/.test(phone || '')) {
  console.error('usage: node scripts/make-admin.mjs +<phone in E.164> [--revoke]');
  process.exit(2);
}
const db = new DatabaseSync(path.join(path.resolve(process.env.DATA_DIR || './data'), 'suhbat.db'));
db.exec('PRAGMA busy_timeout = 5000');
const u = db.prepare('SELECT id, name, is_admin FROM users WHERE phone = ?').get(phone);
if (!u) {
  console.error('no such user yet — register in the app first, then run this again (or set SUPERADMIN_PHONES)');
  process.exit(1);
}
const value = flag === '--revoke' ? 0 : 1;
db.prepare('UPDATE users SET is_admin = ? WHERE id = ?').run(value, u.id);
db.prepare("INSERT INTO audit_log (ts, actor_id, action, target_type, target_id, details) VALUES (?, NULL, ?, 'user', ?, ?)")
  .run(Date.now(), value ? 'admin.grant' : 'admin.revoke', String(u.id), JSON.stringify({ via: 'cli' }));
console.log(`${u.name}: super admin ${value ? 'GRANTED' : 'REVOKED'}`);
