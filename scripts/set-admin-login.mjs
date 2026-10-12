// Sets (or resets) the login + password of a super administrator. Use it if the password was forgotten.
//   docker exec -it suhbat-suhbat-1 node scripts/set-admin-login.mjs <phone-or-user-id> <login> <password>
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { hashPassword } from '../server/src/passwords.js';

const [who, login, password] = process.argv.slice(2);
if (!who || !login || !password || password.length < 10) {
  console.error('usage: set-admin-login.mjs <phone-or-user-id> <login> <password (10+ characters)>');
  process.exit(1);
}
const db = new DatabaseSync(path.join(path.resolve(process.env.DATA_DIR || './data'), 'suhbat.db'));
db.exec('PRAGMA busy_timeout = 10000');
const u = /^\d+$/.test(who) && who.length < 8
  ? db.prepare('SELECT id, name, is_admin FROM users WHERE id = ?').get(Number(who))
  : db.prepare('SELECT id, name, is_admin FROM users WHERE phone = ?').get(who.startsWith('+') ? who : `+${who}`);
if (!u) { console.error('user not found'); process.exit(1); }
db.prepare('UPDATE users SET is_admin = 1, admin_login = ?, admin_pass = ? WHERE id = ?').run(login.trim().toLowerCase(), hashPassword(password), u.id);
console.log(`ok: ${u.name} (#${u.id}) now signs in to the admin console with login "${login.trim().toLowerCase()}"`);
