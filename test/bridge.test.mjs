// The Telegram bridge: login by QR, choosing chats, read-only vs two-way, dedupe, disconnect. The bridge container runs in mock mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6860 + Math.floor(Math.random() * 40);
const BPORT = 6900 + Math.floor(Math.random() * 40);
const BASE = `http://127.0.0.1:${PORT}`;
const TOKEN = crypto.randomBytes(24).toString('base64url');
const pyEnv = { ...process.env, ...(process.env.TGBRIDGE_PYPATH ? { PYTHONPATH: process.env.TGBRIDGE_PYPATH } : {}) };
const havePy = spawnSync('python', ['-c', 'import aiohttp, cryptography'], { env: pyEnv }).status === 0;
let server; let bridgeProc; let bdir;

before(async () => {
  if (!havePy) return;
  bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-brd-'));
  bridgeProc = spawn('python', ['tgbridge/bridge.py'], {
    cwd: root, stdio: 'inherit',
    env: { ...pyEnv, TGBRIDGE_MOCK: '1', PORT: String(BPORT), DATA_DIR: bdir, BRIDGE_TOKEN: TOKEN, TGBRIDGE_KEY: crypto.randomBytes(32).toString('base64'), SERVER_URL: BASE, MOCK_LOGIN_DELAY: '0.4' },
  });
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', OTP_REQUESTS_PER_IP: '300',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-brs-')), SUPERADMIN_PHONES: '+998900002001', BRIDGE_TOKEN: TOKEN, TGBRIDGE_URL: `http://127.0.0.1:${BPORT}`,
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok && (await fetch(`http://127.0.0.1:${BPORT}/health`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('no start');
});
after(() => { server?.kill(); bridgeProc?.kill(); });

async function call(cookie, method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
async function phoneUser(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.cookie, user: v.data.user };
}
const mock = (body) => fetch(`http://127.0.0.1:${BPORT}/mock/message`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); } return null; };

test('only an administrator may link; the bridge door needs the secret', { skip: !havePy }, async () => {
  const admin = await phoneUser('+998900002001', 'Админ');
  const plain = await phoneUser('+998900002002', 'Обычный');
  assert.equal((await call(plain.cookie, 'POST', '/api/bridge/start')).status, 403);
  assert.equal((await call(plain.cookie, 'GET', '/api/bridge')).data.available, false);
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.available, true);
  assert.equal((await call('', 'POST', '/api/bridge/in', { tg_chat: '1', tg_msg: 1, text: 'x' })).status, 403, 'no secret');
  assert.equal((await call('', 'POST', '/api/bridge/in', { tg_chat: '1', tg_msg: 1, text: 'x' }, { Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${BPORT}/dialogs`)).status, 403, 'the bridge itself refuses calls without the secret');
});

test('login by QR, pick chats, receive, answer in a two-way chat only, disconnect', { skip: !havePy }, async () => {
  const admin = await phoneUser('+998900002001', 'Админ');
  const plain = await phoneUser('+998900002002', 'Обычный');
  const start = await call(admin.cookie, 'POST', '/api/bridge/start');
  assert.equal(start.status, 200);
  assert.match(start.data.url, /^tg:\/\/login\?token=/);
  const done = await until(async () => { const r = await call(admin.cookie, 'GET', '/api/bridge/poll'); return r.data.status === 'done' ? r.data : null; });
  assert.ok(done, 'the login finished');
  assert.equal(done.account.username, 'mock_user');
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.linked, true);
  const dlg = (await call(admin.cookie, 'GET', '/api/bridge/dialogs')).data.dialogs;
  assert.equal(dlg.length, 3);
  // nothing is mirrored until chosen
  assert.equal((await mock({ chat: -1001, msg: 1, text: 'ещё не выбран' })).forwarded, false);
  const put = await call(admin.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: -1001, title: 'Семья', two_way: true }, { id: 777, title: 'Дилшод', two_way: false }] });
  assert.equal(put.status, 200);
  assert.equal(put.data.chats.length, 2);
  const family = put.data.chats.find((c) => c.tg_chat === '-1001').chat_id;
  const dil = put.data.chats.find((c) => c.tg_chat === '777').chat_id;
  // an incoming message lands unread, with its author, once even when delivered twice
  assert.equal((await mock({ chat: -1001, msg: 11, author: 'Бабушка', text: 'Привет всем' })).forwarded, true);
  await mock({ chat: -1001, msg: 11, author: 'Бабушка', text: 'Привет всем' });
  const msgs = await until(async () => { const r = (await call(admin.cookie, 'GET', `/api/chats/${family}/messages`)).data.messages; return r?.length ? r : null; });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].import_author, 'Бабушка');
  const chat = (await call(admin.cookie, 'GET', `/api/chats/${family}`)).data.chat;
  assert.equal(chat.unread, 1);
  assert.equal(chat.imported, 'tgbridge');
  // answering: allowed in the two-way chat, refused in the read-only one
  assert.equal((await call(admin.cookie, 'POST', `/api/chats/${dil}/messages`, { text: 'нельзя' })).status, 403);
  assert.equal((await call(admin.cookie, 'GET', `/api/chats/${dil}`)).data.chat.can_post, false);
  const sent = await call(admin.cookie, 'POST', `/api/chats/${family}/messages`, { text: 'Я дома' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.import_author, 'Мок Аккаунт');
  // another person cannot see mirrored chats
  assert.equal((await call(plain.cookie, 'GET', `/api/chats/${family}`)).status, 404);
  // disconnect: the bridge forgets everything, the mirrored chats are removed with it
  assert.equal((await call(admin.cookie, 'POST', '/api/bridge/disconnect', { delete_messages: true })).status, 200);
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.linked, false);
  assert.equal((await call(admin.cookie, 'GET', `/api/chats/${family}`)).status, 404);
  assert.deepEqual(fs.readdirSync(bdir), [], 'no session or list is left on the bridge');
  assert.equal((await mock({ chat: -1001, msg: 12, text: 'после отключения' })).forwarded, false);
});
