// Resumable chunked uploads: resume after a dropped connection, integrity, idempotent complete.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-up-')), OTP_REQUESTS_PER_IP: '300' };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no start');
});
after(() => server?.kill());

async function call(cookie, method, url, body, headers = {}) {
  const raw = Buffer.isBuffer(body);
  const r = await fetch(BASE + url, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body && !raw ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function user(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.cookie, user: v.data.user };
}

test('chunked upload resumes from what the server has', async () => {
  const A = await user('+998900000021', 'A');
  const B = await user('+998900000022', 'B');
  const chat = (await call(A.cookie, 'POST', '/api/chats/direct', { user_id: B.user.id })).data.chat;
  const data = crypto.randomBytes(3 * 1024 * 1024 + 123);
  const init = await call(A.cookie, 'POST', `/api/chats/${chat.id}/uploads`, { name: 'big.bin', size: data.length, client_id: 'client-12345678', caption: 'hi' });
  assert.equal(init.status, 201);
  const id = init.data.upload_id;
  assert.equal(init.data.received, 0);
  // same client id again: same session (idempotent init)
  assert.equal((await call(A.cookie, 'POST', `/api/chats/${chat.id}/uploads`, { name: 'big.bin', size: data.length, client_id: 'client-12345678' })).data.upload_id, id);
  const put = (off, buf, h = {}) => call(A.cookie, 'PUT', `/api/uploads/${id}?offset=${off}`, buf, { 'content-type': 'application/octet-stream', ...h });
  const c1 = data.subarray(0, 1024 * 1024);
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
  assert.equal((await put(0, c1, { 'x-chunk-sha256': 'deadbeef' })).status, 422); // corrupted part is refused
  assert.equal((await put(0, c1, { 'x-chunk-sha256': sha(c1) })).data.received, c1.length);
  // a repeated / out-of-order part is answered with the real position
  const wrong = await put(0, c1);
  assert.equal(wrong.status, 409);
  assert.equal(wrong.data.received, c1.length);
  // "connection dropped": ask where we are and continue from there
  assert.equal((await call(A.cookie, 'GET', `/api/uploads/${id}`)).data.received, c1.length);
  assert.equal((await call(A.cookie, 'POST', `/api/uploads/${id}/complete`)).status, 409); // not complete yet
  const rest = data.subarray(c1.length);
  let off = c1.length;
  for (let i = 0; i < rest.length; i += 1024 * 1024) {
    const part = rest.subarray(i, i + 1024 * 1024);
    const r = await put(off, part);
    assert.equal(r.status, 200);
    off = r.data.received;
  }
  // somebody else cannot touch it
  assert.equal((await call(B.cookie, 'GET', `/api/uploads/${id}`)).status, 404);
  const done = await call(A.cookie, 'POST', `/api/uploads/${id}/complete`);
  assert.equal(done.status, 201);
  assert.equal(done.data.message.file.size, data.length);
  assert.equal(done.data.message.text, 'hi');
  // the stored file equals what was sent
  const got = Buffer.from(await (await fetch(BASE + done.data.message.file.url, { headers: { cookie: A.cookie } })).arrayBuffer());
  assert.equal(sha(got), sha(data));
  // init after completion: reported as done, no duplicate message
  const again = await call(A.cookie, 'POST', `/api/chats/${chat.id}/uploads`, { name: 'big.bin', size: data.length, client_id: 'client-12345678' });
  assert.equal(again.data.done, true);
});
