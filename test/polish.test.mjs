// Search index (FTS5), automatic folders and their order, scheduled messages (silent / edit / when online), threads of replies,
// backup retention and verification, the administrator's storage overview.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5300 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-pol-'));
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-polbk-'));
let server;

before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error',
    DATA_DIR: dataDir, BACKUP_DIR: backupDir, SUPERADMIN_PHONES: '+998900000031', OTP_REQUESTS_PER_IP: '500',
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
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.headers.get('set-cookie').split(';')[0], user: v.data.user };
}

test('search finds parts of words in any letter case, pages through results and respects membership', async () => {
  const a = await login('+998900000031', 'Admin');
  const b = await login('+998900000032', 'Bek');
  const c = await login('+998900000033', 'Cem');
  const dm = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  const other = (await call(b.cookie, 'POST', '/api/chats/direct', { user_id: c.user.id })).data.chat;
  for (const text of ['Привет, как ДЕЛА?', 'Ўзбекистон — гўзал юрт', 'Hello Wonderful World', 'встреча в понедельник']) {
    await call(a.cookie, 'POST', `/api/chats/${dm.id}/messages`, { text });
  }
  await call(b.cookie, 'POST', `/api/chats/${other.id}/messages`, { text: 'секретное слово привет' });

  const find = async (q, cookie = a.cookie) => (await call(cookie, 'GET', `/api/search/messages?q=${encodeURIComponent(q)}`)).data.messages.map((m) => m.text);
  assert.deepEqual(await find('ПРИВЕТ'), ['Привет, как ДЕЛА?'], 'upper case finds mixed case');
  assert.deepEqual(await find('дела'), ['Привет, как ДЕЛА?'], 'lower case finds upper case');
  assert.deepEqual(await find('ривет'), ['Привет, как ДЕЛА?'], 'a part of a word');
  assert.deepEqual(await find('ўзбек'), ['Ўзбекистон — гўзал юрт'], 'Uzbek Cyrillic');
  assert.deepEqual(await find('wonder world'), ['Hello Wonderful World'], 'several words, in any order');
  assert.deepEqual(await find('в по'), ['встреча в понедельник'], 'a short word next to a long one');
  assert.deepEqual(await find('xyzzy'), []);
  assert.deepEqual(await find('привет', c.cookie), ['секретное слово привет'], 'only chats the person is in');

  // an edit changes what is found, a delete removes it
  const m = (await call(a.cookie, 'POST', `/api/chats/${dm.id}/messages`, { text: 'старый текст' })).data.message;
  assert.equal((await find('старый')).length, 1);
  await call(a.cookie, 'PATCH', `/api/messages/${m.id}`, { text: 'новый текст' });
  assert.equal((await find('старый')).length, 0);
  assert.equal((await find('новый')).length, 1);
  await call(a.cookie, 'DELETE', `/api/messages/${m.id}`);
  assert.equal((await find('новый')).length, 0);

  // paging: 45 messages with the same word come in two pages
  for (let i = 0; i < 45; i++) await call(i % 2 ? a.cookie : b.cookie, 'POST', `/api/chats/${dm.id}/messages`, { text: `пакет номер ${i}`, client_id: `page-${i}-aaaaaaaa` });
  const p1 = (await call(a.cookie, 'GET', '/api/search/messages?q=пакет')).data;
  assert.equal(p1.messages.length, 40);
  assert.equal(p1.more, true);
  const p2 = (await call(a.cookie, 'GET', `/api/search/messages?q=пакет&before=${p1.messages.at(-1).id}`)).data;
  assert.equal(p2.messages.length, 5);
  assert.equal(p2.more, false);
  const g = (await call(a.cookie, 'GET', '/api/search/global?q=пакет')).data;
  assert.equal(g.results.length, 45);
});

test('folders: rules, order', async () => {
  const a = await login('+998900000034', 'Ann');
  const bad = await call(a.cookie, 'POST', '/api/folders', { name: 'X', rules: 'not json' });
  assert.equal(bad.status, 400);
  const f1 = (await call(a.cookie, 'POST', '/api/folders', { name: 'Личные', emoji: '👤', rules: { include: ['direct', 'evil'], exclude: ['muted', 'nope'] } })).data.folders[0];
  assert.deepEqual(f1.rules, { include: ['direct'], exclude: ['muted'] }, 'unknown rule names are dropped');
  const two = (await call(a.cookie, 'POST', '/api/folders', { name: 'Телеграм', rules: { include: ['telegram'], exclude: [] } })).data.folders;
  assert.equal(two.length, 2);
  const f2 = two[1];
  const swapped = await call(a.cookie, 'PUT', '/api/folders/order', { ids: [f2.id, f1.id] });
  assert.deepEqual(swapped.data.folders.map((f) => f.id), [f2.id, f1.id]);
  const cleared = (await call(a.cookie, 'PATCH', `/api/folders/${f1.id}`, { rules: null })).data.folders.find((f) => f.id === f1.id);
  assert.equal(cleared.rules, null);
});

test('scheduled messages: silent, when online, edit', async () => {
  const a = await login('+998900000035', 'Ann');
  const b = await login('+998900000036', 'Bek');
  const dm = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  const group = (await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'G', member_ids: [b.user.id] })).data.chat;
  const s = (await call(a.cookie, 'POST', `/api/chats/${dm.id}/schedule`, { text: 'тихо', send_at: Date.now() + 3_600_000, silent: true, when_online: true })).data.scheduled[0];
  assert.equal(s.silent, true);
  assert.equal(s.when_online, true);
  const g = (await call(a.cookie, 'POST', `/api/chats/${group.id}/schedule`, { text: 'в группу', send_at: Date.now() + 3_600_000, when_online: true })).data.scheduled.find((x) => x.text === 'в группу');
  assert.equal(g.when_online, false, '"when online" only means something in a personal chat');
  const at = Date.now() + 7_200_000;
  const up = (await call(a.cookie, 'PATCH', `/api/scheduled/${s.id}`, { text: 'тихо и позже', send_at: at, silent: false })).data.scheduled.find((x) => x.id === s.id);
  assert.equal(up.text, 'тихо и позже');
  assert.equal(up.send_at, Math.round(at));
  assert.equal(up.silent, false);
  assert.equal((await call(b.cookie, 'PATCH', `/api/scheduled/${s.id}`, { text: 'чужое' })).status, 404, 'not somebody else\'s');
  assert.equal((await call(a.cookie, 'PATCH', `/api/scheduled/${s.id}`, { send_at: Date.now() })).status, 400);
});

test('threads of replies', async () => {
  const a = await login('+998900000037', 'Ann');
  const b = await login('+998900000038', 'Bek');
  const c = await login('+998900000039', 'Cem');
  const group = (await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'T', member_ids: [b.user.id] })).data.chat;
  const root = (await call(a.cookie, 'POST', `/api/chats/${group.id}/messages`, { text: 'вопрос' })).data.message;
  const r1 = (await call(b.cookie, 'POST', `/api/chats/${group.id}/messages`, { text: 'ответ 1', reply_to: root.id })).data.message;
  await call(a.cookie, 'POST', `/api/chats/${group.id}/messages`, { text: 'ответ на ответ', reply_to: r1.id });
  await call(a.cookie, 'POST', `/api/chats/${group.id}/messages`, { text: 'не из этой ветки' });
  const th = (await call(b.cookie, 'GET', `/api/messages/${root.id}/thread`)).data;
  assert.equal(th.root.text, 'вопрос');
  assert.deepEqual(th.replies.map((m) => m.text), ['ответ 1', 'ответ на ответ']);
  assert.equal(th.root.replies, 1, 'the root counts its direct replies');
  const list = (await call(a.cookie, 'GET', `/api/chats/${group.id}/messages`)).data.messages;
  assert.equal(list.find((m) => m.id === root.id).replies, 1);
  assert.equal(list.find((m) => m.id === r1.id).replies, 1);
  assert.equal(list.find((m) => m.text === 'не из этой ветки').replies, undefined);
  assert.equal((await call(c.cookie, 'GET', `/api/messages/${root.id}/thread`)).status, 404, 'only members');
});

test('backups: retention keeps a sensible set; verification; storage overview', async () => {
  const { keepSet } = await import('../server/src/ops.js');
  const DAY = 86400_000;
  const at = Date.UTC(2026, 9, 20, 12);
  // one snapshot every 6 hours for 120 days
  const all = [];
  for (let i = 0; i < 120 * 4; i++) all.push({ name: `s${i}`, created_at: at - i * 6 * 3600_000, kind: 'auto' });
  const keep = keepSet(all, at);
  assert.ok(keep.size < 60, `kept ${keep.size} of ${all.length}`);
  assert.ok(keep.size >= 28, `kept ${keep.size}`);
  assert.ok(keep.has('s0'), 'the newest is kept');
  assert.ok([...keep].some((n) => at - all[Number(n.slice(1))].created_at > 100 * DAY), 'a monthly one from about four months ago is there');
  const manual = { name: 'm', created_at: at - 60 * DAY, kind: 'manual' };
  assert.ok(keepSet([...all, manual], at).has('m'), 'a manual one stays for 90 days');

  const admin = await login('+998900000031', 'Admin');
  const made = await call(admin.cookie, 'POST', '/api/admin/backups', {});
  assert.equal(made.status, 201);
  const v = (await call(admin.cookie, 'POST', `/api/admin/backups/${made.data.backup.name}/verify`, {})).data.verify;
  assert.equal(v.integrity, 'ok');
  assert.ok(v.counts.users >= 1);
  assert.ok(v.counts.messages > 40);
  assert.ok(Array.isArray(v.problems));
  const list = (await call(admin.cookie, 'GET', '/api/admin/backups')).data;
  assert.equal(list.verify.name, made.data.backup.name);
  const ov = (await call(admin.cookie, 'GET', '/api/admin/overview')).data;
  assert.equal(ov.attention.offsite, false);
  assert.equal(ov.attention.backup_verify.at > 0, true);

  const st = (await call(admin.cookie, 'GET', '/api/admin/storage')).data;
  assert.ok(Array.isArray(st.users) && Array.isArray(st.chats));
  assert.ok(st.chats[0].messages > 0);
  const nobody = await login('+998900000032', 'Bek');
  assert.equal((await call(nobody.cookie, 'GET', '/api/admin/storage')).status, 403);
});

test('push: the test notification answers and is private', async () => {
  const a = await login('+998900000041', 'Ann');
  const b = await login('+998900000042', 'Bek');
  assert.equal((await call(a.cookie, 'POST', '/api/push/test')).data.devices, 0, 'no device is subscribed');
  const dm = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  for (let i = 0; i < 3; i++) await call(b.cookie, 'POST', `/api/chats/${dm.id}/messages`, { text: `m${i}` });
  // the number itself is computed inside the server process; here the endpoint must at least stay private
  assert.equal((await call('', 'POST', '/api/push/test')).status, 401);
});
