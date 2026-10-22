// The Telegram bridge: the administrator allows people, QR login per account, personal chats mirrored quietly by default,
// groups only when chosen, read-only vs two-way, history, dedupe, disconnect. The bridge container runs in mock mode.
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
const VIDEO = process.env.TEST_BRIDGE_VIDEO === '1'; // run the same test with videos switched on
const pyEnv = { ...process.env, ...(process.env.TGBRIDGE_PYPATH ? { PYTHONPATH: process.env.TGBRIDGE_PYPATH } : {}) };
const havePy = spawnSync('python', ['-c', 'import aiohttp, cryptography'], { env: pyEnv }).status === 0;
let server; let bridgeProc; let bdir;

before(async () => {
  if (!havePy) return;
  bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-brd-'));
  bridgeProc = spawn('python', ['tgbridge/bridge.py'], {
    cwd: root, stdio: 'inherit',
    env: { ...pyEnv, TGBRIDGE_MOCK: '1', PORT: String(BPORT), DATA_DIR: bdir, BRIDGE_TOKEN: TOKEN, TGBRIDGE_KEY: crypto.randomBytes(32).toString('base64'), SERVER_URL: BASE, MOCK_LOGIN_DELAY: '0.4', ...(VIDEO ? { BRIDGE_VIDEO: '1' } : {}) },
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
const mock = (uid, body) => fetch(`http://127.0.0.1:${BPORT}/mock/message?u=${uid}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const mockMedia = (uid, body) => fetch(`http://127.0.0.1:${BPORT}/mock/media?u=${uid}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
const until = async (fn, ms = 6000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 120)); } return null; };
async function link(u) {
  assert.equal((await call(u.cookie, 'POST', '/api/bridge/start')).status, 200);
  const done = await until(async () => { const r = await call(u.cookie, 'GET', '/api/bridge/poll'); return r.data.status === 'done' ? r.data : null; });
  assert.ok(done, 'the login finished');
  return done;
}

let admin; let friend;
test('the bridge door needs the secret; only people the administrator allowed may link', { skip: !havePy }, async () => {
  admin = await phoneUser('+998900002001', 'Админ');
  friend = await phoneUser('+998900002002', 'Обычный');
  assert.equal((await call('', 'POST', '/api/bridge/in', { owner: 1, tg_chat: '1', tg_msg: 1, text: 'x' })).status, 403, 'no secret');
  assert.equal((await call('', 'POST', '/api/bridge/in', { owner: 1, tg_chat: '1', tg_msg: 1, text: 'x' }, { Authorization: 'Bearer wrong' })).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${BPORT}/dialogs?u=1`)).status, 403, 'the bridge itself refuses calls without the secret');
  assert.equal((await call(friend.cookie, 'POST', '/api/bridge/start')).status, 403);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.available, false);
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.available, true);
  // only an administrator can allow; a plain user cannot
  assert.equal((await call(friend.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}`, { allowed: true })).status, 403);
  assert.equal((await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}`, { allowed: true })).status, 200);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.available, true);
  const list = (await call(admin.cookie, 'GET', '/api/admin/bridge')).data;
  assert.equal(list.users.find((x) => x.id === friend.user.id).allowed, true);
});

test('personal chats are mirrored by default and quietly, history comes along, groups only when chosen', { skip: !havePy }, async () => {
  const done = await link(admin);
  assert.equal(done.account.username, `mock_${admin.user.id}`);
  const st = (await call(admin.cookie, 'GET', '/api/bridge')).data;
  assert.equal(st.linked, true);
  assert.equal(st.auto_private, true);
  // the history of the personal chats arrives by itself
  const chats = await until(async () => { const r = (await call(admin.cookie, 'GET', '/api/bridge')).data.chats; return r.length >= 2 ? r : null; });
  assert.ok(chats, 'the personal chats were created');
  assert.equal(chats.every((c) => c.kind === 'user' && !c.two_way), true);
  const dil = chats.find((c) => c.tg_chat === '777');
  const hist = await until(async () => { const r = (await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}/messages`)).data.messages; return r?.length >= 3 ? r : null; });
  assert.ok(hist, 'the old messages were copied');
  const info = (await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}`)).data.chat;
  assert.equal(info.muted, true, 'mirrored chats are muted: no notifications');
  assert.equal(info.unread, 0, 'history is not unread');
  assert.equal(info.can_post, false, 'read-only until answering is allowed');
  // a new message in a personal chat: arrives unread, once even if delivered twice, still muted
  assert.equal((await mock(admin.user.id, { chat: 777, kind: 'user', title: 'Дилшод (мок)', msg: 50, author: 'Дилшод', text: 'Привет, как дела?' })).forwarded, true);
  await mock(admin.user.id, { chat: 777, kind: 'user', msg: 50, author: 'Дилшод', text: 'Привет, как дела?' });
  const after1 = await until(async () => { const c = (await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}`)).data.chat; return c.unread === 1 ? c : null; });
  assert.ok(after1, 'one new unread message');
  assert.equal((await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}/messages`)).data.messages.length, 4);
  // pictures and voice messages are copied as files; videos are prepared but switched off
  assert.equal((await mockMedia(admin.user.id, { chat: 777, kind: 'image', msg: 60, caption: 'Фото с вечера', w: 640, h: 480 })).forwarded, true);
  assert.equal((await mockMedia(admin.user.id, { chat: 777, kind: 'voice', msg: 61, duration: 7 })).forwarded, true);
  assert.equal((await mockMedia(admin.user.id, { chat: 777, kind: 'video', msg: 62 })).forwarded, VIDEO, VIDEO ? 'videos are on' : 'videos are off for now');
  const media = await until(async () => { const r = (await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}/messages`)).data.messages; return r.find((m) => m.kind === 'voice') ? r : null; });
  assert.ok(media, 'the voice message arrived');
  const photo = media.find((m) => m.kind === 'image');
  assert.equal(photo.text, 'Фото с вечера');
  assert.equal(photo.file.mime, 'image/jpeg');
  assert.equal(photo.import_author, 'Кто-то');
  if (VIDEO) assert.ok((await until(async () => (await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}/messages`)).data.messages.find((m) => m.kind === 'video'))), 'the video arrived');
  const voice = media.find((m) => m.kind === 'voice');
  assert.equal(voice.duration, 7);
  assert.equal(voice.file.mime, 'audio/ogg');
  const served = await fetch(BASE + photo.file.url, { headers: { cookie: admin.cookie } });
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(BASE + photo.file.url)).status, 401, 'a copied file is private like any other');
  // a brand-new personal chat appears by itself
  await mock(admin.user.id, { chat: 999, kind: 'user', title: 'Новый человек', msg: 1, author: 'Новый человек', text: 'Здравствуйте' });
  assert.ok(await until(async () => (await call(admin.cookie, 'GET', '/api/bridge')).data.chats.find((c) => c.tg_chat === '999')));
  // a group is NOT mirrored until chosen
  assert.equal((await mock(admin.user.id, { chat: -1001, kind: 'group', msg: 1, text: 'ещё не выбрана' })).forwarded, false);
  const put = await call(admin.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: -1001, title: 'Семья', kind: 'group', two_way: true }] });
  assert.equal(put.status, 200);
  const family = put.data.chats.find((c) => c.tg_chat === '-1001');
  assert.equal(family.two_way, true);
  await mock(admin.user.id, { chat: -1001, kind: 'group', msg: 11, author: 'Бабушка', text: 'Приходите на обед' });
  assert.ok(await until(async () => (await call(admin.cookie, 'GET', `/api/chats/${family.chat_id}/messages`)).data.messages?.length === 1));
  // answering: refused in a read-only chat, allowed in a two-way chat
  assert.equal((await call(admin.cookie, 'POST', `/api/chats/${dil.chat_id}/messages`, { text: 'нельзя' })).status, 403);
  const sent = await call(admin.cookie, 'POST', `/api/chats/${family.chat_id}/messages`, { text: 'Я дома' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.import_author, 'Мок Аккаунт');
  // a personal chat can be switched to two-way
  const two = await call(admin.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: 777, title: 'Дилшод', kind: 'user', two_way: true }] });
  assert.equal(two.data.chats.find((c) => c.tg_chat === '777').two_way, true);
  assert.equal((await call(admin.cookie, 'POST', `/api/chats/${dil.chat_id}/messages`, { text: 'теперь можно' })).status, 201);
  // a removed personal chat is not created again
  await call(admin.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: 999, title: 'Новый человек', kind: 'user', remove: true }] });
  await mock(admin.user.id, { chat: 999, kind: 'user', msg: 2, author: 'Новый человек', text: 'ещё одно' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.chats.some((c) => c.tg_chat === '999'), false);
  // the copies are never deleted by themselves (there is no retention setting any more)
  assert.equal((await call(admin.cookie, 'PUT', '/api/bridge/settings', { keep_days: 1 })).status, 404);
});

test('an ordinary person: personal chats are copied for the administrator only, who alone can change them', { skip: !havePy }, async () => {
  await link(friend);
  // the copies are made (the administrator sees them) but the person is not shown them
  const adminView = await until(async () => {
    const r = (await call(admin.cookie, 'GET', '/api/admin/chats')).data.chats || [];
    const mine = r.filter((c) => c.owner?.id === friend.user.id);
    return mine.length >= 2 ? mine : null;
  });
  assert.ok(adminView, 'the administrator sees the copies of the other account in the panel');
  const fchat = adminView.find((c) => c.title.includes('Дилшод'));
  const st = (await call(friend.cookie, 'GET', '/api/bridge')).data;
  assert.equal(st.personal_hidden, true);
  assert.ok(st.personal_count >= 2, 'the person is told how many personal chats are copied');
  assert.deepEqual(st.chats, [], 'but does not get the list');
  assert.equal((await call(friend.cookie, 'GET', `/api/chats/${fchat.id}`)).status, 404, 'and cannot open them');
  assert.equal((await call(friend.cookie, 'GET', '/api/chats')).data.chats.some((c) => c.id === fchat.id), false);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge/dialogs')).data.dialogs.every((d) => d.type !== 'user'), true);
  // new messages keep arriving, and the administrator reads them
  await mock(friend.user.id, { chat: 777, kind: 'user', msg: 77, author: 'Дилшод', text: 'Только для администратора' });
  assert.ok(await until(async () => JSON.stringify((await call(admin.cookie, 'GET', `/api/admin/chats/${fchat.id}/messages`)).data).includes('Только для администратора')));
  // only the administrator changes the personal part
  assert.equal((await call(friend.cookie, 'PUT', '/api/bridge/chats', { auto_private: false, chats: [] })).status, 403);
  assert.equal((await call(friend.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: 777, kind: 'user', title: 'x', remove: true }] })).status, 403);
  assert.equal((await call(friend.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}/personal`, { auto_private: false })).status, 403);
  assert.equal((await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}/personal`, { auto_private: false })).status, 200);
  assert.equal((await call(admin.cookie, 'GET', '/api/admin/bridge')).data.users.find((x) => x.id === friend.user.id).auto_private, false);
  await mock(friend.user.id, { chat: 4242, kind: 'user', title: 'Новый', msg: 1, text: 'после выключения' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(((await call(admin.cookie, 'GET', '/api/admin/chats')).data.chats || []).some((c) => c.owner?.id === friend.user.id && c.title.includes('Новый')), false, 'no new personal chats once the administrator turned it off');
  // the person can still add groups of their own, and those stay visible to them
  const put = await call(friend.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: -1001, title: 'Семья', kind: 'group', two_way: false }] });
  assert.equal(put.status, 200);
  assert.equal(put.data.chats.length, 1);
  // revoking the permission ends that person's session at once; the copies stay
  assert.equal((await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}`, { allowed: false })).status, 200);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.linked, false);
  assert.ok(((await call(admin.cookie, 'GET', '/api/admin/chats')).data.chats || []).some((c) => c.id === fchat.id), 'the copies are kept');
  assert.equal(fs.readdirSync(bdir).some((f) => f.includes(`-${friend.user.id}.`)), false, 'the session file of that person is gone');
  assert.equal(fs.readdirSync(bdir).some((f) => f.includes(`-${admin.user.id}.`)), true, 'the other account is untouched');
});

test('disconnect: the bridge forgets the account, the mirrored chats can be removed with it', { skip: !havePy }, async () => {
  assert.equal((await call(admin.cookie, 'POST', '/api/bridge/disconnect', { delete_messages: true })).status, 200);
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.linked, false);
  assert.deepEqual(fs.readdirSync(bdir).filter((f) => f.includes(`-${admin.user.id}.`)), [], 'no session or list is left');
  assert.equal((await mock(admin.user.id, { chat: 777, kind: 'user', msg: 90, text: 'после отключения' })).forwarded, false);
});
