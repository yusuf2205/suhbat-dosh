// The background service of the Android app may hold several connections of one session: a message is written to the newest of them only,
// so the notification does not repeat the same line. Browser tabs all keep getting everything.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6970 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', OTP_REQUESTS_PER_IP: '500', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-wn-')) };
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
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
let seq = 0;
async function signup(name) {
  const phone = `+99890${String(2000000 + (seq += 1))}`;
  const a = await call('', 'POST', '/api/auth/request', { phone });
  return call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
}
const open = (cookie, ua) => new Promise((resolve, reject) => {
  const got = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, ...(ua ? { 'user-agent': ua } : {}) } });
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  ws.on('open', () => resolve({ ws, got }));
  ws.on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('several background connections of the Android app get a message once; browser tabs all get it', async () => {
  const a = await signup('Айдар');
  const b = await signup('Мадина');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const nat1 = await open(b.cookie, 'okhttp/4.12.0');
  const nat2 = await open(b.cookie, 'okhttp/4.12.0');
  const nat3 = await open(b.cookie, 'okhttp/4.12.0');
  const tab1 = await open(b.cookie, 'Mozilla/5.0 Chrome');
  const tab2 = await open(b.cookie, 'Mozilla/5.0 Chrome');
  await sleep(200);
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'один раз', client_id: crypto.randomUUID() })).status, 201);
  await sleep(500);
  const count = (c) => c.got.filter((e) => e.type === 'message.new').length;
  assert.deepEqual([count(nat1), count(nat2), count(nat3)], [0, 0, 1], 'only the newest background connection is written to');
  assert.deepEqual([count(tab1), count(tab2)], [1, 1], 'every browser tab gets it');
  for (const c of [nat1, nat2, nat3, tab1, tab2]) c.ws.close();
});
