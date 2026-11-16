// Albums: several pictures sent as one block. Each picture stays a message of its own; they share a key.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 21410; // its own range of ten ports: test files run side by side
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-album-')), OTP_REQUESTS_PER_IP: '500' };
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
  return { status: r.status, data: await r.json().catch(() => ({})) , cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  return call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
}
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

test('own pictures sent with one album key carry it; other kinds and bad keys do not', async () => {
  const a = await login('+998900041001', 'Алия');
  const b = await login('+998900041002', 'Бахтиёр');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const album = 'album-test-key-1';
  const sent = [];
  for (let i = 0; i < 3; i++) {
    // the resumable way (what the app uses)
    const init = await call(a.cookie, 'POST', `/api/chats/${chat.id}/uploads`, { name: `p${i}.jpg`, size: JPEG.length, client_id: `client-album-${i}-xx`, album, caption: i === 0 ? 'подпись' : '' });
    assert.equal(init.status, 201);
    const put = await fetch(`${BASE}/api/uploads/${init.data.upload_id}?offset=0`, { method: 'PUT', headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' }, body: JPEG });
    assert.equal(put.status, 200);
    const done = await call(a.cookie, 'POST', `/api/uploads/${init.data.upload_id}/complete`);
    assert.equal(done.status, 201);
    sent.push(done.data.message);
  }
  assert.ok(sent.every((m) => m.kind === 'image' && m.album === album), 'every picture of the album carries its key');
  // the raw way too
  const raw = await fetch(`${BASE}/api/chats/${chat.id}/files?name=raw.jpg&album=${album}`, { method: 'POST', headers: { cookie: a.cookie, 'content-type': 'image/jpeg' }, body: JPEG });
  assert.equal((await raw.json()).message.album, album);
  // a file that is not a picture is never part of an album; a key with odd characters is ignored
  const doc = Buffer.from('PK\x03\x04 just a file');
  const initDoc = await call(a.cookie, 'POST', `/api/chats/${chat.id}/uploads`, { name: 'f.zip', size: doc.length, client_id: 'client-album-doc-1', album });
  await fetch(`${BASE}/api/uploads/${initDoc.data.upload_id}?offset=0`, { method: 'PUT', headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' }, body: doc });
  const doneDoc = await call(a.cookie, 'POST', `/api/uploads/${initDoc.data.upload_id}/complete`);
  assert.equal(doneDoc.data.message.album, undefined, 'a document has no album');
  const odd = await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'привет', album: 'bad key!' });
  assert.equal(odd.data.message.album, undefined);
  // the other side reads the same keys
  const list = (await call(b.cookie, 'GET', `/api/chats/${chat.id}/messages?limit=20`)).data.messages;
  assert.equal(list.filter((m) => m.album === album).length, 4);
});
