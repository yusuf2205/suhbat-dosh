// Login + password for everyone: open sign-up, sign-in, change password, retired Telegram / phone-code sign-in.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5700 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-pw-')), REGISTRATION_OPEN: '1',
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

test('providers: password only', async () => {
  const r = await call('', 'GET', '/api/auth/providers');
  assert.equal(r.data.telegram.enabled, false);
  assert.equal(r.data.phone_code, false);
  assert.equal(r.data.password, true);
});

test('register, sign in, wrong password, change password', async () => {
  const bad = await call('', 'POST', '/api/auth/register', { name: 'Али', username: 'ali_user', password: 'short' });
  assert.equal(bad.status, 400);
  assert.equal(bad.data.error, 'weak_password');
  const badName = await call('', 'POST', '/api/auth/register', { name: 'Али', username: '1ab', password: 'longenough1' });
  assert.equal(badName.data.error, 'invalid_username');
  const reg = await call('', 'POST', '/api/auth/register', { name: 'Али', username: 'ali_user', password: 'longenough1' });
  assert.equal(reg.status, 201);
  assert.ok(reg.cookie.startsWith('sid='));
  assert.equal(reg.data.user.has_password, true);
  assert.equal(reg.data.user.phone, null);
  const dup = await call('', 'POST', '/api/auth/register', { name: 'X', username: 'ALI_USER', password: 'longenough1' });
  assert.equal(dup.status, 409);
  const wrong = await call('', 'POST', '/api/auth/login', { login: 'ali_user', password: 'nope-nope' });
  assert.equal(wrong.status, 401);
  const ok = await call('', 'POST', '/api/auth/login', { login: '@Ali_User', password: 'longenough1' });
  assert.equal(ok.status, 200);
  const me = await call(ok.cookie, 'GET', '/api/me');
  assert.equal(me.data.user.username, 'ali_user');
  const noCur = await call(ok.cookie, 'POST', '/api/me/password', { new_password: 'another-pass-2' });
  assert.equal(noCur.status, 403);
  const ch = await call(ok.cookie, 'POST', '/api/me/password', { current_password: 'longenough1', new_password: 'another-pass-2' });
  assert.equal(ch.status, 200);
  assert.equal((await call('', 'POST', '/api/auth/login', { login: 'ali_user', password: 'longenough1' })).status, 401);
  assert.equal((await call('', 'POST', '/api/auth/login', { login: 'ali_user', password: 'another-pass-2' })).status, 200);
});

test('Telegram and phone-code sign-in are closed', async () => {
  assert.equal((await call('', 'POST', '/api/auth/telegram/start', {})).status, 404);
  assert.equal((await call('', 'POST', '/api/auth/request', { phone: '+998900000099' })).status, 403);
});
