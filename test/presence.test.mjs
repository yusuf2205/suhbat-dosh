// Presence (busy / away) and the auto-reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5850 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-pr-')), REGISTRATION_OPEN: '1',
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

test('presence validation and auto-reply', async () => {
  const a = await signup('alice_pr');
  const b = await signup('boris_pr');
  const bad = await call(b.cookie, 'PATCH', '/api/me', { presence: 'sleeping' });
  assert.equal(bad.status, 400);
  const set = await call(b.cookie, 'PATCH', '/api/me', { presence: 'busy', auto_reply: 'Перезвоню позже', auto_reply_on: true });
  assert.equal(set.status, 200);
  assert.equal(set.data.user.presence, 'busy');
  assert.equal(set.data.user.auto_reply_on, true);
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  assert.equal(chat.peer.presence, 'busy');
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'привет', client_id: 'cid-pr-0000001' });
  const list = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
  const auto = list.filter((m) => m.sender_id === b.data.user.id);
  assert.equal(auto.length, 1);
  assert.match(auto[0].text, /Перезвоню позже/);
  // a second message within 12 hours: no second auto-reply
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'ещё', client_id: 'cid-pr-0000002' });
  const list2 = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
  assert.equal(list2.filter((m) => m.sender_id === b.data.user.id).length, 1);
});
