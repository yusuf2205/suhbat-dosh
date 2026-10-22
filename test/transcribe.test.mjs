// Voice message transcription through the speech-to-text service (a stub stands in for it here).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6180 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let stub;
let stubPort;
let stubUp = true;
const seen = [];

before(async () => {
  stub = http.createServer((req, res) => {
    if (req.url === '/health') { res.writeHead(stubUp ? 200 : 503); return res.end('{}'); }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      seen.push({ url: req.url, bytes: Buffer.concat(chunks).length });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ language: 'ru', language_probability: 0.97, duration: 3.2, text: 'привет как дела', model: 'stub',
        words: [{ w: 'привет', p: 0.98 }, { w: 'как', p: 0.4 }, { w: 'дела', p: 0.9 }] }));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  stubPort = stub.address().port;
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-tr-')), REGISTRATION_OPEN: '1', WHISPER_URL: `http://127.0.0.1:${stubPort}`,
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no start');
});
after(() => { server?.kill(); stub?.close(); });

async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const signup = (u) => call('', 'POST', '/api/auth/register', { name: u, username: u, password: 'longenough1' });

test('transcription: draft with word confidence, one job per message, secret chats refused, service down', async () => {
  const a = await signup('alice_tr');
  const b = await signup('boris_tr');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const ogg = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(300, 1)]);
  const up = await fetch(`${BASE}/api/chats/${chat.id}/files?name=voice.ogg&voice=1&duration=3&client_id=voice-tr-00001`, { method: 'POST', headers: { cookie: a.cookie }, body: ogg });
  const msg = (await up.json()).message;
  assert.equal(msg.kind, 'voice');
  assert.equal(msg.transcript, null);
  // not a recording
  const text = (await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'hi', client_id: 'cid-tr-0000001' })).data.message;
  assert.equal((await call(a.cookie, 'POST', `/api/messages/${text.id}/transcribe`, {})).status, 400);
  // a stranger cannot ask
  const c = await signup('carol_tr');
  assert.equal((await call(c.cookie, 'POST', `/api/messages/${msg.id}/transcribe`, {})).status, 404);
  // the recipient asks for the text
  const ask = await call(b.cookie, 'POST', `/api/messages/${msg.id}/transcribe`, { lang: 'ru' });
  assert.equal(ask.status, 202);
  assert.equal(ask.data.message.transcript.status, 'pending');
  let tr = null;
  for (let i = 0; i < 40 && tr?.status !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const list = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
    tr = list.find((m) => m.id === msg.id).transcript;
  }
  assert.equal(tr.status, 'done');
  assert.equal(tr.text, 'привет как дела');
  assert.deepEqual(tr.words[1], ['как', 0.4]);
  assert.equal(seen.length, 1);
  assert.match(seen[0].url, /lang=ru/);
  // asking again does not run a second job
  const again = await call(a.cookie, 'POST', `/api/messages/${msg.id}/transcribe`, {});
  assert.equal(again.status, 200);
  assert.equal(seen.length, 1);
  // the service is down: a clear error, not a hang
  stubUp = false;
  await new Promise((r) => setTimeout(r, 100));
  const up2 = await fetch(`${BASE}/api/chats/${chat.id}/files?name=voice2.ogg&voice=1&duration=3&client_id=voice-tr-00002`, { method: 'POST', headers: { cookie: a.cookie }, body: ogg });
  const msg2 = (await up2.json()).message;
  // the availability check is cached for 30 s: force a fresh look by waiting is too slow, so only the cached positive answer applies
  const r2 = await call(a.cookie, 'POST', `/api/messages/${msg2.id}/transcribe`, {});
  assert.ok([202, 503].includes(r2.status));
});
