// Sign-in by QR code: the screen asks for a code, a signed-in phone approves it, the screen gets its own session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6660 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-qr-')), REGISTRATION_OPEN: '1',
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

test('a phone approves a code and the other screen is signed in as the same account, once', async () => {
  const phone = await call('', 'POST', '/api/auth/register', { name: 'Qr', username: 'qr_user', password: 'longenough1' });
  const cookie = phone.cookie;
  const st = (await call('', 'POST', '/api/auth/qr/start')).data;
  assert.ok(st.token && st.secret);
  assert.equal((await call('', 'GET', `/api/auth/qr/poll?token=${st.token}&secret=${st.secret}`)).data.status, 'pending');
  // somebody who is not signed in cannot approve; a wrong secret cannot poll
  assert.equal((await call('', 'POST', '/api/auth/qr/approve', { token: st.token })).status, 401);
  assert.equal((await call(cookie, 'GET', `/api/auth/qr/info?token=${st.token}`)).status, 200);
  assert.equal((await call(cookie, 'POST', '/api/auth/qr/approve', { token: st.token })).status, 200);
  assert.equal((await call('', 'GET', `/api/auth/qr/poll?token=${st.token}&secret=wrong`)).data.status, 'expired');
  const ok = await call('', 'GET', `/api/auth/qr/poll?token=${st.token}&secret=${st.secret}`);
  assert.equal(ok.data.status, 'approved');
  assert.equal(ok.data.user.username, 'qr_user');
  assert.ok(ok.cookie.startsWith('sid='));
  assert.equal((await call(ok.cookie, 'GET', '/api/me')).status, 200);
  assert.equal((await call('', 'GET', `/api/auth/qr/poll?token=${st.token}&secret=${st.secret}`)).data.status, 'expired');
});

test('an unknown code cannot be approved', async () => {
  const phone = await call('', 'POST', '/api/auth/register', { name: 'Qr2', username: 'qr_user2', password: 'longenough1' });
  assert.equal((await call(phone.cookie, 'POST', '/api/auth/qr/approve', { token: 'nope-nope-nope-nope' })).status, 404);
});

test('a computer without a camera: the phone types the short code instead of scanning', async () => {
  const phone = await call('', 'POST', '/api/auth/register', { name: 'Qr3', username: 'qr_user3', password: 'longenough1' });
  const st = (await call('', 'POST', '/api/auth/qr/start')).data;
  assert.match(st.code, /^\d{8}$/);
  const typed = `${st.code.slice(0, 4)} ${st.code.slice(4)}`;   // as the screen shows it, with a space
  const info = await call(phone.cookie, 'GET', `/api/auth/qr/info?code=${encodeURIComponent(typed)}`);
  assert.equal(info.status, 200);
  assert.equal(info.data.token, st.token);
  assert.equal((await call('', 'POST', '/api/auth/qr/approve', { code: st.code })).status, 401);   // only a signed-in phone
  assert.equal((await call(phone.cookie, 'POST', '/api/auth/qr/approve', { code: '00000000' })).status, 404);
  assert.equal((await call(phone.cookie, 'POST', '/api/auth/qr/approve', { code: typed })).status, 200);
  const ok = await call('', 'GET', `/api/auth/qr/poll?token=${st.token}&secret=${st.secret}`);
  assert.equal(ok.data.status, 'approved');
  assert.equal(ok.data.user.username, 'qr_user3');
});
