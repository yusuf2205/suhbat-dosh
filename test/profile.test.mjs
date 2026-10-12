// Admin login + password, birthday privacy, profile photo album.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5500 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-prof-')), OTP_REQUESTS_PER_IP: '300', SUPERADMIN_PHONES: '+998900000051',
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

async function call(cookie, method, url, body, raw) {
  const r = await fetch(BASE + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => ({})) : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { status: v.status, error: v.data.error, cookie: v.headers.get('set-cookie')?.split(';')[0], user: v.data.user };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

test('admin signs in with login + password; the phone code is refused afterwards', async () => {
  const adm = await login('+998900000051', 'Boss');
  assert.equal(adm.user.is_admin, true);
  assert.equal((await call(adm.cookie, 'PUT', '/api/admin/credentials', { login: 'boss', password: 'short' })).status, 400);
  assert.equal((await call(adm.cookie, 'PUT', '/api/admin/credentials', { login: 'boss', password: 'a-long-passphrase-1' })).status, 200);
  const again = await login('+998900000051', 'Boss');
  assert.equal(again.status, 403);
  assert.equal(again.error, 'admin_password_required');
  assert.equal((await call('', 'POST', '/api/auth/admin-login', { login: 'boss', password: 'nope-nope-nope' })).status, 401);
  assert.equal((await call('', 'POST', '/api/auth/admin-login', { login: 'nobody', password: 'a-long-passphrase-1' })).status, 401);
  const ok = await call('', 'POST', '/api/auth/admin-login', { login: 'BOSS', password: 'a-long-passphrase-1' });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await call(cookie, 'GET', '/api/admin/overview')).status, 200);
  assert.equal((await call(cookie, 'PUT', '/api/admin/credentials', { login: 'boss', password: 'another-long-pass-2' })).status, 403);
  assert.equal((await call(cookie, 'PUT', '/api/admin/credentials', { login: 'boss', password: 'another-long-pass-2', current_password: 'a-long-passphrase-1' })).status, 200);
  const bob = await login('+998900000052', 'Bob');
  assert.equal((await call('', 'POST', '/api/auth/admin-login', { login: 'bob', password: 'whatever-whatever' })).status, 401);
  assert.equal(bob.status, 200);
});

test('birthday follows privacy; photo album', async () => {
  const a = await login('+998900000061', 'Ann');
  const b = await login('+998900000062', 'Bek');
  assert.equal((await call(a.cookie, 'PATCH', '/api/me', { birthday: '2031-01-01' })).status, 400, 'future');
  assert.equal((await call(a.cookie, 'PATCH', '/api/me', { birthday: '1999-02-31' })).status, 400, 'impossible');
  assert.equal((await call(a.cookie, 'PATCH', '/api/me', { birthday: '1999-05-17' })).data.user.birthday, '1999-05-17');
  assert.equal((await call(b.cookie, 'GET', `/api/users/${a.user.id}`)).data.user.birthday, null, 'strangers do not see it');
  await call(b.cookie, 'POST', '/api/chats/direct', { user_id: a.user.id });
  assert.equal((await call(b.cookie, 'GET', `/api/users/${a.user.id}`)).data.user.birthday, '1999-05-17');
  await call(a.cookie, 'PATCH', '/api/me', { privacy: { birthday: 'nobody' } });
  assert.equal((await call(b.cookie, 'GET', `/api/users/${a.user.id}`)).data.user.birthday, null);
  assert.equal((await call(a.cookie, 'PATCH', '/api/me', { birthday: '--03-08' })).data.user.birthday, '--03-08');

  const up = async () => (await call(a.cookie, 'POST', '/api/me/avatar', undefined, PNG)).data.user;
  assert.ok((await up()).avatar);
  await up();
  const photos = (await call(b.cookie, 'GET', `/api/users/${a.user.id}/photos`)).data.photos;
  assert.equal(photos.length, 2);
  assert.equal((await call(b.cookie, 'GET', photos[0].url)).status, 200);
  const oldId = photos[1].id;
  await call(a.cookie, 'POST', `/api/me/photos/${oldId}/main`);
  await call(a.cookie, 'DELETE', `/api/me/photos/${oldId}`);
  assert.equal((await call(b.cookie, 'GET', `/api/users/${a.user.id}/photos`)).data.photos.length, 1);
  assert.equal((await call(b.cookie, 'DELETE', `/api/me/photos/${photos[0].id}`)).status, 404);
  await call(a.cookie, 'PATCH', '/api/me', { privacy: { photo: 'nobody' } });
  assert.equal((await call(b.cookie, 'GET', `/api/users/${a.user.id}/photos`)).data.photos.length, 0);
  assert.equal((await call(b.cookie, 'GET', photos[0].url)).status, 404);
});
