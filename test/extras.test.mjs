// One-time media, several pins, live location, chat themes, read times, invite links and join requests, public channel pages,
// greeting and working hours, versions of a note.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6760 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', OTP_REQUESTS_PER_IP: '500', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-ex-')), REGISTRATION_OPEN: '1', NOTE_SESSION_GAP_MS: '300',
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

test('a one-time photo opens once for the recipient, never for the sender, and cannot be kept or forwarded', async () => {
  const a = await signup('alice_once');
  const b = await signup('boris_once');
  const chat = await direct(a, b);
  const up = await call(a.cookie, 'POST', `/api/chats/${chat.id}/files?name=secret.png&once=1`, null, PNG);
  assert.equal(up.status, 201);
  const m = up.data.message;
  assert.ok(m.once, 'the message is marked one-time');
  assert.deepEqual(m.once.views, []);
  const url = m.file.url;
  assert.equal((await fetch(BASE + url, { headers: { cookie: a.cookie } })).status, 404, 'the sender does not get it back');
  // the first request counts as the view and is answered, without any caching
  const first = await fetch(BASE + url, { headers: { cookie: b.cookie } });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  const msgs = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
  assert.deepEqual(msgs.find((x) => x.id === m.id).once.views, [b.data.user.id], 'the sender sees that it was opened');
  // it cannot be saved to the drive, forwarded or listed in the media panel
  assert.equal((await call(b.cookie, 'POST', '/api/drive', { file_id: m.file.id })).status, 403);
  const other = await direct(b, await signup('eve_once'));
  assert.equal((await call(b.cookie, 'POST', `/api/chats/${other.id}/messages`, { forward_of: m.id, client_id: 'forward-1234' })).status, 403);
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${chat.id}/media?kind=media`)).data.messages.length, 0);
  // an outsider never gets it
  const eve = await signup('mallory_once');
  assert.equal((await fetch(BASE + url, { headers: { cookie: eve.cookie } })).status, 404);
});

test('several pinned messages: pin, unpin one, unpin all', async () => {
  const a = await signup('alice_pin');
  const b = await signup('boris_pin');
  const chat = await direct(a, b);
  const ids = [];
  for (const t of ['один', 'два', 'три']) ids.push((await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: t })).data.message.id);
  for (const id of ids) await call(a.cookie, 'POST', `/api/chats/${chat.id}/pin`, { message_id: id });
  let c = (await call(b.cookie, 'GET', `/api/chats/${chat.id}`)).data.chat;
  assert.deepEqual(c.pins.map((p) => p.text), ['один', 'два', 'три']);
  assert.equal(c.pinned.text, 'три');
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/pin`, { message_id: ids[2], unpin: true });
  c = (await call(b.cookie, 'GET', `/api/chats/${chat.id}`)).data.chat;
  assert.deepEqual(c.pins.map((p) => p.text), ['один', 'два']);
  assert.equal(c.pinned.text, 'два');
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/pin`, { message_id: null });
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${chat.id}`)).data.chat.pins.length, 0);
});

test('live location: updates only while it lasts, only from its owner, and can be stopped', async () => {
  const a = await signup('alice_live');
  const b = await signup('boris_live');
  const chat = await direct(a, b);
  const start = await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'geo:41.311100,69.279700', kind: 'location', live_minutes: 15 });
  assert.equal(start.status, 201);
  const m = start.data.message;
  assert.ok(m.live_until > Date.now());
  assert.equal((await call(a.cookie, 'PUT', `/api/messages/${m.id}/live`, { lat: 41.32, lon: 69.3 })).status, 200);
  const got = (await call(b.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages.find((x) => x.id === m.id);
  assert.equal(got.text, 'geo:41.320000,69.300000');
  assert.equal((await call(b.cookie, 'PUT', `/api/messages/${m.id}/live`, { lat: 1, lon: 1 })).status, 404);
  assert.equal((await call(a.cookie, 'PUT', `/api/messages/${m.id}/live`, { lat: 99, lon: 1 })).status, 400);
  const stopped = await call(a.cookie, 'POST', `/api/messages/${m.id}/live/stop`);
  assert.ok(stopped.data.message.live_until <= Date.now() + 1000); // stopped now (the clocks of two processes may differ by a millisecond)
  assert.equal((await call(a.cookie, 'PUT', `/api/messages/${m.id}/live`, { lat: 41.3, lon: 69.2 })).status, 409);
});

test('chat theme: personal or shared, validated', async () => {
  const a = await signup('alice_theme');
  const b = await signup('boris_theme');
  const chat = await direct(a, b);
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${chat.id}/theme`, { theme: { c1: 'red' } })).status, 400);
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/theme`, { theme: { c1: '#112233', c2: '#445566', accent: '#ff8800', pattern: 2 } });
  assert.equal((await call(a.cookie, 'GET', `/api/chats/${chat.id}`)).data.chat.theme.c1, '#112233');
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${chat.id}`)).data.chat.theme, null, 'personal');
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/theme`, { theme: { preset: 'forest' }, shared: true });
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${chat.id}`)).data.chat.theme.preset, 'forest');
  await call(a.cookie, 'POST', `/api/chats/${chat.id}/theme`, { theme: null, shared: true });
  assert.equal((await call(b.cookie, 'GET', `/api/chats/${chat.id}`)).data.chat.theme, null);
});

test('who read a message and when; people who switched it off are only counted', async () => {
  const a = await signup('alice_rd');
  const b = await signup('boris_rd');
  const c = await signup('clara_rd');
  const g = (await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'Читатели', member_ids: [b.data.user.id, c.data.user.id] })).data.chat;
  const msg = (await call(a.cookie, 'POST', `/api/chats/${g.id}/messages`, { text: 'прочтите' })).data.message;
  await call(b.cookie, 'POST', `/api/chats/${g.id}/read`, { message_id: msg.id });
  await call(c.cookie, 'PATCH', '/api/me', { read_receipts: false });
  await call(c.cookie, 'POST', `/api/chats/${g.id}/read`, { message_id: msg.id });
  const r = (await call(a.cookie, 'GET', `/api/messages/${msg.id}/readers`)).data;
  assert.equal(r.total, 2);
  assert.equal(r.readers.length, 1);
  assert.equal(r.readers[0].user.name, 'boris_rd');
  assert.ok(r.readers[0].at > 0 && r.readers[0].at <= Date.now());
  assert.equal(r.hidden, 1);
});

test('invite links: limits, expiry, revoking, approval and requests', async () => {
  const owner = await signup('owner_inv');
  const g1 = await signup('guest1_inv');
  const g2 = await signup('guest2_inv');
  const g3 = await signup('guest3_inv');
  const chat = (await call(owner.cookie, 'POST', '/api/chats', { type: 'group', title: 'Ссылки' })).data.chat;
  assert.equal((await call(g1.cookie, 'POST', `/api/chats/${chat.id}/links`, { name: 'x' })).status, 404, 'only members, then only admins');
  const one = (await call(owner.cookie, 'POST', `/api/chats/${chat.id}/links`, { name: 'на одного', max_uses: 1 })).data.link;
  assert.equal((await call(g1.cookie, 'POST', `/api/invite/${one.code}/join`)).status, 200);
  assert.equal((await call(g2.cookie, 'POST', `/api/invite/${one.code}/join`)).status, 404, 'the limit is used up');
  const list = (await call(owner.cookie, 'GET', `/api/chats/${chat.id}/links`)).data;
  assert.equal(list.links[0].uses, 1);
  const rev = (await call(owner.cookie, 'POST', `/api/chats/${chat.id}/links`, { name: 'отзыв' })).data.link;
  await call(owner.cookie, 'DELETE', `/api/chats/${chat.id}/links/${rev.id}`);
  assert.equal((await call(g2.cookie, 'GET', `/api/invite/${rev.code}`)).status, 404, 'a revoked link is gone');
  // approval: the main link now makes a request
  await call(owner.cookie, 'POST', `/api/chats/${chat.id}/approval`, { on: true });
  const main = (await call(owner.cookie, 'GET', `/api/chats/${chat.id}/links`)).data.main;
  const req1 = await call(g2.cookie, 'POST', `/api/invite/${main}/join`);
  assert.equal(req1.status, 202);
  assert.equal(req1.data.pending, true);
  assert.equal((await call(g2.cookie, 'GET', `/api/chats/${chat.id}`)).status, 404, 'not a member yet');
  assert.equal((await call(g3.cookie, 'GET', `/api/chats/${chat.id}/requests`)).status, 404);
  const reqs = (await call(owner.cookie, 'GET', `/api/chats/${chat.id}/requests`)).data.requests;
  assert.deepEqual(reqs.map((x) => x.user.name), ['guest2_inv']);
  await call(g3.cookie, 'POST', `/api/invite/${main}/join`);
  assert.equal((await call(owner.cookie, 'POST', `/api/chats/${chat.id}/requests/${g2.data.user.id}`, { approve: true })).status, 200);
  assert.equal((await call(g2.cookie, 'GET', `/api/chats/${chat.id}`)).status, 200, 'approved: a member now');
  await call(owner.cookie, 'POST', `/api/chats/${chat.id}/requests/${g3.data.user.id}`, { approve: false });
  assert.equal((await call(g3.cookie, 'GET', `/api/chats/${chat.id}`)).status, 404, 'declined');
  assert.equal((await call(owner.cookie, 'GET', `/api/chats/${chat.id}/requests`)).data.requests.length, 0);
});

test('public page of a channel: only when public and named; posts, pictures, sitemap', async () => {
  const owner = await signup('owner_pub');
  const guest = await signup('guest_pub');
  const ch = (await call(owner.cookie, 'POST', '/api/chats', { type: 'channel', title: 'Новости <b>города</b>', description: 'Всё важное' })).data.chat;
  await call(owner.cookie, 'POST', `/api/chats/${ch.id}/messages`, { text: 'Первая запись https://example.com/x?a=1&b=2 <script>alert(1)</script>' });
  const photo = (await call(owner.cookie, 'POST', `/api/chats/${ch.id}/files?name=p.png&caption=${encodeURIComponent('Фото дня')}`, null, PNG)).data.message;
  const secretPhoto = (await call(owner.cookie, 'POST', `/api/chats/${ch.id}/files?name=once.png&once=1`, null, PNG)).data.message;
  assert.equal((await call(guest.cookie, 'POST', `/api/chats/${ch.id}/slug`, { slug: 'novosti_goroda' })).status, 404);
  assert.equal((await call(owner.cookie, 'POST', `/api/chats/${ch.id}/slug`, { slug: 'x' })).status, 400);
  assert.equal((await fetch(`${BASE}/c/novosti_goroda`)).status, 404, 'not yet public');
  assert.equal((await call(owner.cookie, 'POST', `/api/chats/${ch.id}/slug`, { slug: 'Novosti_Goroda' })).status, 200);
  const other = (await call(owner.cookie, 'POST', '/api/chats', { type: 'channel', title: 'Другой' })).data.chat;
  assert.equal((await call(owner.cookie, 'POST', `/api/chats/${other.id}/slug`, { slug: 'novosti_goroda' })).status, 409);
  const page = await fetch(`${BASE}/c/novosti_goroda`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
  const html = await page.text();
  assert.ok(html.includes('Новости &lt;b&gt;города&lt;/b&gt;'), 'the title is escaped');
  assert.ok(!html.includes('<script>alert'), 'posts are escaped too');
  assert.ok(html.includes('href="https://example.com/x?a=1&amp;b=2"'));
  assert.ok(html.includes(`/c/novosti_goroda/f/${photo.file.id}`));
  assert.ok(!html.includes(secretPhoto.file.id), 'a one-time file never appears');
  const img = await fetch(`${BASE}/c/novosti_goroda/f/${photo.file.id}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${BASE}/c/novosti_goroda/f/${secretPhoto.file.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/c/novosti_goroda/f/${'a'.repeat(16)}`)).status, 404);
  assert.ok((await (await fetch(`${BASE}/sitemap.xml`)).text()).includes('/c/novosti_goroda'));
  await call(owner.cookie, 'POST', `/api/chats/${ch.id}/public`, { public: false });
  assert.equal((await fetch(`${BASE}/c/novosti_goroda`)).status, 404, 'hidden again');
});

test('greeting for a new correspondent, and an automatic reply outside working hours', async () => {
  const boss = await signup('boss_work');
  const a = await signup('alice_work');
  const b = await signup('boris_work');
  await call(boss.cookie, 'PATCH', '/api/me', { greeting: 'Здравствуйте! Я на связи.' });
  const first = await direct(a, boss);
  await call(a.cookie, 'POST', `/api/chats/${first.id}/messages`, { text: 'привет' });
  await call(a.cookie, 'POST', `/api/chats/${first.id}/messages`, { text: 'ещё одно' });
  let msgs = (await call(a.cookie, 'GET', `/api/chats/${first.id}/messages`)).data.messages;
  assert.equal(msgs.filter((m) => m.text === 'Здравствуйте! Я на связи.').length, 1, 'only once');
  // working hours: a schedule that is closed now
  const now = new Date();
  const closedDay = (now.getUTCDay() + 3) % 7;
  const w = await call(boss.cookie, 'PATCH', '/api/me', { work: { on: true, days: [closedDay], from: '09:00', to: '18:00', tz: 0, text: 'Сейчас не работаю' } });
  assert.equal(w.data.user.work.on, true);
  const second = await direct(b, boss);
  await call(b.cookie, 'POST', `/api/chats/${second.id}/messages`, { text: 'вопрос по работе' });
  msgs = (await call(b.cookie, 'GET', `/api/chats/${second.id}/messages`)).data.messages;
  assert.ok(msgs.some((m) => m.text === 'Здравствуйте! Я на связи.') && !msgs.some((m) => m.text.startsWith('🤖')), 'the first message gets the greeting only');
  await call(b.cookie, 'POST', `/api/chats/${second.id}/messages`, { text: 'уточню вопрос' });
  msgs = (await call(b.cookie, 'GET', `/api/chats/${second.id}/messages`)).data.messages;
  assert.ok(msgs.some((m) => m.text === '🤖 Сейчас не работаю'), JSON.stringify(msgs.map((m) => m.text)));
  await call(b.cookie, 'POST', `/api/chats/${second.id}/messages`, { text: 'ещё вопрос' });
  msgs = (await call(b.cookie, 'GET', `/api/chats/${second.id}/messages`)).data.messages;
  assert.equal(msgs.filter((m) => m.text.startsWith('🤖')).length, 1, 'one reply per 12 hours');
});

test('versions of a note: a session ends, a snapshot is kept, an older text can be restored', async () => {
  const a = await signup('alice_ver');
  const b = await signup('boris_ver');
  const chat = await direct(a, b);
  const note = (await call(a.cookie, 'POST', `/api/chats/${chat.id}/notes`, { title: 'План' })).data.message.note;
  await call(a.cookie, 'POST', `/api/notes/${note.id}/op`, { rev: 0, pos: 0, del: 0, ins: 'первая версия', cid: 'v1' });
  assert.equal((await call(a.cookie, 'GET', `/api/notes/${note.id}/versions`)).data.versions.length, 0, 'one session so far');
  await new Promise((r) => setTimeout(r, 450)); // the session ends
  await call(b.cookie, 'POST', `/api/notes/${note.id}/op`, { rev: 1, pos: 13, del: 0, ins: ' и вторая', cid: 'v2' });
  const vs = (await call(a.cookie, 'GET', `/api/notes/${note.id}/versions`)).data;
  assert.equal(vs.versions.length, 1);
  assert.equal(vs.versions[0].rev, 1);
  assert.equal(vs.versions[0].preview, 'первая версия');
  assert.equal((await call(a.cookie, 'GET', `/api/notes/${note.id}/versions/1`)).data.version.body, 'первая версия');
  assert.equal((await call(b.cookie, 'GET', `/api/notes/${note.id}`)).data.note.body, 'первая версия и вторая');
  // restoring is a normal new edit, and what was there is kept as a version too
  const back = await call(a.cookie, 'POST', `/api/notes/${note.id}/restore`, { rev: 1 });
  assert.equal(back.status, 200);
  assert.equal((await call(b.cookie, 'GET', `/api/notes/${note.id}`)).data.note.body, 'первая версия');
  assert.ok((await call(a.cookie, 'GET', `/api/notes/${note.id}/versions`)).data.versions.some((v) => v.preview === 'первая версия и вторая'));
  assert.equal((await call(a.cookie, 'POST', `/api/notes/${note.id}/restore`, { rev: 99 })).status, 404);
  const eve = await signup('eve_ver');
  assert.equal((await call(eve.cookie, 'GET', `/api/notes/${note.id}/versions`)).status, 404);
});
