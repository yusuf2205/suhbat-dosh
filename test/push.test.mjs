// Web Push plumbing: key, subscribe validation, one subscription per endpoint, unsubscribe.
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
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-push-')), OTP_REQUESTS_PER_IP: '300' };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 60; i++) { try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
  throw new Error('no start');
});
after(() => server?.kill());
const call = async (cookie, method, url, body) => {
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
};

test('push: key, subscribe, validate, unsubscribe', async () => {
  const a = await call('', 'POST', '/api/auth/request', { phone: '+998900000041' });
  const v = await call('', 'POST', '/api/auth/verify', { phone: '+998900000041', code: a.data.dev_code, name: 'P' });
  const cookie = v.headers.get('set-cookie').split(';')[0];
  assert.equal((await call('', 'GET', '/api/push/key')).status, 401);
  const k1 = (await call(cookie, 'GET', '/api/push/key')).data.key;
  const k2 = (await call(cookie, 'GET', '/api/push/key')).data.key;
  assert.match(k1, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(k1, k2, 'the key is stable');
  assert.equal((await call(cookie, 'POST', '/api/push/subscribe', { subscription: { endpoint: 'http://insecure', keys: { p256dh: 'a', auth: 'b' } } })).status, 400);
  const sub = { endpoint: 'https://push.example.test/abc', keys: { p256dh: 'BPublicKeyData', auth: 'authsecret' } };
  assert.equal((await call(cookie, 'POST', '/api/push/subscribe', { subscription: sub })).status, 200);
  assert.equal((await call(cookie, 'POST', '/api/push/subscribe', { subscription: sub })).status, 200, 'idempotent');
  assert.equal((await call(cookie, 'POST', '/api/push/unsubscribe', { endpoint: sub.endpoint })).status, 200);
});
