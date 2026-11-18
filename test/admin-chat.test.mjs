// Reading a conversation as an administrator: marks with notes, a summary, going to a date or a number, more filters.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 21010; // its own range of ten ports: test files run side by side
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-ac-')), SUPERADMIN_PHONES: '+998900000001', OTP_REQUESTS_PER_IP: '500' };
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
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
let adminSession;
async function adminLogin() { return (adminSession ||= await login('+998900000001', 'Админ')); }
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  return call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
}

test('marks, summary, going to a date or a number, filters; ordinary people get none of it', async () => {
  const admin = await login('+998900000001', 'Админ');
  const a = await login('+998901110001', 'Мадина');
  const b = await login('+998901110002', 'Азиз');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const say = async (who, text) => (await call(who.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text, client_id: crypto.randomUUID() })).data.message;
  const m1 = await say(a, 'привет');
  const m2 = await say(b, 'смотри https://example.com/x');
  const m3 = await say(a, 'ещё');
  await new Promise((r) => setTimeout(r, 30));
  const edited = await say(b, 'было');
  await call(b.cookie, 'PATCH', `/api/messages/${edited.id}`, { text: 'стало' });

  const url = `/api/admin/chats/${chat.id}`;
  for (const [method, u, body] of [['POST', `/api/admin/messages/${m1.id}/mark`, {}], ['DELETE', `/api/admin/messages/${m1.id}/mark`], ['GET', `${url}/stats`], ['GET', `${url}/find?id=${m1.id}`]]) {
    assert.equal((await call(a.cookie, method, u, body)).status, 403, `${method} ${u}`);
  }

  // a mark with a note
  assert.equal((await call(admin.cookie, 'POST', `/api/admin/messages/${m2.id}/mark`, { note: 'Проверить ссылку' })).status, 200);
  assert.equal((await call(admin.cookie, 'POST', '/api/admin/messages/99999999/mark', {})).status, 404);
  let list = (await call(admin.cookie, 'GET', `${url}/messages?limit=50`)).data.messages;
  assert.equal(list.find((m) => m.id === m2.id).mark.note, 'Проверить ссылку');
  assert.equal(list.find((m) => m.id === m1.id).mark, null);
  const marked = (await call(admin.cookie, 'GET', `${url}/messages?limit=50&kind=marked`)).data;
  assert.deepEqual(marked.messages.map((m) => m.id), [m2.id]);
  assert.equal(marked.total, 1);
  // the people in the chat do not see it
  const own = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
  assert.equal(own.find((m) => m.id === m2.id).mark, undefined);
  assert.equal((await call(admin.cookie, 'DELETE', `/api/admin/messages/${m2.id}/mark`)).status, 200);
  assert.equal((await call(admin.cookie, 'GET', `${url}/messages?kind=marked`)).data.messages.length, 0);

  // other filters
  assert.deepEqual((await call(admin.cookie, 'GET', `${url}/messages?kind=edited`)).data.messages.map((m) => m.id), [edited.id]);
  assert.equal((await call(admin.cookie, 'GET', `${url}/messages?kind=media`)).data.messages.length, 0);

  // the summary
  const s = (await call(admin.cookie, 'GET', `${url}/stats`)).data;
  assert.equal(s.total, 4);
  assert.equal(s.edited, 1);
  assert.equal(s.links, 1);
  assert.deepEqual(s.by_author.map((x) => [x.name, x.n]).sort(), [['Азиз', 2], ['Мадина', 2]]);
  assert.equal(s.by_kind.find((k) => k.kind === 'text').n, 4);
  assert.ok(s.first_at <= s.last_at);
  // the list of what the conversation holds (photos, videos, files, audio, links, voice, GIF), each kind opens by its name
  assert.deepEqual(s.media, { photo: 0, video: 0, file: 0, audio: 0, link: 1, voicemsg: 0, gif: 0 });
  for (const k of Object.keys(s.media)) assert.equal((await call(admin.cookie, 'GET', `${url}/messages?kind=${k}`)).status, 200, k);
  assert.equal((await call(admin.cookie, 'GET', `${url}/messages?kind=link`)).data.messages.length, 1);
  assert.equal((await call(admin.cookie, 'GET', `${url}/messages?kind=deleted`)).status, 200, 'the filter of the messages deleted in Telegram');

  // going somewhere
  assert.equal((await call(admin.cookie, 'GET', `${url}/find?id=${m3.id}`)).data.id, m3.id);
  assert.equal((await call(admin.cookie, 'GET', `${url}/find?id=99999999`)).status, 404, 'a number from another chat or none');
  const after = (await call(admin.cookie, 'GET', `${url}/find?at=${m1.created_at}`)).data.id;
  assert.equal(after, m1.id);
  assert.equal((await call(admin.cookie, 'GET', `${url}/find?at=${Date.now() + 86400000}`)).data.id, edited.id, 'after the end: the last message');
  assert.equal((await call(admin.cookie, 'GET', `${url}/find`)).status, 400);
  // the places of a word: numbers of the messages, the newest first; the conversation itself is not narrowed
  const hits = (await call(admin.cookie, 'GET', `${url}/hits?q=${encodeURIComponent('стало')}`)).data;
  assert.deepEqual(hits.ids, [edited.id]);
  assert.equal(hits.total, 1);
  assert.deepEqual((await call(admin.cookie, 'GET', `${url}/hits?q=ст`)).data.ids, [], 'two letters: nothing is scanned');
  assert.equal((await call(a.cookie, 'GET', `${url}/hits?q=x`)).status, 403, 'ordinary people get none of it');
  // the tiles of the map cards: only for the people who are signed in, and only real tiles
  assert.equal((await call('', 'GET', '/api/map/tile/16/1/1.png')).status, 401, 'a tile for a signed-in person only');
  assert.equal((await call(a.cookie, 'GET', '/api/map/tile/99/1/1.png')).status, 400, 'a zoom that does not exist');
  assert.equal((await call(a.cookie, 'GET', '/api/map/tile/3/9/1.png')).status, 400, 'a tile outside the map');
  void list;
});

test('freeing the disk: the files of a person go, the messages stay; only who may delete accounts can do it', async () => {
  const admin = await adminLogin();
  const a = await login('+998901110011', 'Лола');
  const b = await login('+998901110012', 'Бахром');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const data = crypto.randomBytes(50_000);
  const init = await call(a.cookie, 'POST', `/api/chats/${chat.id}/uploads`, { name: 'x.bin', size: data.length, client_id: 'client-purge-1' });
  const put = await fetch(`${BASE}/api/uploads/${init.data.upload_id}?offset=0`, { method: 'PUT', headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' }, body: data });
  assert.equal(put.status, 200);
  const done = await call(a.cookie, 'POST', `/api/uploads/${init.data.upload_id}/complete`);
  assert.equal(done.status, 201);
  const msg = done.data.message;
  const base = `/api/admin/users/${a.data.user.id}/purge`;
  assert.equal((await call(a.cookie, 'GET', base)).status, 403, 'an ordinary person');
  const pre = await call(admin.cookie, 'GET', `${base}?kinds=file`);
  assert.equal(pre.data.files, 1);
  assert.equal(pre.data.bytes, data.length);
  assert.equal((await call(admin.cookie, 'GET', `${base}?kinds=video`)).data.files, 0, 'another kind: nothing');
  assert.equal((await call(admin.cookie, 'GET', `${base}?older_days=30`)).data.files, 0, 'too fresh');
  assert.equal((await call(admin.cookie, 'POST', base, { kinds: 'file' })).status, 400, 'no confirmation');
  const r = await call(admin.cookie, 'POST', base, { confirm: true, kinds: 'file' });
  assert.equal(r.data.files, 1);
  assert.equal((await call(admin.cookie, 'GET', base)).data.files, 0);
  const left = (await call(admin.cookie, 'GET', `/api/admin/chats/${chat.id}/messages?limit=50`)).data.messages;
  assert.ok(left.some((m) => m.id === msg.id), 'the message stays');
});

test('search in the whole history with filters: kind, person, period, type of chat; words may be left out', async () => {
  const admin = await adminLogin();
  const a = await login('+998901110021', 'Зарина');
  const b = await login('+998901110022', 'Тимур');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const say = (who, text) => call(who.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text, client_id: crypto.randomUUID() });
  await say(a, 'встреча в пятницу https://example.com/a');
  await say(b, 'встреча перенесена');
  const find = (qs) => call(admin.cookie, 'GET', `/api/admin/search?${qs}`);
  assert.equal((await find('q=встреча')).data.results.length, 2);
  assert.equal((await find('q=встреча&author=Тимур')).data.results.length, 1, 'only one person');
  assert.equal((await find('q=встреча&kind=link')).data.results.length, 1, 'only links');
  assert.equal((await find('q=встреча&chat_type=group')).data.results.length, 0, 'no such chat type');
  assert.equal((await find('q=встреча&chat_type=direct')).data.results.length, 2);
  assert.equal((await find('q=встреча&since=' + (Date.now() + 86400000))).data.results.length, 0, 'a period in the future');
  assert.equal((await find('author=Зарина')).data.results.length, 1, 'no words: all of one person');
  assert.equal((await find('q=')).status, 400, 'neither words nor filters');
  assert.equal((await find('q=встреча&chat_type=bad')).status, 400);
});

test('freeing the disk by kind of chat: personal, groups, channels', async () => {
  const admin = await adminLogin();
  const a = await login('+998901110031', 'Нодира');
  const b = await login('+998901110032', 'Шухрат');
  const direct = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const group = (await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'Семья', member_ids: [b.data.user.id] })).data.chat;
  const up = async (chat, n) => {
    const init = await call(a.cookie, 'POST', `/api/chats/${chat.id}/uploads`, { name: 'x.bin', size: 1000, client_id: `client-t-${n}-${chat.id}` });
    await fetch(`${BASE}/api/uploads/${init.data.upload_id}?offset=0`, { method: 'PUT', headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' }, body: crypto.randomBytes(1000) });
    assert.equal((await call(a.cookie, 'POST', `/api/uploads/${init.data.upload_id}/complete`)).status, 201);
  };
  await up(direct, 1); await up(group, 2);
  const base = `/api/admin/users/${a.data.user.id}/purge`;
  const preR = await call(admin.cookie, 'GET', base); const pre = preR.data;
  assert.equal(pre.types.direct.files, 1);
  assert.equal(pre.types.group.files, 1);
  assert.equal((await call(admin.cookie, 'GET', `${base}?chat_types=group`)).data.files, 1);
  assert.equal((await call(admin.cookie, 'GET', `${base}?chat_types=channel`)).data.files, 0);
  assert.equal((await call(admin.cookie, 'POST', base, { confirm: true, chat_types: 'none' })).data.files, 0, 'an empty choice deletes nothing');
  assert.equal((await call(admin.cookie, 'POST', base, { confirm: true, chat_types: 'group' })).data.files, 1);
  assert.equal((await call(admin.cookie, 'GET', base)).data.files, 1, 'the personal chat file stays');
});

test('documents in the admin chat: PDF and text open in the browser, Word and Excel come with their real type', async () => {
  const admin = await adminLogin();
  const a = await login('+998901110021', 'Зафар');
  const b = await login('+998901110022', 'Умида');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const send = async (name, bytes, id) => {
    const init = await call(a.cookie, 'POST', `/api/chats/${chat.id}/uploads`, { name, size: bytes.length, client_id: id });
    assert.equal(init.status, 201, JSON.stringify(init.data));
    await fetch(`${BASE}/api/uploads/${init.data.upload_id}?offset=0`, { method: 'PUT', headers: { cookie: a.cookie, 'content-type': 'application/octet-stream' }, body: bytes });
    const done = await call(a.cookie, 'POST', `/api/uploads/${init.data.upload_id}/complete`);
    assert.equal(done.status, 201, name);
    return done.data.message.file.id;
  };
  const get = (id, qs = '') => fetch(`${BASE}/api/admin/files/${id}${qs}`, { headers: { cookie: admin.cookie } });
  const pdf = await get(await send('отчёт.pdf', Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'), 'client-doc-pdf'));
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  assert.match(pdf.headers.get('content-disposition'), /^inline/);
  assert.doesNotMatch(pdf.headers.get('content-security-policy'), /sandbox/);
  const txt = await get(await send('заметки.txt', Buffer.from('привет'), 'client-doc-txt'));
  assert.match(txt.headers.get('content-type'), /^text\/plain/);
  assert.match(txt.headers.get('content-disposition'), /^inline/);
  const docx = await get(await send('договор.docx', crypto.randomBytes(300), 'client-doc-docx'));
  assert.equal(docx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.match(docx.headers.get('content-disposition'), /^attachment/);
  const xlsx = await get(await send('цены.xlsx', crypto.randomBytes(300), 'client-doc-xlsx'));
  assert.equal(xlsx.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const pdfId = pdf.url.split('/').pop();
  assert.match((await get(pdfId, '?download=1')).headers.get('content-disposition'), /^attachment/);
});

test('the pages list the modules they need at the start (modulepreload), so a slow link does not pay a round trip per level of imports', async () => {
  const home = await (await fetch(`${BASE}/`)).text();
  const links = [...home.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]);
  assert.ok(links.length >= 10, `the messenger lists its modules (${links.length})`);
  assert.ok(links.some((u) => u.startsWith('/js/main.js?v=')) && links.some((u) => u.startsWith('/js/chat.js?v=')), 'the entry and the chat');
  assert.equal(new Set(links).size, links.length, 'each once');
  assert.ok(!links.some((u) => /jsqr/.test(u)), 'the QR reader (250 KB) is not loaded at the start, only when a camera opens');
  for (const u of links.slice(0, 5)) assert.equal((await fetch(BASE + u)).status, 200, u);
  const admin = await (await fetch(`${BASE}/admin.html`)).text();
  assert.ok([...admin.matchAll(/modulepreload" href="(\/js\/admin\.js\?v=[^"]+)"/g)].length === 1, 'the console lists its entry');
});
