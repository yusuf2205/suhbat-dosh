// Safety numbers, a name and animal per group, and (switched off by default) stories for chosen people.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6760 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let dataDir;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: (dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-pe-'))), REGISTRATION_OPEN: '1',
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
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function reg(name) {
  const r = await call('', 'POST', '/api/auth/register', { name, username: name, password: 'longenough1' });
  return { cookie: r.cookie, user: r.data.user };
}
const PUB = (c) => `${c}`.repeat(87).slice(0, 87); // looks like a base64 P-256 point

test('safety: public keys of a person you share a chat with, and the confirmed number', async () => {
  const a = await reg('alice_pe'); const b = await reg('boris_pe'); const c = await reg('clara_pe');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  assert.ok(chat);
  assert.equal((await call(a.cookie, 'GET', `/api/users/${c.user.id}/safety`)).status, 404, 'strangers are not exposed');
  const s = await call(a.cookie, 'GET', `/api/users/${b.user.id}/safety`);
  assert.equal(s.status, 200);
  assert.deepEqual(s.data.devices, []);
  assert.equal(s.data.verified, null);
  const number = '1234567890'.repeat(6);
  assert.equal((await call(a.cookie, 'POST', `/api/users/${b.user.id}/verify`, { number: 'short' })).status, 400);
  assert.equal((await call(a.cookie, 'POST', `/api/users/${b.user.id}/verify`, { number })).status, 200);
  assert.equal((await call(a.cookie, 'GET', `/api/users/${b.user.id}/safety`)).data.verified.number, number);
  assert.equal((await call(b.cookie, 'GET', `/api/users/${a.user.id}/safety`)).data.verified, null, 'each side confirms for itself');
  await call(a.cookie, 'DELETE', `/api/users/${b.user.id}/verify`);
  assert.equal((await call(a.cookie, 'GET', `/api/users/${b.user.id}/safety`)).data.verified, null);
  void PUB;
});

test('alias: an animal and a name in one group only; admins also see the real name', async () => {
  const a = await reg('owner_al'); const b = await reg('member_al'); const c = await reg('other_al');
  const g = (await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'Тайная', member_ids: [b.user.id, c.user.id] })).data.chat;
  assert.equal((await call(b.cookie, 'PUT', `/api/chats/${g.id}/alias`, { animal: 'dragon', name: 'Дракон' })).status, 400);
  const r = await call(b.cookie, 'PUT', `/api/chats/${g.id}/alias`, { animal: 'goose', name: 'Неопознанный Гусь' });
  assert.equal(r.status, 200);
  assert.equal(r.data.chat.aliases[b.user.id].a, 'goose');
  const seenByOwner = (await call(a.cookie, 'GET', `/api/chats/${g.id}`)).data.chat;
  assert.equal(seenByOwner.aliases[b.user.id].real, 'member_al');
  const seenByOther = (await call(c.cookie, 'GET', `/api/chats/${g.id}`)).data.chat;
  assert.equal(seenByOther.aliases[b.user.id].n, 'Неопознанный Гусь');
  assert.equal(seenByOther.aliases[b.user.id].real, undefined, 'a plain member does not get the real name');
  const direct = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  assert.equal((await call(b.cookie, 'PUT', `/api/chats/${direct.id}/alias`, { animal: 'fox', name: 'Лиса' })).status, 400, 'groups only');
  const off = await call(b.cookie, 'PUT', `/api/chats/${g.id}/alias`, { animal: '' });
  assert.equal(off.data.chat.aliases, undefined);
});

let cast;
test('stories for chosen people: off by default, then restricts who sees a story', async () => {
  cast = { a: await reg('author_st'), b: await reg('friend_st'), c: await reg('mate_st') };
  const { a, b, c } = cast;
  await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id });
  await call(a.cookie, 'POST', '/api/chats/direct', { user_id: c.user.id });
  assert.equal((await call(a.cookie, 'GET', '/api/config')).data.stories_audience, false);
  assert.equal((await call(a.cookie, 'GET', '/api/stories/lists')).status, 404);
  // while it is off, an audience is ignored: everybody sees the story
  await call(a.cookie, 'POST', '/api/stories', { text: 'для всех', bg: '#fbc700', audience: [b.user.id] });
  assert.equal((await call(c.cookie, 'GET', '/api/stories')).data.feed.some((f) => f.user.id === a.user.id), true);
});

test('with the switch on, a story with an audience is seen only by those people', async () => {
  const dbFile = fs.readdirSync(dataDir).find((f) => f.endsWith('.db') || f.endsWith('.sqlite'));
  const db = new DatabaseSync(path.join(dataDir, dbFile));
  db.exec("INSERT INTO settings (key, value) VALUES ('stories_audience', '1') ON CONFLICT(key) DO UPDATE SET value = '1'");
  db.close();
  const { a, b, c } = cast;
  assert.equal((await call(a.cookie, 'GET', '/api/config')).data.stories_audience, true);
  const posted = await call(a.cookie, 'POST', '/api/stories', { text: 'только для друга', bg: '#fbc700', audience: [b.user.id] });
  assert.equal(posted.status, 201, JSON.stringify(posted.data));
  const st = posted.data.story;
  assert.deepEqual(st.audience, [b.user.id]);
  const feedOf = async (u) => (await call(u.cookie, 'GET', '/api/stories')).data.feed.find((f) => f.user.id === a.user.id);
  assert.equal((await feedOf(b)).stories.length, 2);
  assert.deepEqual((await feedOf(c)).stories.map((x) => x.text), ['для всех'], 'the other contact sees only the open story');
  assert.equal((await call(c.cookie, 'POST', `/api/stories/${st.id}/view`)).status, 404);
  assert.equal((await call(b.cookie, 'POST', `/api/stories/${st.id}/view`)).status, 200);
  const list = (await call(a.cookie, 'POST', '/api/stories/lists', { name: 'Близкие', members: [b.user.id, 999999] })).data.list;
  assert.deepEqual(list.members, [b.user.id]);
  assert.equal((await call(a.cookie, 'GET', '/api/stories/lists')).data.lists.length, 1);
});
