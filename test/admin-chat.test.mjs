// Reading a conversation as an administrator: marks with notes, a summary, going to a date or a number, more filters.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 21010; // its own range of ten ports: test files run side by side
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-ac-')), SUPERADMIN_PHONES: '+998900000001', OTP_REQUESTS_PER_IP: '500' };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 300; i++) {
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
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  return call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
}

test('marks, summary, going to a date or a number, filters; ordinary people get none of it', async () => {
  const admin = await login('+998900000001', 'Админ');
  const a = await login('+998901110001', 'Мадина');
  const b = await login('+998901110002', 'Азиз');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const say = async (who, text) => (await call(who.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text, client_id: crypto.randomUUID() })).data.message;
  const m1 = await say(a, 'привет');
  const m2 = await say(b, 'смотри https://example.com/x');
  const m3 = await say(a, 'ещё');
  await new Promise((r) => setTimeout(r, 30));
  const edited = await say(b, 'было');
  await call(b.cookie, 'PATCH', `/api/messages/${edited.id}`, { text: 'стало' });

  const url = `/api/admin/chats/${chat.id}`;
  for (const [method, u, body] of [['POST', `/api/admin/messages/${m1.id}/mark`, {}], ['DELETE', `/api/admin/messages/${m1.id}/mark`], ['GET', `${url}/stats`], ['GET', `${url}/find?id=${m1.id}`]]) {
    assert.equal((await call(a.cookie, method, u, body)).status, 403, `${method} ${u}`);
  }

  // a mark with a note
  assert.equal((await call(admin.cookie, 'POST', `/api/admin/messages/${m2.id}/mark`, { note: 'Проверить ссылку' })).status, 200);
  assert.equal((await call(admin.cookie, 'POST', '/api/admin/messages/99999999/mark', {})).status, 404);
  let list = (await call(admin.cookie, 'GET', `${url}/messages?limit=50`)).data.messages;
  assert.equal(list.find((m) => m.id === m2.id).mark.note, 'Проверить ссылку');
  assert.equal(list.find((m) => m.id === m1.id).mark, null);
  const marked = (await call(admin.cookie, 'GET', `${url}/messages?limit=50&kind=marked`)).data;
  assert.deepEqual(marked.messages.map((m) => m.id), [m2.id]);
  assert.equal(marked.total, 1);
  // the people in the chat do not see it
  const own = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
  assert.equal(own.find((m) => m.id === m2.id).mark, undefined);
  assert.equal((await call(admin.cookie, 'DELETE', `/api/admin/messages/${m2.id}/mark`)).status, 200);
  assert.equal((await call(admin.cookie, 'GET', `${url}/messages?kind=marked`)).data.messages.length, 0);

  // other filters
  assert.deepEqual((await call(admin.cookie, 'GET', `${url}/messages?kind=edited`)).data.messages.map((m) => m.id), [edited.id]);
  assert.equal((await call(admin.cookie, 'GET', `${url}/messages?kind=media`)).data.messages.length, 0);

  // the summary
  const s = (await call(admin.cookie, 'GET', `${url}/stats`)).data;
  assert.equal(s.total, 4);
  assert.equal(s.edited, 1);
  assert.equal(s.links, 1);
  assert.deepEqual(s.by_author.map((x) => [x.name, x.n]).sort(), [['Азиз', 2], ['Мадина', 2]]);
  assert.equal(s.by_kind.find((k) => k.kind === 'text').n, 4);
  assert.ok(s.first_at <= s.last_at);

  // going somewhere
  assert.equal((await call(admin.cookie, 'GET', `${url}/find?id=${m3.id}`)).data.id, m3.id);
  assert.equal((await call(admin.cookie, 'GET', `${url}/find?id=99999999`)).status, 404, 'a number from another chat or none');
  const after = (await call(admin.cookie, 'GET', `${url}/find?at=${m1.created_at}`)).data.id;
  assert.equal(after, m1.id);
  assert.equal((await call(admin.cookie, 'GET', `${url}/find?at=${Date.now() + 86400000}`)).data.id, edited.id, 'after the end: the last message');
  assert.equal((await call(admin.cookie, 'GET', `${url}/find`)).status, 400);
  void list;
});
