// Quick replies (private snippets) and the directory of public channels, groups and bots.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6560 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-qd-')), REGISTRATION_OPEN: '1',
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

test('quick replies: own snippets, unique shortcuts, edit and delete, private to the person', async () => {
  const a = await signup('alice_qr');
  const b = await signup('boris_qr');
  const add = await call(a.cookie, 'POST', '/api/me/quick', { shortcut: '/Адрес', text: 'ул. Навои 12, офис 4' });
  assert.equal(add.status, 201);
  assert.equal(add.data.replies[0].shortcut, 'адрес');
  assert.equal((await call(a.cookie, 'POST', '/api/me/quick', { shortcut: 'адрес', text: 'x' })).status, 409);
  assert.equal((await call(a.cookie, 'POST', '/api/me/quick', { shortcut: 'bad shortcut', text: 'x' })).status, 400);
  const id = add.data.replies[0].id;
  assert.equal((await call(a.cookie, 'PATCH', `/api/me/quick/${id}`, { text: 'новый текст' })).data.replies[0].text, 'новый текст');
  assert.equal((await call(b.cookie, 'GET', '/api/me/quick')).data.replies.length, 0);
  assert.equal((await call(b.cookie, 'PATCH', `/api/me/quick/${id}`, { text: 'hack' })).status, 404);
  assert.equal((await call(a.cookie, 'DELETE', `/api/me/quick/${id}`)).data.replies.length, 0);
});

test('directory: only what the owner made public, search, join, bots, no encrypted groups', async () => {
  const owner = await signup('owner_dir');
  const guest = await signup('guest_dir');
  const ch = (await call(owner.cookie, 'POST', '/api/chats', { type: 'channel', title: 'Новости Ташкента', description: 'Каждый день' })).data.chat;
  const grp = (await call(owner.cookie, 'POST', '/api/chats', { type: 'group', title: 'Секрет', e2e: true })).data.chat;
  assert.equal((await call(guest.cookie, 'GET', '/api/directory?kind=channel')).data.items.length, 0, 'private by default');
  assert.equal((await call(guest.cookie, 'POST', `/api/chats/${ch.id}/public`, { public: true })).status, 404);
  assert.equal((await call(owner.cookie, 'POST', `/api/chats/${grp.id}/public`, { public: true })).status, 400, 'encrypted groups stay out');
  const pub = await call(owner.cookie, 'POST', `/api/chats/${ch.id}/public`, { public: true });
  assert.equal(pub.data.chat.public, true);
  const list = (await call(guest.cookie, 'GET', '/api/directory?kind=channel&q=ташкент')).data.items;
  assert.equal(list.length, 1);
  assert.equal(list[0].joined, false);
  assert.equal((await call(guest.cookie, 'GET', '/api/directory?kind=channel&q=zzz')).data.items.length, 0);
  assert.equal((await call(guest.cookie, 'GET', '/api/directory?kind=group')).data.items.length, 0);
  const joined = await call(guest.cookie, 'POST', `/api/directory/${ch.id}/join`);
  assert.equal(joined.status, 200);
  assert.equal(joined.data.chat.my_role, 'member');
  assert.equal((await call(guest.cookie, 'GET', '/api/directory?kind=channel')).data.items[0].joined, true);
  assert.equal((await call(guest.cookie, 'POST', `/api/directory/${grp.id}/join`)).status, 404);
  assert.equal((await call(owner.cookie, 'POST', `/api/chats/${ch.id}/public`, { public: false })).data.chat.public, undefined);
  assert.equal((await call(guest.cookie, 'GET', '/api/directory?kind=channel')).data.items.length, 0);
  assert.equal((await call(guest.cookie, 'GET', '/api/directory?kind=bot')).status, 200);
});

test('search ignores the case of Cyrillic letters too (messages, global search, people)', async () => {
  const a = await signup('alice_ci');
  const b = await signup('boris_ci');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'Привет, Мир! Встреча в Ташкенте' });
  const inChat = await call(b.cookie, 'GET', `/api/search/messages?q=${encodeURIComponent('привет мир')}`);
  assert.equal(inChat.data.messages.length, 0, 'two words in another order are not a phrase');
  assert.equal((await call(b.cookie, 'GET', `/api/search/messages?q=${encodeURIComponent('ПРИВЕТ')}`)).data.messages.length, 1);
  assert.equal((await call(b.cookie, 'GET', `/api/search/global?q=${encodeURIComponent('ташкенте')}`)).data.results.length, 1);
  const p = await call(b.cookie, 'GET', `/api/users/search?q=${encodeURIComponent('ALICE')}`);
  assert.ok(p.data.users.some((u) => u.username === 'alice_ci'));
});
