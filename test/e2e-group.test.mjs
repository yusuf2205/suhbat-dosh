// End-to-end encrypted groups: the server only stores device keys, wrapped group keys and ciphertext envelopes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6360 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-eg-')), REGISTRATION_OPEN: '1',
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
const pub = (c) => c.repeat(88);
const wrap = (tag) => JSON.stringify({ e: pub('E'), iv: 'aaaaaaaaaaaaaaaa', ct: `${tag}`.padEnd(60, 'x') });

test('an encrypted group: devices, first key, envelopes, a new member, removal makes a new epoch', async () => {
  const a = await signup('alice_eg');
  const b = await signup('boris_eg');
  const c = await signup('clara_eg');
  const dev = (u, id, p) => call(u.cookie, 'POST', '/api/e2e/devices', { id, pub: pub(p), name: 'test' });
  assert.equal((await dev(a, 'deviceAlice0000001', 'A')).status, 200);
  assert.equal((await dev(b, 'deviceBoris0000001', 'B')).status, 200);
  assert.equal((await call(a.cookie, 'POST', '/api/e2e/devices', { id: 'deviceBoris0000001', pub: pub('B') })).status, 409, 'a device id belongs to one person');
  assert.equal((await call(a.cookie, 'POST', '/api/e2e/devices', { id: 'x', pub: 'bad' })).status, 400);

  const g = await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'Секретные', member_ids: [b.data.user.id], e2e: true });
  assert.equal(g.status, 201);
  const chat = g.data.chat;
  assert.equal(chat.secret.group, true);
  assert.equal(chat.secret.state, 'pending');
  // nothing can be sent before the first key exists
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: '{"v":2,"ep":1,"iv":"aa","ct":"bb"}', kind: 'secret' })).status, 409);
  let st = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/e2e?device=deviceAlice0000001`)).data;
  assert.deepEqual(st.devices.map((d) => d.id).sort(), ['deviceAlice0000001', 'deviceBoris0000001']);
  assert.equal(st.epoch, 0);
  // the owner makes epoch 1 for both devices; a stranger's device is refused
  const bad = await call(a.cookie, 'POST', `/api/chats/${chat.id}/e2e/keys`, { epoch: 1, wraps: [{ device: 'nobody0000000000000', wrapped: wrap('z') }] });
  assert.equal(bad.status, 400);
  const k1 = await call(a.cookie, 'POST', `/api/chats/${chat.id}/e2e/keys`, { epoch: 1, wraps: [{ device: 'deviceAlice0000001', wrapped: wrap('a1') }, { device: 'deviceBoris0000001', wrapped: wrap('b1') }] });
  assert.equal(k1.data.epoch, 1);
  const mine = (await call(b.cookie, 'GET', `/api/chats/${chat.id}/e2e?device=deviceBoris0000001`)).data;
  assert.equal(mine.keys.length, 1);
  assert.ok(mine.keys[0].wrapped.includes('b1'));
  assert.deepEqual(mine.missing, []);
  // somebody else's device gets no keys for another person's device id
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${chat.id}/e2e?device=deviceAlice0000001`)).data.keys.length, 0);

  // envelopes: version 2 with a real epoch only; plaintext is refused
  const env = (ep) => JSON.stringify({ v: 2, ep, iv: 'aaaaaaaaaaaaaaaa', ct: 'bbbbbbbbbbbbbbbb' });
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'plain text' })).status, 400);
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: env(2), kind: 'secret' })).status, 400, 'a future epoch');
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: JSON.stringify({ v: 1, iv: 'aa', ct: 'bb' }), kind: 'secret' })).status, 400, 'a one-to-one envelope');
  const sent = await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: env(1), kind: 'secret' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.kind, 'secret');
  // the server features that need to read text are closed here
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/tasks`, { title: 'x' })).status, 403);
  assert.equal((await call(a.cookie, 'GET', `/api/chats/${chat.id}/digest`)).status, 403);

  // a new member: their device is missing a wrap until a member device provides it
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/members`, { user_id: c.data.user.id })).status, 200);
  await dev(c, 'deviceClara0000001', 'C');
  st = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/e2e?device=deviceAlice0000001`)).data;
  assert.deepEqual(st.missing, ['deviceClara0000001']);
  const k1b = await call(b.cookie, 'POST', `/api/chats/${chat.id}/e2e/keys`, { epoch: 1, wraps: [{ device: 'deviceClara0000001', wrapped: wrap('c1') }] });
  assert.equal(k1b.status, 200, 'any member device may wrap the current key for a missing device');
  assert.equal((await call(c.cookie, 'GET', `/api/chats/${chat.id}/e2e?device=deviceClara0000001`)).data.keys.length, 1);

  // removing a member: a new epoch is needed, and only an admin may start it
  assert.equal((await call(a.cookie, 'DELETE', `/api/chats/${chat.id}/members/${c.data.user.id}`)).status, 200);
  st = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/e2e?device=deviceAlice0000001`)).data;
  assert.equal(st.rotate, true);
  assert.ok(!st.devices.some((d) => d.user_id === c.data.user.id), 'the removed person has no device in the list');
  assert.equal((await call(b.cookie, 'POST', `/api/chats/${chat.id}/e2e/keys`, { epoch: 2, wraps: [{ device: 'deviceBoris0000001', wrapped: wrap('b2') }] })).status, 403);
  const k2 = await call(a.cookie, 'POST', `/api/chats/${chat.id}/e2e/keys`, { epoch: 2, wraps: [{ device: 'deviceAlice0000001', wrapped: wrap('a2') }, { device: 'deviceBoris0000001', wrapped: wrap('b2') }] });
  assert.equal(k2.data.epoch, 2);
  assert.equal((await call(a.cookie, 'GET', `/api/chats/${chat.id}/e2e?device=deviceAlice0000001`)).data.rotate, false);
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: env(2), kind: 'secret' })).status, 201);
  // the removed person's device never gets the new key
  assert.equal((await call(c.cookie, 'GET', `/api/chats/${chat.id}/e2e?device=deviceClara0000001`)).status, 404);
});
