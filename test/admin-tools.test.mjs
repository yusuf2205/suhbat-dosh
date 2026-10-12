// Super-admin tools: ban / delete, invitation-only registration, broadcast, backups, system health, call quality.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4900 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-adm-'));
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-bk-'));

before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error',
    DATA_DIR: dataDir, BACKUP_DIR: backupDir, SUPERADMIN_PHONES: '+998900000001', OTP_REQUESTS_PER_IP: '500',
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => server?.kill());

async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
}
async function login(phone, name, invite) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name, invite });
  return { status: v.status, error: v.data.error, cookie: v.headers.get('set-cookie')?.split(';')[0], user: v.data.user };
}

test('ban, delete, invitations, broadcast, backups, system, call quality', async () => {
  const root1 = await login('+998900000001', 'Root');
  assert.equal(root1.user.is_admin, true);
  const bob = await login('+998900000002', 'Bob');
  const eve = await login('+998900000003', 'Eve');
  const chat = (await call(bob.cookie, 'POST', '/api/chats/direct', { user_id: eve.user.id })).data.chat;
  await call(bob.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'hello eve' });

  // non-admins are refused
  assert.equal((await call(bob.cookie, 'POST', `/api/admin/users/${eve.user.id}/ban`, {})).status, 403);

  // ban: sessions die at once, sign-in refused, unban restores
  assert.equal((await call(root1.cookie, 'POST', `/api/admin/users/${eve.user.id}/ban`, { banned: true, reason: 'spam' })).status, 200);
  assert.equal((await call(eve.cookie, 'GET', '/api/me')).status, 401);
  const again = await login('+998900000003', 'Eve');
  assert.equal(again.status, 403);
  assert.equal(again.error, 'account_banned');
  assert.equal((await call(root1.cookie, 'POST', `/api/admin/users/${root1.user.id}/ban`, {})).status, 400, 'cannot ban yourself');
  await call(root1.cookie, 'POST', `/api/admin/users/${eve.user.id}/ban`, { banned: false });
  const back = await login('+998900000003', 'Eve');
  assert.equal(back.status, 200);

  // registration by invitation only
  assert.equal((await call(root1.cookie, 'PUT', '/api/admin/settings', { registration: 'invite' })).status, 200);
  const noInv = await login('+998900000010', 'Newbie');
  assert.equal(noInv.status, 403);
  assert.equal(noInv.error, 'invite_required');
  assert.equal((await login('+998900000010', 'Newbie', 'bogus-code')).error, 'invite_invalid');
  const inv = (await call(root1.cookie, 'POST', '/api/admin/invites', { note: 'for newbie', max_uses: 1 })).data.invite;
  assert.ok(inv.code);
  const ok = await login('+998900000010', 'Newbie', inv.code);
  assert.equal(ok.status, 200);
  const second = await login('+998900000011', 'Second', inv.code);
  assert.equal(second.error, 'invite_invalid', 'one-time invitation is used up');
  // existing accounts still sign in without any invitation
  assert.equal((await login('+998900000002', 'Bob')).status, 200);
  await call(root1.cookie, 'PUT', '/api/admin/settings', { registration: 'closed' });
  assert.equal((await login('+998900000012', 'Late', inv.code)).error, 'registration_closed');
  await call(root1.cookie, 'PUT', '/api/admin/settings', { registration: 'open' });

  // broadcast arrives as a normal chat from the service account
  const sent = await call(root1.cookie, 'POST', '/api/admin/broadcast', { text: 'Плановые работы в 03:00' });
  assert.ok(sent.data.sent >= 3);
  const chats = (await call(bob.cookie, 'GET', '/api/chats')).data.chats;
  const svc = chats.find((c) => c.peer?.name === 'Suhbat-dosh');
  assert.ok(svc, 'service chat exists');
  assert.equal(svc.last_message.text, 'Плановые работы в 03:00');
  assert.equal(svc.peer.is_bot, true);

  // new-device alert lands in the service chat
  const bobAgain = await fetch(`${BASE}/api/auth/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+998900000002' }) });
  const code = (await bobAgain.json()).dev_code;
  const vv = await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'BrandNewPhone/9.9' }, body: JSON.stringify({ phone: '+998900000002', code }) });
  assert.equal(vv.status, 200);
  const after2 = (await call(bob.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.peer?.name === 'Suhbat-dosh');
  assert.match(after2.last_message.text, /Новый вход/);

  // backups
  const made = await call(root1.cookie, 'POST', '/api/admin/backups', {});
  assert.equal(made.status, 201);
  const list = (await call(root1.cookie, 'GET', '/api/admin/backups')).data.backups;
  assert.ok(list.some((b) => b.name === made.data.backup.name));
  const dl = await fetch(`${BASE}/api/admin/backups/${made.data.backup.name}`, { headers: { cookie: root1.cookie } });
  assert.equal(dl.status, 200);
  assert.ok((await dl.arrayBuffer()).byteLength > 4096);
  assert.equal((await call(root1.cookie, 'GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await call(root1.cookie, 'POST', `/api/admin/backups/${made.data.backup.name}/restore`, {})).status, 400, 'restore needs confirmation');

  // system health
  const sys = (await call(root1.cookie, 'GET', '/api/admin/system')).data;
  assert.ok(sys.now.disk_total > 0);
  assert.ok(Array.isArray(sys.series));

  // call quality list
  assert.equal((await call(root1.cookie, 'GET', '/api/admin/call-quality')).status, 200);

  // delete account: its personal chat disappears for the peer
  assert.equal((await call(root1.cookie, 'DELETE', `/api/admin/users/${eve.user.id}`)).status, 200);
  const bobChats = (await call(bob.cookie, 'GET', '/api/chats')).data.chats;
  assert.ok(!bobChats.some((c) => c.id === chat.id));
  assert.equal((await call(root1.cookie, 'DELETE', `/api/admin/users/${root1.user.id}`)).status, 400);
});
