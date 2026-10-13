// End-to-end encrypted chats: the server stores public keys and ciphertext only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto as wc } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6000 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-sec-')), OTP_REQUESTS_PER_IP: '300' };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no start');
});
after(() => server?.kill());

async function call(cookie, method, url, body, raw) {
  const r = await fetch(BASE + url, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : raw ? { 'content-type': 'application/octet-stream' } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function user(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.cookie, user: v.data.user };
}
const b64 = (u8) => Buffer.from(u8).toString('base64');
const fromB64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
async function pair() {
  const kp = await wc.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  return { priv: kp.privateKey, pub: b64(new Uint8Array(await wc.subtle.exportKey('raw', kp.publicKey))) };
}
async function aes(chatId, priv, otherPub) {
  const other = await wc.subtle.importKey('raw', fromB64(otherPub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const bits = await wc.subtle.deriveBits({ name: 'ECDH', public: other }, priv, 256);
  const base = await wc.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return wc.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode(String(chatId)), info: new TextEncoder().encode('suhbat-secret-v1') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, text) {
  const iv = wc.getRandomValues(new Uint8Array(12));
  const ct = await wc.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
}
async function open(key, env) {
  const e = JSON.parse(env);
  return new TextDecoder().decode(await wc.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(e.iv) }, key, fromB64(e.ct)));
}

test('secret chat: key exchange, ciphertext only, no forward / edit', async () => {
  const A = await user('+998900000031', 'A');
  const B = await user('+998900000032', 'B');
  const ka = await pair();
  const start = await call(A.cookie, 'POST', '/api/secret/start', { user_id: B.user.id, pub: ka.pub });
  assert.equal(start.status, 201);
  const chatId = start.data.chat.id;
  assert.equal(start.data.chat.secret.state, 'pending');
  // not ready yet: nothing can be sent
  const early = await call(A.cookie, 'POST', `/api/chats/${chatId}/messages`, { kind: 'secret', text: JSON.stringify({ v: 1, iv: 'AAAA', ct: 'BBBB' }) });
  assert.equal(early.status, 409);
  // the initiator cannot accept their own chat
  assert.equal((await call(A.cookie, 'POST', `/api/secret/${chatId}/accept`, { pub: ka.pub })).status, 404);
  const kb = await pair();
  const acc = await call(B.cookie, 'POST', `/api/secret/${chatId}/accept`, { pub: kb.pub });
  assert.equal(acc.data.chat.secret.state, 'ready');
  // both sides derive the same key
  const keyA = await aes(chatId, ka.priv, acc.data.chat.secret.peer_pub);
  const keyB = await aes(chatId, kb.priv, acc.data.chat.secret.init_pub);
  // plaintext is refused
  assert.equal((await call(A.cookie, 'POST', `/api/chats/${chatId}/messages`, { text: 'hello' })).status, 400);
  assert.equal((await call(A.cookie, 'POST', `/api/chats/${chatId}/messages`, { kind: 'secret', text: 'not json' })).status, 400);
  const env = await seal(keyA, 'секретный текст');
  const sent = await call(A.cookie, 'POST', `/api/chats/${chatId}/messages`, { kind: 'secret', text: env, client_id: 'secret-client-1' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.kind, 'secret');
  assert.ok(!sent.data.message.text.includes('секретный'));
  // B reads and decrypts
  const list = await call(B.cookie, 'GET', `/api/chats/${chatId}/messages`);
  const got = list.data.messages.find((m) => m.kind === 'secret');
  assert.equal(await open(keyB, got.text), 'секретный текст');
  // no forward, no edit
  const other = (await call(A.cookie, 'POST', '/api/chats/direct', { user_id: B.user.id })).data.chat;
  assert.equal((await call(A.cookie, 'POST', `/api/chats/${other.id}/messages`, { forward_of: sent.data.message.id })).status, 403);
  assert.equal((await call(A.cookie, 'PATCH', `/api/messages/${sent.data.message.id}`, { text: env })).status, 403);
  // an encrypted file: kind secret, the real name never reaches the server
  const blob = Buffer.from(await wc.subtle.encrypt({ name: 'AES-GCM', iv: wc.getRandomValues(new Uint8Array(12)) }, keyA, new TextEncoder().encode('file body')));
  const caption = await seal(keyA, JSON.stringify({ f: { name: 'report.docx', mime: 'application/x', size: 9 } }));
  const up = await call(A.cookie, 'POST', `/api/chats/${chatId}/files?name=secret.bin&client_id=secret-file-0001&caption=${encodeURIComponent(caption)}`, undefined, blob);
  assert.equal(up.status, 201);
  assert.equal(up.data.message.kind, 'secret');
  assert.equal(up.data.message.file.name, 'secret.bin');
  assert.equal(up.data.message.file.mime, 'application/octet-stream');
  // a normal chat refuses the secret kind
  assert.equal((await call(A.cookie, 'POST', `/api/chats/${other.id}/messages`, { kind: 'secret', text: env })).status, 400);
});
