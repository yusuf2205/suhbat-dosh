// Topics in groups and comments under channel posts.
// Several topics in one group, unread per topic, comments with their own thread.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6860 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', OTP_REQUESTS_PER_IP: '500', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-fo-')), REGISTRATION_OPEN: '1', NOTE_SESSION_GAP_MS: '300',
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
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...(raw ? { 'content-type': 'application/octet-stream' } : {}) },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0], headers: r.headers };
}
let phoneSeq = 0;
// sign-in by phone (the dev mode returns the code): registration by password is limited to 10 per hour per address
async function signup(username) {
  const phone = `+99890${String(1000000 + (phoneSeq += 1))}`;
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name: username });
  return v;
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const direct = async (a, b) => (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;

const withTopic = (cookie, topic, url, body) => fetch(BASE + url, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-topic': String(topic) }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));

test('topics: messages go to their topic, the feed and the unread counters are per topic, closed topics need an admin', async () => {
  const a = await signup('alice_tp');
  const b = await signup('boris_tp');
  const g = (await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'Команда', member_ids: [b.data.user.id] })).data.chat;
  await call(a.cookie, 'POST', `/api/chats/${g.id}/messages`, { text: 'старое сообщение' });
  assert.equal((await call(b.cookie, 'POST', `/api/chats/${g.id}/forum`, { on: true })).status, 403, 'only the owner');
  const on = await call(a.cookie, 'POST', `/api/chats/${g.id}/forum`, { on: true });
  assert.equal(on.data.chat.forum, true);
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${g.id}`)).data.chat.unread, 1, 'the old message is still unread for Boris');
  const work = (await call(a.cookie, 'POST', `/api/chats/${g.id}/topics`, { title: 'Работа', emoji: '💼' })).data.topic;
  const fun = (await call(a.cookie, 'POST', `/api/chats/${g.id}/topics`, { title: 'Флуд' })).data.topic;
  assert.equal((await call(b.cookie, 'POST', `/api/chats/${g.id}/topics`, { title: 'Моя' })).status, 403);
  await withTopic(a.cookie, work.id, `/api/chats/${g.id}/messages`, { text: 'отчёт готов' });
  await withTopic(a.cookie, work.id, `/api/chats/${g.id}/messages`, { text: 'ещё про отчёт' });
  await withTopic(a.cookie, fun.id, `/api/chats/${g.id}/messages`, { text: 'мем' });
  await withTopic(a.cookie, 0, `/api/chats/${g.id}/messages`, { text: 'в общий' });
  const topics = (await call(b.cookie, 'GET', `/api/chats/${g.id}/topics`)).data.topics;
  assert.deepEqual(topics.map((t) => [t.id, t.unread]), [[0, 2], [work.id, 2], [fun.id, 1]]);
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${g.id}`)).data.chat.unread, 5);
  const feed = (t) => call(b.cookie, 'GET', `/api/chats/${g.id}/messages?topic=${t}`).then((r) => r.data.messages.map((m) => m.text));
  assert.deepEqual(await feed(work.id), ['отчёт готов', 'ещё про отчёт']);
  assert.deepEqual(await feed(fun.id), ['мем']);
  assert.deepEqual(await feed(0), ['старое сообщение', 'в общий']);
  // reading one topic leaves the others unread
  const last = (await call(b.cookie, 'GET', `/api/chats/${g.id}/messages?topic=${work.id}`)).data.messages.at(-1).id;
  await call(b.cookie, 'POST', `/api/chats/${g.id}/read-topic`, { topic: work.id, message_id: last });
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${g.id}`)).data.chat.unread, 3);
  // a reply stays in the topic of the message; an unknown topic is refused
  const first = (await call(b.cookie, 'GET', `/api/chats/${g.id}/messages?topic=${fun.id}`)).data.messages[0];
  const reply = await withTopic(b.cookie, 0, `/api/chats/${g.id}/messages`, { text: 'смешно', reply_to: first.id });
  assert.equal(reply.data.message.topic_id, fun.id);
  assert.equal((await withTopic(b.cookie, 999, `/api/chats/${g.id}/messages`, { text: 'x' })).status, 404);
  // closing
  await call(a.cookie, 'PATCH', `/api/topics/${fun.id}`, { closed: true });
  assert.equal((await withTopic(b.cookie, fun.id, `/api/chats/${g.id}/messages`, { text: 'после закрытия' })).status, 403);
  assert.equal((await withTopic(a.cookie, fun.id, `/api/chats/${g.id}/messages`, { text: 'админ может' })).status, 201);
  assert.equal((await call(b.cookie, 'PATCH', `/api/topics/${work.id}`, { title: 'X' })).status, 403);
});

test('comments under channel posts: members of the channel can comment, the feed and the counters stay clean', async () => {
  const owner = await signup('owner_cm');
  const reader = await signup('reader_cm');
  const stranger = await signup('stranger_cm');
  const ch = (await call(owner.cookie, 'POST', '/api/chats', { type: 'channel', title: 'Канал', member_ids: [reader.data.user.id] })).data.chat;
  const post = (await call(owner.cookie, 'POST', `/api/chats/${ch.id}/messages`, { text: 'Новая запись' })).data.message;
  assert.equal((await call(reader.cookie, 'POST', `/api/messages/${post.id}/comments`, { text: 'рано' })).status, 404, 'comments are off');
  assert.equal((await call(reader.cookie, 'POST', `/api/chats/${ch.id}/comments-on`, { on: true })).status, 403);
  await call(owner.cookie, 'POST', `/api/chats/${ch.id}/comments-on`, { on: true });
  const c1 = await call(reader.cookie, 'POST', `/api/messages/${post.id}/comments`, { text: 'Отличная новость', client_id: 'comment-0001' });
  assert.equal(c1.status, 201);
  await call(owner.cookie, 'POST', `/api/messages/${post.id}/comments`, { text: 'Спасибо!', reply_to: c1.data.comment.id });
  const dup = await call(reader.cookie, 'POST', `/api/messages/${post.id}/comments`, { text: 'Отличная новость', client_id: 'comment-0001' });
  assert.equal(dup.status, 200, 'the same request is not posted twice');
  const list = (await call(stranger.cookie, 'GET', `/api/messages/${post.id}/comments`));
  assert.equal(list.status, 404, 'strangers do not see it');
  const got = (await call(reader.cookie, 'GET', `/api/messages/${post.id}/comments`)).data.comments;
  assert.deepEqual(got.map((x) => x.text), ['Отличная новость', 'Спасибо!']);
  assert.equal(got[1].reply_to.id, got[0].id);
  // the feed shows the post with its count and no comments; nobody gets an unread mark for comments
  const feed = (await call(reader.cookie, 'GET', `/api/chats/${ch.id}/messages`)).data.messages;
  assert.deepEqual(feed.map((m) => m.text), ['Новая запись']);
  assert.equal(feed[0].comments, 2);
  const chat = (await call(reader.cookie, 'GET', `/api/chats/${ch.id}`)).data.chat;
  assert.equal(chat.unread, 1, 'only the post');
  assert.equal(chat.last_message.text, 'Новая запись');
  assert.equal((await call(reader.cookie, 'POST', `/api/messages/${got[0].id}/comments`, { text: 'вложенный' })).status, 404, 'no comments of comments');
});

test('sticker and emoji sets: made from your own stickers, found by link, added by others, usable in any chat', async () => {
  const a = await signup('alice_set');
  const b = await signup('boris_set');
  const c = await signup('clara_set');
  const sticker = async (u) => (await call(u.cookie, 'POST', '/api/stickers', null, PNG)).data.sticker;
  const s1 = await sticker(a);
  assert.ok(s1?.file?.id, 'the picture was accepted as a sticker');
  const set = (await call(a.cookie, 'POST', '/api/sets', { title: 'Мои эмодзи', kind: 'emoji' })).data.set;
  assert.equal(set.slug.length, 8);
  const added = await call(a.cookie, 'POST', `/api/sets/${set.id}/items`, { sticker_id: s1.id });
  assert.equal(added.data.set.items.length, 1);
  assert.equal((await call(a.cookie, 'POST', `/api/sets/${set.id}/items`, { sticker_id: s1.id })).status, 409);
  assert.equal((await call(b.cookie, 'POST', `/api/sets/${set.id}/items`, { sticker_id: s1.id })).status, 404, 'only the owner edits');
  // Boris finds it by its link and adds it
  const found = (await call(b.cookie, 'GET', `/api/sets/by/${set.slug}`)).data.set;
  assert.equal(found.installed, false);
  assert.equal((await call(b.cookie, 'POST', `/api/sets/${set.id}/install`)).data.set.installed, true);
  const mine = (await call(b.cookie, 'GET', '/api/sets')).data.sets;
  assert.deepEqual(mine.map((s) => s.title), ['Мои эмодзи']);
  // the pictures are visible to everybody (they appear inside messages), even without installing
  assert.equal((await fetch(BASE + found.items[0].file.url, { headers: { cookie: c.cookie } })).status, 200);
  // a sticker of an added set can be sent; one of a set the person does not have cannot
  const chat = await direct(b, a);
  const sent = await call(b.cookie, 'POST', `/api/chats/${chat.id}/stickers`, { set_item_id: found.items[0].id, client_id: 'set-sticker-1' });
  assert.equal(sent.status, 201);
  assert.equal(sent.data.message.kind, 'sticker');
  const chat2 = await direct(c, a);
  assert.equal((await call(c.cookie, 'POST', `/api/chats/${chat2.id}/stickers`, { set_item_id: found.items[0].id, client_id: 'set-sticker-2' })).status, 404);
  // after removing the set from Boris it is gone from his list
  await call(b.cookie, 'DELETE', `/api/sets/${set.id}/install`);
  assert.equal((await call(b.cookie, 'GET', '/api/sets')).data.sets.length, 0);
  // an emoji set takes only small still pictures
  const big = Buffer.concat([PNG, Buffer.alloc(300 * 1024)]);
  const bigSticker = (await call(a.cookie, 'POST', '/api/stickers', null, big)).data.sticker;
  if (bigSticker) assert.equal((await call(a.cookie, 'POST', `/api/sets/${set.id}/items`, { sticker_id: bigSticker.id })).status, 400);
  assert.equal((await call(a.cookie, 'DELETE', `/api/sets/${set.id}`)).status, 200);
  assert.equal((await call(b.cookie, 'GET', `/api/sets/by/${set.slug}`)).status, 404);
});

test('search by meaning: messages are indexed by the embedding service and found by closeness, only inside your own chats', async () => {
  // a stand-in for the model: words are hashed into a small vector, so shared meaning (here: shared words) means closeness
  const http = await import('node:http');
  const dim = 64;
  const vec = (text) => {
    const v = new Array(dim).fill(0);
    for (const w of text.toLowerCase().match(/\p{L}+/gu) || []) { let h = 0; for (const ch of w) h = (h * 31 + ch.codePointAt(0)) % dim; v[h] += 1; }
    const n = Math.hypot(...v) || 1;
    return v.map((x) => x / n);
  };
  const stub = http.createServer((req, res) => {
    if (req.url === '/health') { res.end('{"ok":true}'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => { const j = JSON.parse(body); res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ vectors: j.texts.map((t) => vec(t.replace(/^(query|passage): /, ''))), dim })); });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port2 = PORT + 7;
  const env2 = {
    ...process.env, PORT: String(port2), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', OTP_REQUESTS_PER_IP: '500', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-sem-')), EMBED_URL: `http://127.0.0.1:${stub.address().port}`, EMBED_TICK_MS: '300',
  };
  delete env2.NODE_OPTIONS; delete env2.NODE_TEST_CONTEXT;
  const srv2 = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env: env2, stdio: 'inherit' });
  const call2 = async (cookie, method, url, body) => {
    const r = await fetch(`http://127.0.0.1:${port2}${url}`, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
  };
  try {
    for (let i = 0; i < 80; i++) { try { if ((await fetch(`http://127.0.0.1:${port2}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    let n = 0;
    const user = async (name) => {
      const phone = `+99891${String(2000000 + (n += 1))}`;
      const a = await call2('', 'POST', '/api/auth/request', { phone });
      return call2('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
    };
    const a = await user('alice_sem');
    const b = await user('boris_sem');
    const eve = await user('eve_sem');
    const chat = (await call2(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
    const secretChat = (await call2(a.cookie, 'POST', '/api/chats/direct', { user_id: eve.data.user.id })).data.chat;
    await call2(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'договор с поставщиком подписан вчера вечером' });
    await call2(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'купить молоко хлеб и яйца в магазине' });
    await call2(a.cookie, 'POST', `/api/chats/${secretChat.id}/messages`, { text: 'договор с поставщиком для другого человека' });
    let status;
    for (let i = 0; i < 40; i++) {
      status = (await call2(b.cookie, 'GET', '/api/search/semantic/status')).data;
      if (status.done >= 2) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(status.ready, true);
    assert.equal(status.done, 2, 'Boris sees the two messages of his own chat indexed');
    const r = await call2(b.cookie, 'GET', `/api/search/semantic?q=${encodeURIComponent('подписан договор поставщиком')}`);
    assert.equal(r.status, 200);
    assert.equal(r.data.results[0].message.text, 'договор с поставщиком подписан вчера вечером');
    assert.ok(r.data.results[0].score > r.data.results[1].score);
    assert.ok(!r.data.results.some((x) => x.message.chat_id === secretChat.id), 'never the chats of other people');
    assert.equal((await call2(b.cookie, 'GET', '/api/search/semantic?q=ab')).status, 400);
  } finally { srv2.kill(); stub.close(); }
});
