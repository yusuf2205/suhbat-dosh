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
const VIDEO = process.env.TEST_BRIDGE_VIDEO !== '0'; // videos are copied unless switched off (TEST_BRIDGE_VIDEO=0)
const pyEnv = { ...process.env, ...(process.env.TGBRIDGE_PYPATH ? { PYTHONPATH: process.env.TGBRIDGE_PYPATH } : {}) };
const havePy = spawnSync('python', ['-c', 'import aiohttp, cryptography'], { env: pyEnv }).status === 0;
let server; let bridgeProc; let bdir;

before(async () => {
  if (!havePy) return;
  bdir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-brd-'));
  bridgeProc = spawn('python', ['tgbridge/bridge.py'], {
    cwd: root, stdio: 'inherit',
    env: { ...pyEnv, TGBRIDGE_MOCK: '1', PORT: String(BPORT), DATA_DIR: bdir, BRIDGE_TOKEN: TOKEN, TGBRIDGE_KEY: crypto.randomBytes(32).toString('base64'), SERVER_URL: BASE, MOCK_LOGIN_DELAY: '0.4', BRIDGE_VIDEO: VIDEO ? '1' : '0', UPGRADE_DELAY: '0.3', UPGRADE_IDLE: '0.4' },
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
  // everybody may link their own Telegram ...
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.available, true);
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.available, true);
  // ... and only an administrator can forbid it for a person
  assert.equal((await call(friend.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}`, { allowed: false })).status, 403);
  assert.equal((await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}`, { allowed: false })).status, 200);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.available, false);
  assert.equal((await call(friend.cookie, 'POST', '/api/bridge/start')).status, 403);
  assert.equal((await call(admin.cookie, 'GET', '/api/admin/bridge')).data.users.find((x) => x.id === friend.user.id).allowed, false);
  assert.equal((await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}`, { allowed: true })).status, 200);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.available, true);
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
  assert.equal(chats.every((c) => c.kind === 'user' && c.two_way), true, 'personal chats may be answered from here by default');
  const dil = chats.find((c) => c.tg_chat === '777');
  const hist = await until(async () => { const r = (await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}/messages`)).data.messages; return r?.length >= 3 ? r : null; });
  assert.ok(hist, 'the old messages were copied');
  const info = (await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}`)).data.chat;
  assert.equal(info.muted, true, 'mirrored chats are muted: no notifications');
  assert.equal(info.unread, 0, 'history is not unread');
  assert.equal(info.can_post, true, 'a personal chat can be answered from here');
  // a new message in a personal chat: arrives unread, once even if delivered twice, still muted
  assert.equal((await mock(admin.user.id, { chat: 777, kind: 'user', title: 'Дилшод (мок)', msg: 50, author: 'Дилшод', text: 'Привет, как дела?' })).forwarded, true);
  await mock(admin.user.id, { chat: 777, kind: 'user', msg: 50, author: 'Дилшод', text: 'Привет, как дела?' });
  const after1 = await until(async () => { const c = (await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}`)).data.chat; return c.unread === 1 ? c : null; });
  assert.ok(after1, 'one new unread message');
  assert.equal((await call(admin.cookie, 'GET', `/api/chats/${dil.chat_id}/messages`)).data.messages.length, 4);
  // pictures, voice messages, videos, music and files are copied as files
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
  // a chat that has just appeared can be answered at once, by default
  const fresh = (await call(admin.cookie, 'GET', '/api/bridge')).data.chats.find((c) => c.tg_chat === '999');
  assert.equal(fresh.two_way, true, 'personal chats may be answered from here by default');
  assert.equal((await call(admin.cookie, 'POST', `/api/chats/${fresh.chat_id}/messages`, { text: 'сразу могу ответить' })).status, 201);
  // a group is NOT mirrored until chosen
  assert.equal((await mock(admin.user.id, { chat: -1001, kind: 'group', msg: 1, text: 'ещё не выбрана' })).forwarded, false);
  const put = await call(admin.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: -1001, title: 'Семья', kind: 'group', two_way: true }] });
  assert.equal(put.status, 200);
  const family = put.data.chats.find((c) => c.tg_chat === '-1001');
  assert.equal(family.two_way, true);
  await mock(admin.user.id, { chat: -1001, kind: 'group', msg: 11, author: 'Бабушка', text: 'Приходите на обед' });
  assert.ok(await until(async () => (await call(admin.cookie, 'GET', `/api/chats/${family.chat_id}/messages`)).data.messages?.length === 1));
  // answering: allowed in a two-way chat, refused where it was not switched on (a group chosen read-only)
  assert.equal((await call(admin.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: -1002, title: 'Новости', kind: 'channel', two_way: false }] })).status, 200);
  const news = (await call(admin.cookie, 'GET', '/api/bridge')).data.chats.find((c) => c.tg_chat === '-1002');
  assert.equal((await call(admin.cookie, 'POST', `/api/chats/${news.chat_id}/messages`, { text: 'нельзя' })).status, 403);
  assert.equal((await call(admin.cookie, 'GET', `/api/chats/${news.chat_id}`)).data.chat.can_post, false);
  const sent = await call(admin.cookie, 'POST', `/api/chats/${family.chat_id}/messages`, { text: 'Я дома' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.import_author, 'Мок Аккаунт');
  assert.equal((await call(admin.cookie, 'POST', `/api/chats/${dil.chat_id}/messages`, { text: 'пишу в личный чат' })).status, 201);
  // a removed personal chat is not created again
  await call(admin.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: 999, title: 'Новый человек', kind: 'user', remove: true }] });
  await mock(admin.user.id, { chat: 999, kind: 'user', msg: 2, author: 'Новый человек', text: 'ещё одно' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.chats.some((c) => c.tg_chat === '999'), false);
  // the copies are never deleted by themselves (there is no retention setting any more)
  assert.equal((await call(admin.cookie, 'PUT', '/api/bridge/settings', { keep_days: 1 })).status, 404);
});

test('an ordinary person sees and answers the personal chats but cannot delete them; the administrator changes that part', { skip: !havePy }, async () => {
  await link(friend);
  const mine = await until(async () => { const r = (await call(friend.cookie, 'GET', '/api/bridge')).data.chats; return r.length >= 2 ? r : null; });
  assert.ok(mine, 'the person sees their personal chats');
  const fchat = mine.find((c) => c.tg_chat === '777');
  const info = (await call(friend.cookie, 'GET', `/api/chats/${fchat.chat_id}`)).data.chat;
  assert.equal(info.can_post, true, 'and may write from here');
  assert.equal(info.muted, true);
  // new messages keep arriving, and the administrator reads them too
  await mock(friend.user.id, { chat: 777, kind: 'user', msg: 77, author: 'Дилшод', text: 'Привет другу' });
  const msgs = await until(async () => { const r = (await call(friend.cookie, 'GET', `/api/chats/${fchat.chat_id}/messages`)).data.messages; return r.find((m) => m.text === 'Привет другу') ? r : null; });
  assert.ok(msgs);
  assert.ok(JSON.stringify((await call(admin.cookie, 'GET', `/api/admin/chats/${fchat.chat_id}/messages`)).data).includes('Привет другу'));
  // writing from here goes to Telegram and is stored as the person's own message
  const sent = await call(friend.cookie, 'POST', `/api/chats/${fchat.chat_id}/messages`, { text: 'Ответ из Suhbat-dosh' });
  assert.equal(sent.status, 201);
  // but nothing can be deleted, cleared, edited or left by the person
  const target = msgs.find((m) => m.text === 'Привет другу');
  assert.equal((await call(friend.cookie, 'DELETE', `/api/messages/${sent.data.message.id}`)).status, 403);
  assert.equal((await call(friend.cookie, 'DELETE', `/api/messages/${target.id}`)).status, 403);
  assert.equal((await call(friend.cookie, 'PATCH', `/api/messages/${sent.data.message.id}`, { text: 'правка' })).status, 403);
  assert.equal((await call(friend.cookie, 'POST', `/api/chats/${fchat.chat_id}/clear`)).status, 403);
  assert.equal((await call(friend.cookie, 'POST', `/api/chats/${fchat.chat_id}/hide`)).status, 403);
  assert.equal((await call(friend.cookie, 'DELETE', `/api/chats/${fchat.chat_id}/members/${friend.user.id}`)).status, 403);
  assert.equal((await call(friend.cookie, 'GET', `/api/chats/${fchat.chat_id}`)).status, 200, 'the chat is still there');
  // nor can the person stop the copying; only the administrator changes that
  assert.equal((await call(friend.cookie, 'PUT', '/api/bridge/chats', { auto_private: false, chats: [] })).status, 403);
  assert.equal((await call(friend.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: 777, kind: 'user', title: 'x', remove: true }] })).status, 403);
  assert.equal((await call(friend.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}/personal`, { auto_private: false })).status, 403);
  // groups and channels: the person picks their own, selectively, and the administrator sees them too
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.groups_allowed, true);
  assert.equal((await mock(friend.user.id, { chat: -1001, kind: 'group', msg: 5, author: 'Бабушка', text: 'ещё не выбрана' })).forwarded, false, 'nothing from a group by default');
  const addGroup = await call(friend.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: -1001, title: 'Семья', kind: 'group', two_way: false }] });
  assert.equal(addGroup.status, 200);
  const grp = addGroup.data.chats.find((c) => c.tg_chat === '-1001');
  assert.ok(grp, 'the group is in the person\'s list');
  await mock(friend.user.id, { chat: -1001, kind: 'group', msg: 6, author: 'Бабушка', text: 'Приходите на обед' });
  assert.ok(await until(async () => JSON.stringify((await call(admin.cookie, 'GET', `/api/admin/chats/${grp.chat_id}/messages`)).data).includes('Приходите на обед')), 'the administrator reads the group too');
  // the person may turn "answer from here" off for a chat
  const off = await call(friend.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: 777, kind: 'user', title: 'Дилшод', two_way: false }] });
  assert.equal(off.status, 200);
  assert.equal((await call(friend.cookie, 'POST', `/api/chats/${fchat.chat_id}/messages`, { text: 'уже нельзя' })).status, 403);
  await call(friend.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: 777, kind: 'user', title: 'Дилшод', two_way: true }] });
  // the administrator can switch the copying of one person off
  assert.equal((await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}/personal`, { auto_private: false })).status, 200);
  await mock(friend.user.id, { chat: 4242, kind: 'user', title: 'Новый', msg: 1, text: 'после выключения' });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(((await call(admin.cookie, 'GET', '/api/admin/chats')).data.chats || []).some((c) => c.owner?.id === friend.user.id && c.title.includes('Новый')), false);
  await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}/personal`, { auto_private: true });
  // forbidding ends that person's session at once; the copies stay
  assert.equal((await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}`, { allowed: false })).status, 200);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.linked, false);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.available, false);
  assert.ok(((await call(admin.cookie, 'GET', '/api/admin/chats')).data.chats || []).some((c) => c.id === fchat.chat_id), 'the copies are kept');
  assert.equal(fs.readdirSync(bdir).some((f) => f.includes(`-${friend.user.id}.`)), false, 'the session file of that person is gone');
  assert.equal(fs.readdirSync(bdir).some((f) => f.includes(`-${admin.user.id}.`)), true, 'the other account is untouched');
  // the administrator can also remove what was linked: the copies go too
  assert.equal((await call(admin.cookie, 'PUT', `/api/admin/bridge/${friend.user.id}`, { allowed: true })).status, 200);
  await link(friend);
  assert.ok(await until(async () => (await call(friend.cookie, 'GET', '/api/bridge')).data.chats.length >= 2));
  assert.equal((await call(friend.cookie, 'DELETE', `/api/admin/bridge/${friend.user.id}`)).status, 403);
  assert.equal((await call(admin.cookie, 'DELETE', `/api/admin/bridge/${friend.user.id}`)).status, 200);
  assert.equal((await call(friend.cookie, 'GET', '/api/bridge')).data.linked, false);
  assert.equal(((await call(admin.cookie, 'GET', '/api/admin/chats')).data.chats || []).some((c) => c.owner?.id === friend.user.id), false, 'all the mirrored chats of that person are gone');
  assert.equal(fs.readdirSync(bdir).some((f) => f.includes(`-${friend.user.id}.`)), false);
});

test('both sides stay in step: edits, deletions marked not removed, read marks in both directions', { skip: !havePy }, async () => {
  const chat = (await call(admin.cookie, 'GET', '/api/bridge')).data.chats.find((c) => c.tg_chat === '777');
  const ev = (body) => fetch(`http://127.0.0.1:${BPORT}/mock/event?u=${admin.user.id}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  const list = async () => (await call(admin.cookie, 'GET', `/api/chats/${chat.chat_id}/messages`)).data.messages;
  // an edit in Telegram changes the text here
  await mock(admin.user.id, { chat: 777, kind: 'user', msg: 200, author: 'Дилшод', text: 'Встретимся в шесть' });
  assert.ok(await until(async () => (await list()).find((m) => m.text === 'Встретимся в шесть')));
  await ev({ type: 'edit', chat: 777, msg: 200, text: 'Встретимся в семь' });
  const edited = await until(async () => (await list()).find((m) => m.text === 'Встретимся в семь'));
  assert.ok(edited, 'the new text arrived');
  assert.ok(edited.edited_at, 'and it is marked as edited');
  assert.deepEqual(edited.tg_prev.map((p) => p.text), ['Встретимся в шесть'], 'the earlier version is kept');
  await ev({ type: 'edit', chat: 777, msg: 200, text: 'Встретимся в восемь' });
  const twice = await until(async () => (await list()).find((m) => m.text === 'Встретимся в восемь'));
  assert.deepEqual(twice.tg_prev.map((p) => p.text), ['Встретимся в шесть', 'Встретимся в семь'], 'every version is kept, oldest first');
  // a deletion in Telegram is marked, the message stays (also when Telegram does not name the chat)
  await ev({ type: 'delete', ids: [200], with_chat: false });
  const gone = await until(async () => (await list()).find((m) => m.text === 'Встретимся в восемь' && m.tg_deleted));
  assert.ok(gone, 'marked as deleted in Telegram, not removed');
  // reading in Telegram clears the unread count here
  await mock(admin.user.id, { chat: 777, kind: 'user', msg: 201, author: 'Дилшод', text: 'Ты где?' });
  assert.ok(await until(async () => (await call(admin.cookie, 'GET', `/api/chats/${chat.chat_id}`)).data.chat.unread >= 1));
  await ev({ type: 'read', chat: 777, max_id: 201 });
  assert.ok(await until(async () => (await call(admin.cookie, 'GET', `/api/chats/${chat.chat_id}`)).data.chat.unread === 0), 'read in Telegram means read here');
  // reading here is passed on to Telegram
  await mock(admin.user.id, { chat: 777, kind: 'user', msg: 202, author: 'Дилшод', text: 'Алло?' });
  const last = await until(async () => (await list()).find((m) => m.text === 'Алло?'));
  await call(admin.cookie, 'POST', `/api/chats/${chat.chat_id}/read`, { message_id: last.id });
  const acks = await until(async () => { const r = await ev({ type: 'acks' }); return r.acks.some((a) => a[0] === '777' && a[1] === 202) ? r.acks : null; });
  assert.ok(acks, 'Telegram was told that the chat is read');
});

test('disconnect: the bridge forgets the account, the mirrored chats can be removed with it', { skip: !havePy }, async () => {
  assert.equal((await call(admin.cookie, 'POST', '/api/bridge/disconnect', { delete_messages: true })).status, 200);
  assert.equal((await call(admin.cookie, 'GET', '/api/bridge')).data.linked, false);
  assert.deepEqual(fs.readdirSync(bdir).filter((f) => f.includes(`-${admin.user.id}.`)), [], 'no session or list is left');
  assert.equal((await mock(admin.user.id, { chat: 777, kind: 'user', msg: 90, text: 'после отключения' })).forwarded, false);
});

test('the chat takes the other side\'s name, @username, phone and profile photo from Telegram', { skip: !havePy }, async () => {
  const u = await phoneUser('+998900002050', 'Профиль');
  await link(u);
  assert.equal((await mock(u.user.id, { chat: 4242, kind: 'user', title: 'Старое имя', msg: 1, author: 'Старое имя', text: 'Привет' })).forwarded, true);
  const find = async () => (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.imported === 'tgbridge' && c.title.includes('Старое') || c.title === '✈ Новое имя');
  assert.ok(await until(find), 'the chat was created');
  const tgPost = (url, body, headers = {}) => fetch(`${BASE}${url}`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, ...headers }, body });
  const profile = (extra) => tgPost('/api/bridge/in', JSON.stringify({ owner: u.user.id, tg_chat: '4242', kind: 'user', profile: true, title: 'Новое имя', username: '@dilshod', phone: '+998 90 123-45-67', photo_id: '', ...extra }), { 'content-type': 'application/json' }).then((r) => r.json());
  assert.equal((await profile({})).changed, true);
  let chat = (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.title === '✈ Новое имя');
  assert.ok(chat, 'the name followed');
  assert.deepEqual(chat.tg, { username: 'dilshod', phone: '998901234567' });
  assert.equal(chat.avatar, null);
  assert.equal((await profile({})).changed, false, 'nothing new, nothing changed');

  // the photo: a 1x1 PNG
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await tgPost(`/api/bridge/photo?owner=${u.user.id}&tg_chat=4242&photo_id=777`, png, { 'content-type': 'application/octet-stream' });
  assert.equal(up.status, 200);
  chat = (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.title === '✈ Новое имя');
  assert.match(chat.avatar, /^\/api\/files\//);
  const img = await fetch(BASE + chat.avatar, { headers: { cookie: u.cookie } });
  assert.equal(img.status, 200);
  assert.match(img.headers.get('content-type'), /image\/png/);
  const other = await phoneUser('+998900002051', 'Чужой');
  assert.equal((await fetch(BASE + chat.avatar, { headers: { cookie: other.cookie } })).status, 404, 'only the members see it');
  assert.equal((await tgPost(`/api/bridge/photo?owner=${u.user.id}&tg_chat=4242&photo_id=778`, Buffer.from('not an image'), { 'content-type': 'application/octet-stream' })).status, 415);

  // a rule push tells the bridge which photo the server holds, so it is not sent again after every restart
  assert.equal((await call(u.cookie, 'GET', '/api/bridge')).status, 200);

  // the photo was removed in Telegram
  assert.equal((await profile({ photo_id: '' })).changed, true);
  chat = (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.title === '✈ Новое имя');
  assert.equal(chat.avatar, null);
  assert.equal((await tgPost(`/api/bridge/in`, JSON.stringify({ owner: u.user.id, tg_chat: '999999', profile: true, title: 'x' }), { 'content-type': 'application/json' }).then((r) => r.json())).skipped, true, 'an unknown chat is ignored');
});

test('a photo and a file written here go to Telegram as files', { skip: !havePy }, async () => {
  const u = await phoneUser('+998900002060', 'Отправитель');
  await link(u);
  assert.equal((await mock(u.user.id, { chat: 5151, kind: 'user', title: 'Малика', msg: 1, author: 'Малика', text: 'Привет' })).forwarded, true);
  const chat = await until(async () => (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.title === '✈ Малика'));
  assert.ok(chat);
  const last = async () => (await (await fetch(`http://127.0.0.1:${BPORT}/mock/last?u=${u.user.id}`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json());
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = (name, body, extra = '') => fetch(`${BASE}/api/chats/${chat.id}/files?name=${encodeURIComponent(name)}${extra}`, { method: 'POST', headers: { cookie: u.cookie, 'content-type': 'application/octet-stream' }, body });
  const r1 = await up('photo.png', png, '&caption=' + encodeURIComponent('вот'));
  assert.equal(r1.status, 201, await r1.clone().text());
  const l1 = await until(async () => { const x = await last(); return x.kind === 'image' ? x : null; });
  assert.ok(l1, 'the photo was handed to Telegram');
  assert.equal(l1.size, png.length);
  assert.equal(l1.caption, 'вот');
  assert.equal((await up('заметки.txt', Buffer.from('просто текст для проверки'))).status, 201);
  const l2 = await until(async () => { const x = await last(); return x.kind === 'file' ? x : null; });
  assert.ok(l2, 'the file was handed to Telegram');
  assert.equal(l2.size, Buffer.byteLength('просто текст для проверки'));
  assert.match(l2.name, /\.txt$/);
});

test('files, music and videos are copied; a message that was only a mark gets its file later', { skip: !havePy }, async () => {
  const u = await phoneUser('+998900002070', 'Файлы');
  await link(u);
  assert.equal((await mock(u.user.id, { chat: 6161, kind: 'user', title: 'Рустам', msg: 1, author: 'Рустам', text: 'Привет' })).forwarded, true);
  const chat = await until(async () => (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.title === '✈ Рустам'));
  assert.ok(chat);
  const msgs = async () => (await call(u.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
  const find = (pred) => until(async () => (await msgs()).find(pred));

  // a document arrives with its name; a song stays a song; a blocked type is not stored (the mark stays)
  assert.equal((await mockMedia(u.user.id, { chat: 6161, kind: 'file', msg: 10, name: 'отчёт.zip', caption: 'за октябрь' })).forwarded, true);
  const doc = await find((m) => m.kind === 'file');
  assert.ok(doc, 'the document arrived');
  assert.equal(doc.file.name, 'отчёт.zip');
  assert.equal(doc.text, 'за октябрь');
  const got = await fetch(BASE + doc.file.url, { headers: { cookie: u.cookie } });
  assert.equal(got.status, 200);
  assert.equal(got.headers.get('content-type'), 'application/octet-stream', 'a document is never shown in the page');
  assert.equal((await mockMedia(u.user.id, { chat: 6161, kind: 'audio', msg: 11, name: 'песня.mp3' })).forwarded, true);
  assert.ok(await find((m) => m.kind === 'audio'), 'the song arrived as audio');
  assert.equal((await mockMedia(u.user.id, { chat: 6161, kind: 'file', msg: 12, name: 'setup.exe' })).forwarded, false, 'a program is not copied');

  // marks: the message was copied as text before files were supported; the bridge fetches the files by itself
  const mark = (msg, kind, extra = {}) => mockMedia(u.user.id, { chat: 6161, kind, msg, placeholder: true, ...extra });
  assert.equal((await mark(20, 'image', { caption: 'старое фото' })).forwarded, true);
  assert.equal((await mark(21, 'voice')).forwarded, true);
  assert.equal((await mark(22, 'file', { name: 'договор.zip' })).forwarded, true);
  assert.equal((await mark(23, 'file', { name: 'огромный.zip', size: 500 * 1024 * 1024 })).forwarded, true, 'too big for the limit');
  assert.equal((await mark(24, 'file', { name: 'run.exe' })).forwarded, true, 'a blocked type');
  const old = await find((m) => m.kind === 'image' && m.text === 'старое фото');
  assert.ok(old, 'the photo replaced its mark');
  assert.equal(old.file.mime, 'image/jpeg');
  assert.ok(await find((m) => m.kind === 'voice'), 'the voice message too');
  const dog = await find((m) => m.kind === 'file' && m.file?.name === 'договор.zip');
  assert.ok(dog, 'the document too');
  const all = await msgs();
  assert.equal(all.filter((m) => m.text === '[Файл]' && m.kind === 'text').length, 2, 'the two that cannot be fetched stay marks');
  // ... and they are not asked for again
  const waiting = async () => (await (await fetch(`${BASE}/api/bridge/pending?owner=${u.user.id}&kinds=photo,voice,file,video,audio`, { headers: { Authorization: `Bearer ${TOKEN}` } })).json()).items;
  assert.ok(await until(async () => (await waiting()).length === 0), 'nothing is waiting any more');
  assert.equal((await fetch(`${BASE}/api/bridge/pending?owner=${u.user.id}&kinds=file`)).status, 403, 'the door needs the secret');
});

test('a place sent in Telegram is a location message, also for a message that was copied as a mark', { skip: !havePy }, async () => {
  const u = await phoneUser('+998900002080', 'Места');
  await link(u);
  const tgPost = (body) => fetch(`${BASE}/api/bridge/in`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner: u.user.id, tg_chat: '7171', kind: 'user', title: 'Анвар', author: 'Анвар', ...body }) }).then((r) => r.json());
  assert.ok((await tgPost({ tg_msg: 1, text: '[Геопозиция]', geo: [41.311081, 69.240562] })).id);
  const chat = await until(async () => (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.title === '✈ Анвар'));
  const msgs = async () => (await call(u.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
  const here = (await msgs()).find((m) => m.kind === 'location');
  assert.equal(here.text, 'geo:41.311081,69.240562');
  // the old copy was only a mark; the upgrade turns it into the place
  assert.ok((await tgPost({ tg_msg: 2, text: '[Геопозиция]' })).id);
  assert.equal((await msgs()).filter((m) => m.kind === 'location').length, 1);
  assert.equal((await tgPost({ tg_msg: 2, text: '', geo: [40.1, 70.2], upgrade: true, backfill: true })).upgraded, true);
  assert.equal((await msgs()).filter((m) => m.kind === 'location').length, 2);
  assert.equal((await tgPost({ tg_msg: 3, text: 'почти', geo: [999, 70] })).ok, true, 'a wrong place stays an ordinary message');
  assert.equal((await msgs()).find((m) => m.text === 'почти').kind, 'text');
});

test('the copy of a Telegram chat shows when the other side is online in Telegram, and when they were last there', { skip: !havePy }, async () => {
  const u = await phoneUser('+998900002090', 'Присутствие');
  await link(u);
  const tgPost = (body) => fetch(`${BASE}/api/bridge/in`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner: u.user.id, tg_chat: '8181', kind: 'user', title: 'Жасур', author: 'Жасур', ...body }) }).then((r) => r.json());
  assert.ok((await tgPost({ tg_msg: 1, text: 'Привет' })).id);
  const chatOf = async () => (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.title === '✈ Жасур');
  assert.ok(await until(chatOf));
  assert.equal((await chatOf()).tg?.presence, undefined, 'nothing known yet');
  const onlineUntil = Date.now() + 120_000;
  assert.equal((await tgPost({ presence: true, online: true, until: onlineUntil })).changed, true);
  assert.equal((await chatOf()).tg.presence.online, true, 'online in Telegram');
  assert.equal((await tgPost({ presence: true, online: true, until: onlineUntil })).changed, false, 'the same news again changes nothing');
  const seen = Date.now() - 60_000;
  await tgPost({ presence: true, online: false, seen });
  const p = (await chatOf()).tg.presence;
  assert.equal(p.online, false);
  assert.equal(p.seen, seen);
  await tgPost({ presence: true, approx: 'recently' });
  assert.equal((await chatOf()).tg.presence.approx, 'recently');
  assert.equal((await tgPost({ presence: true, tg_chat: '555555', online: true })).skipped, true, 'an unknown chat is ignored');
});

test('the daily check can ask the bridge to catch up, and sees when it is done', { skip: !havePy }, async () => {
  const u = await phoneUser('+998900002099', 'Проверка');
  await link(u);
  const ask = (m, p) => fetch(`http://127.0.0.1:${BPORT}${p}?u=${u.user.id}`, { method: m, headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json().then((j) => ({ status: r.status, j })));
  const before = (await ask('GET', '/accounts')).j.accounts[String(u.user.id)];
  assert.equal(before.connected, true);
  assert.equal(typeof before.last_sync, 'number');
  const r = await ask('POST', '/resync');
  assert.equal(r.status, 200, JSON.stringify(r.j));
  const done = await until(async () => { const a = (await ask('GET', '/accounts')).j.accounts[String(u.user.id)]; return a.last_sync > 0 && !a.resyncing ? a : null; });
  assert.ok(done, 'the catch-up finished');
  assert.equal((await fetch(`http://127.0.0.1:${BPORT}/resync?u=999999`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}` } })).status >= 400, true);
});

test('a Telegram group with topics: each topic is a topic here, with its own messages and title kept up to date', { skip: !havePy }, async () => {
  const u = await phoneUser('+998900002100', 'Темы');
  await link(u);
  const tgPost = (body) => fetch(`${BASE}/api/bridge/in`, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ owner: u.user.id, tg_chat: '-100500', kind: 'group', title: 'Снабжение', author: 'Рустам', ...body }) }).then((r) => r.json());
  // the group is picked first (groups are copied only when chosen)
  assert.equal((await call(u.cookie, 'PUT', '/api/bridge/chats', { chats: [{ id: '-100500', title: 'Снабжение', kind: 'group', two_way: true }] })).status, 200);
  assert.ok((await tgPost({ tg_msg: 1, text: 'общее сообщение' })).id);
  assert.ok((await tgPost({ tg_msg: 2, text: 'пришла партия', tg_topic: 10, topic_title: 'SAP Приход', topic_color: 7322096 })).id);
  assert.ok((await tgPost({ tg_msg: 3, text: 'отклонение найдено', tg_topic: 11, topic_title: 'Отклонение' })).id);
  assert.ok((await tgPost({ tg_msg: 4, text: 'ещё приход', tg_topic: 10, topic_title: 'SAP Приход (новое)' })).id);
  const chat = (await call(u.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.title === '✈ Снабжение');
  assert.equal(chat.forum, true, 'the chat became a group with topics');
  const topics = (await call(u.cookie, 'GET', `/api/chats/${chat.id}/topics`)).data.topics;
  assert.deepEqual(topics.map((t) => t.title), ['', 'SAP Приход (новое)', 'Отклонение'], 'the titles come from Telegram and follow a rename');
  const inTopic = async (t) => (await call(u.cookie, 'GET', `/api/chats/${chat.id}/messages?topic=${t}`)).data.messages.map((m) => m.text);
  assert.deepEqual(await inTopic(0), ['общее сообщение']);
  assert.deepEqual(await inTopic(topics[1].id), ['пришла партия', 'ещё приход']);
  assert.deepEqual(await inTopic(topics[2].id), ['отклонение найдено']);
  assert.equal((await tgPost({ tg_msg: 2, text: 'пришла партия', tg_topic: 10 })).duplicate, true, 'the same message twice is one');
  // an answer written here inside a topic goes to Telegram with the topic named
  const r = await call(u.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'принято' }, { 'x-topic': String(topics[1].id) });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.message.topic_id, topics[1].id);
});
