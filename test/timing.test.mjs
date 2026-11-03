// Measures of speed: devices send durations, the server keeps its own, and only the console with the right to the server sees them.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 21280; // its own range of ten ports: test files run side by side
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-tm-')), BACKUP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-tmb-')), SUPERADMIN_PHONES: '+998900000001' };
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
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.cookie, id: v.data.user.id };
}

test('durations from the devices and from the server reach the console, nothing else', async () => {
  const owner = await login('+998900000001', 'Главный');
  const u = await login('+998900000002', 'Люда');
  assert.equal((await call('', 'POST', '/api/metrics', { send: [100] })).status, 401);
  assert.equal((await call(u.cookie, 'POST', '/api/metrics', { send: [120, 80, 100, 'x', -5, 3_600_000], ping: [40], who_is_who: [1] })).status, 200);
  const chat = (await call(u.cookie, 'POST', '/api/chats/direct', { user_id: owner.id })).data.chat.id;
  for (let i = 0; i < 3; i++) await call(u.cookie, 'POST', `/api/chats/${chat}/messages`, { text: `привет ${i}`, client_id: crypto.randomUUID() });

  assert.equal((await call(u.cookie, 'GET', '/api/admin/speed')).status, 403);
  const sp = (await call(owner.cookie, 'GET', '/api/admin/speed')).data;
  const send = sp.client.find((r) => r.kind === 'send');
  assert.deepEqual([send.n, send.p50], [3, 100], 'nonsense and an hour offline are left out');
  assert.equal(sp.client.find((r) => r.kind === 'ping').p50, 40);
  assert.ok(!sp.client.some((r) => r.kind === 'who_is_who'));
  const posted = sp.server.find((r) => r.route === 'POST /api/chats/:id/messages');
  assert.equal(posted.n, 3, 'the route as written in the code, not one line per chat');
  assert.ok(posted.p50 >= 0 && posted.p50 < 1000);
  assert.ok(sp.server.every((r) => !/\d{2,}/.test(r.route)));
});
