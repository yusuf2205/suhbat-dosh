// Presence (busy / away) and the auto-reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6060 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-dr-')), REGISTRATION_OPEN: '1',
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no start');
});
after(() => server?.kill());

async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const signup = (username) => call('', 'POST', '/api/auth/register', { name: username, username, password: 'longenough1' });

const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n');
async function upload(cookie, chatId, name) {
  const r = await fetch(`${BASE}/api/chats/${chatId}/files?name=${encodeURIComponent(name)}&client_id=up-${Math.random().toString(36).slice(2, 12)}`, { method: 'POST', headers: { cookie }, body: pdf });
  return (await r.json()).message;
}
const getFile = async (cookie, id) => (await fetch(`${BASE}/api/files/${id}`, { headers: { cookie } })).status;

test('time-limited access to a message file', async () => {
  const a = await signup('alice_dr');
  const b = await signup('boris_dr');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const m = await upload(a.cookie, chat.id, 'doc.pdf');
  assert.equal(await getFile(b.cookie, m.file.id), 200);
  const own = await call(b.cookie, 'PATCH', `/api/messages/${m.id}/access`, { seconds: 3600 });
  assert.equal(own.status, 404); // only the sender can limit access
  const lim = await call(a.cookie, 'PATCH', `/api/messages/${m.id}/access`, { seconds: 3600 });
  assert.equal(lim.status, 200);
  assert.ok(lim.data.message.access_until > Date.now());
  assert.equal(await getFile(b.cookie, m.file.id), 200);
  await call(a.cookie, 'PATCH', `/api/messages/${m.id}/access`, { seconds: 0 });
  assert.equal(await getFile(b.cookie, m.file.id), 404);
  assert.equal(await getFile(a.cookie, m.file.id), 200); // the sender keeps it
  await call(a.cookie, 'PATCH', `/api/messages/${m.id}/access`, {});
  assert.equal(await getFile(b.cookie, m.file.id), 200); // limit removed
});

test('drive: keep a file, share it with a password, download once', async () => {
  const a = await signup('alice_dv');
  const b = await signup('boris_dv');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const m = await upload(a.cookie, chat.id, 'plan.pdf');
  const none = await call(b.cookie, 'POST', '/api/drive', { file_id: 'x'.repeat(22) });
  assert.equal(none.status, 404);
  const add = await call(b.cookie, 'POST', '/api/drive', { file_id: m.file.id, folder: 'Работа' });
  assert.equal(add.status, 201);
  const list = await call(b.cookie, 'GET', '/api/drive');
  assert.equal(list.data.items.length, 1);
  assert.deepEqual(list.data.folders, ['Работа']);
  const itemId = add.data.item.id;
  const sh = await call(b.cookie, 'POST', `/api/drive/${itemId}/share`, { password: 'secret1', ttl_hours: 1, max_downloads: 1 });
  assert.equal(sh.status, 201);
  const token = sh.data.share.token;
  const meta = await call('', 'GET', `/api/s/${token}/meta`);
  assert.equal(meta.data.needs_password, true);
  assert.equal(meta.data.name, 'plan.pdf');
  const bad = await call('', 'POST', `/api/s/${token}/unlock`, { password: 'nope' });
  assert.equal(bad.status, 403);
  const ok = await call('', 'POST', `/api/s/${token}/unlock`, { password: 'secret1' });
  assert.equal(ok.status, 200);
  const dl = await fetch(BASE + ok.data.url);
  assert.equal(dl.status, 200);
  assert.deepEqual(Buffer.from(await dl.arrayBuffer()), pdf);
  // the limit of one download is used up
  const again = await call('', 'POST', `/api/s/${token}/unlock`, { password: 'secret1' });
  assert.equal(again.status, 404);
  // another user cannot see or revoke it
  const other = await call(a.cookie, 'GET', `/api/drive/${itemId}/shares`);
  assert.equal(other.status, 404);
  // removing the drive entry revokes links
  const sh2 = await call(b.cookie, 'POST', `/api/drive/${itemId}/share`, {});
  await call(b.cookie, 'DELETE', `/api/drive/${itemId}`);
  assert.equal((await call('', 'GET', `/api/s/${sh2.data.share.token}/meta`)).status, 404);
});

test('my data: summary, security log, deleting my own account', async () => {
  const a = await signup('alice_md');
  const b = await signup('boris_md');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'привет', client_id: 'cid-md-0000001' });
  const sum = await call(a.cookie, 'GET', '/api/me/data');
  assert.equal(sum.data.messages, 1);
  assert.ok(sum.data.sessions >= 1);
  await call('', 'POST', '/api/auth/login', { login: 'alice_md', password: 'wrongwrong1' });
  const log = await call(a.cookie, 'GET', '/api/me/activity');
  assert.ok(log.data.events.some((e) => e.action === 'auth.login_failed'), JSON.stringify(log));
  assert.equal((await call(a.cookie, 'DELETE', '/api/me', { confirm: 'no', password: 'longenough1' })).status, 400);
  assert.equal((await call(a.cookie, 'DELETE', '/api/me', { confirm: 'DELETE', password: 'wrong-wrong' })).status, 403);
  const del = await call(a.cookie, 'DELETE', '/api/me', { confirm: 'DELETE', password: 'longenough1' });
  assert.equal(del.status, 200);
  assert.equal((await call(a.cookie, 'GET', '/api/me')).status, 401);
  assert.equal((await call('', 'POST', '/api/auth/login', { login: 'alice_md', password: 'longenough1' })).status, 401);
  const chats = (await call(b.cookie, 'GET', '/api/chats')).data.chats;
  assert.equal(chats.filter((c) => c.id === chat.id).length, 0);
});
