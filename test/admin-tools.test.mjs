// Super-admin tools: ban / delete, invitation-only registration, broadcast, backups, system health, call quality.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4900 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-adm-'));
const backupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-bk-'));

before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error',
    DATA_DIR: dataDir, BACKUP_DIR: backupDir, SUPERADMIN_PHONES: '+998900000001', OTP_REQUESTS_PER_IP: '500',
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});
after(() => server?.kill());

async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), headers: r.headers };
}
const signedIn = new Map();   // the administrator's number may ask for a code only three times in ten minutes: it signs in once for all the tests
async function login(phone, name, invite) {
  if (phone !== '+998900000001') return loginNew(phone, name, invite);
  if (signedIn.has(phone)) return signedIn.get(phone);
  const r = await loginNew(phone, name, invite);
  if (r.cookie) signedIn.set(phone, r);
  return r;
}
async function loginNew(phone, name, invite) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name, invite });
  return { status: v.status, error: v.data.error, cookie: v.headers.get('set-cookie')?.split(';')[0], user: v.data.user };
}

test('ban, delete, invitations, broadcast, backups, system, call quality', async () => {
  const root1 = await login('+998900000001', 'Root');
  assert.equal(root1.user.is_admin, true);
  const bob = await login('+998900000002', 'Bob');
  const eve = await login('+998900000003', 'Eve');
  const chat = (await call(bob.cookie, 'POST', '/api/chats/direct', { user_id: eve.user.id })).data.chat;
  await call(bob.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'hello eve' });

  // the limit of group calls is set by the main administrator only
  assert.equal((await call(root1.cookie, 'GET', '/api/admin/settings')).data.gcall_max, 6);
  assert.equal((await call(bob.cookie, 'PUT', '/api/admin/settings', { gcall_max: 10 })).status, 403);
  assert.equal((await call(root1.cookie, 'PUT', '/api/admin/settings', { gcall_max: 1 })).status, 400);
  assert.equal((await call(root1.cookie, 'PUT', '/api/admin/settings', { gcall_max: 99 })).status, 400);
  assert.equal((await call(root1.cookie, 'PUT', '/api/admin/settings', { gcall_max: 12 })).data.gcall_max, 12);
  assert.equal((await call(root1.cookie, 'GET', '/api/admin/settings')).data.gcall_max, 12);

  // non-admins are refused
  assert.equal((await call(bob.cookie, 'POST', `/api/admin/users/${eve.user.id}/ban`, {})).status, 403);

  // ban: sessions die at once, sign-in refused, unban restores
  assert.equal((await call(root1.cookie, 'POST', `/api/admin/users/${eve.user.id}/ban`, { banned: true, reason: 'spam' })).status, 200);
  assert.equal((await call(eve.cookie, 'GET', '/api/me')).status, 401);
  const again = await login('+998900000003', 'Eve');
  assert.equal(again.status, 403);
  assert.equal(again.error, 'account_banned');
  assert.equal((await call(root1.cookie, 'POST', `/api/admin/users/${root1.user.id}/ban`, {})).status, 400, 'cannot ban yourself');
  await call(root1.cookie, 'POST', `/api/admin/users/${eve.user.id}/ban`, { banned: false });
  const back = await login('+998900000003', 'Eve');
  assert.equal(back.status, 200);

  // registration by invitation only
  assert.equal((await call(root1.cookie, 'PUT', '/api/admin/settings', { registration: 'invite' })).status, 200);
  const noInv = await login('+998900000010', 'Newbie');
  assert.equal(noInv.status, 403);
  assert.equal(noInv.error, 'invite_required');
  assert.equal((await login('+998900000010', 'Newbie', 'bogus-code')).error, 'invite_invalid');
  const inv = (await call(root1.cookie, 'POST', '/api/admin/invites', { note: 'for newbie', max_uses: 1 })).data.invite;
  assert.ok(inv.code);
  const ok = await login('+998900000010', 'Newbie', inv.code);
  assert.equal(ok.status, 200);
  const second = await login('+998900000011', 'Second', inv.code);
  assert.equal(second.error, 'invite_invalid', 'one-time invitation is used up');
  // existing accounts still sign in without any invitation
  assert.equal((await login('+998900000002', 'Bob')).status, 200);
  await call(root1.cookie, 'PUT', '/api/admin/settings', { registration: 'closed' });
  assert.equal((await login('+998900000012', 'Late', inv.code)).error, 'registration_closed');
  await call(root1.cookie, 'PUT', '/api/admin/settings', { registration: 'open' });

  // broadcast arrives as a normal chat from the service account
  const sent = await call(root1.cookie, 'POST', '/api/admin/broadcast', { text: 'Плановые работы в 03:00' });
  assert.ok(sent.data.sent >= 3);
  const chats = (await call(bob.cookie, 'GET', '/api/chats')).data.chats;
  const svc = chats.find((c) => c.peer?.name === 'Suhbat-dosh');
  assert.ok(svc, 'service chat exists');
  assert.equal(svc.last_message.text, 'Плановые работы в 03:00');
  assert.equal(svc.peer.is_bot, true);

  // new-device alert lands in the service chat
  const bobAgain = await fetch(`${BASE}/api/auth/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ phone: '+998900000002' }) });
  const code = (await bobAgain.json()).dev_code;
  const vv = await fetch(`${BASE}/api/auth/verify`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': 'BrandNewPhone/9.9' }, body: JSON.stringify({ phone: '+998900000002', code }) });
  assert.equal(vv.status, 200);
  const after2 = (await call(bob.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.peer?.name === 'Suhbat-dosh');
  assert.match(after2.last_message.text, /Новый вход/);

  // backups
  const made = await call(root1.cookie, 'POST', '/api/admin/backups', {});
  assert.equal(made.status, 201);
  const list = (await call(root1.cookie, 'GET', '/api/admin/backups')).data.backups;
  assert.ok(list.some((b) => b.name === made.data.backup.name));
  const dl = await fetch(`${BASE}/api/admin/backups/${made.data.backup.name}`, { headers: { cookie: root1.cookie } });
  assert.equal(dl.status, 200);
  assert.ok((await dl.arrayBuffer()).byteLength > 4096);
  assert.equal((await call(root1.cookie, 'GET', '/api/admin/backups/..%2F..%2Fetc%2Fpasswd')).status, 404);
  assert.equal((await call(root1.cookie, 'POST', `/api/admin/backups/${made.data.backup.name}/restore`, {})).status, 400, 'restore needs confirmation');

  // system health
  const sys = (await call(root1.cookie, 'GET', '/api/admin/system')).data;
  assert.ok(sys.now.disk_total > 0);
  assert.ok(Array.isArray(sys.series));

  // call quality list
  assert.equal((await call(root1.cookie, 'GET', '/api/admin/call-quality')).status, 200);

  // delete account: its personal chat disappears for the peer
  assert.equal((await call(root1.cookie, 'DELETE', `/api/admin/users/${eve.user.id}`)).status, 200);
  const bobChats = (await call(bob.cookie, 'GET', '/api/chats')).data.chats;
  assert.ok(!bobChats.some((c) => c.id === chat.id));
  assert.equal((await call(root1.cookie, 'DELETE', `/api/admin/users/${root1.user.id}`)).status, 400);
});

test('the admin conversation view: filters, the live feed and the export are admin-only and leave a trace', async () => {
  const root1 = await login('+998900000001', 'Root');
  const ann = await login('+998900000011', 'Ann');
  const ben = await login('+998900000012', 'Ben');
  const chat = (await call(ann.cookie, 'POST', '/api/chats/direct', { user_id: ben.user.id })).data.chat;
  const say = (who, text) => call(who.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text });
  await say(ann, 'Meeting at NINE'); await say(ben, 'ok, see https://example.com/map'); await say(ann, 'bring the documents');
  const url = (extra = '') => `/api/admin/chats/${chat.id}/messages?${extra}`;

  const all = (await call(root1.cookie, 'GET', url())).data;
  assert.equal(all.messages.length, 3);
  assert.equal(all.total, 3);
  assert.deepEqual([...all.authors].sort(), ['Ann', 'Ben']);
  assert.deepEqual((await call(root1.cookie, 'GET', url('q=nine'))).data.messages.map((m) => m.text), ['Meeting at NINE']);   // any letter case
  assert.equal((await call(root1.cookie, 'GET', url('kind=link'))).data.messages.length, 1);
  assert.equal((await call(root1.cookie, 'GET', url('author=ben'))).data.messages.length, 1);
  assert.equal((await call(root1.cookie, 'GET', url(`since=${Date.now() + 60000}`))).data.messages.length, 0);
  assert.equal((await call(root1.cookie, 'GET', url('kind=nonsense'))).status, 400);

  // the live feed: only what came after, and it is not a new "viewed the conversation" entry
  const views = async () => (await call(root1.cookie, 'GET', '/api/admin/audit?action=admin.view_chat')).data.events.length;
  const before = await views();
  const lastId = all.messages.at(-1).id;
  await say(ben, 'one more');
  assert.deepEqual((await call(root1.cookie, 'GET', url(`after=${lastId}`))).data.messages.map((m) => m.text), ['one more']);
  assert.equal(await views(), before);

  // the export
  const txt = await fetch(BASE + `/api/admin/chats/${chat.id}/export?format=txt`, { headers: { cookie: root1.cookie } });
  assert.equal(txt.status, 200);
  const body = await txt.text();
  assert.ok(body.includes('Ann: Meeting at NINE') && body.includes('Ben: one more'));
  const html = await fetch(BASE + `/api/admin/chats/${chat.id}/export?format=html`, { headers: { cookie: root1.cookie } });
  assert.ok((await html.text()).includes('bring the documents'));
  assert.equal((await call(root1.cookie, 'GET', '/api/admin/audit?action=admin.export_chat')).data.events.length, 2);
  for (const who of [ann, ben]) {
    assert.equal((await call(who.cookie, 'GET', url())).status, 403);
    assert.equal((await fetch(BASE + `/api/admin/chats/${chat.id}/export`, { headers: { cookie: who.cookie } })).status, 403);
  }
});

test('a failed recording on a phone reaches the administrator with its reason', async () => {
  const root1 = await login('+998900000001', 'Root');
  const kim = await login('+998900000021', 'Kim');
  const r = await call(kim.cookie, 'POST', '/api/diag/media', { where: 'voice', name: 'NotAllowedError', message: 'Permission denied', mime: 'audio/mp4' });
  assert.equal(r.status, 200);
  const ev = (await call(root1.cookie, 'GET', '/api/admin/audit?action=client.media_error')).data.events;
  assert.equal(ev.length, 1);
  assert.equal(ev[0].details.name, 'NotAllowedError');
  assert.equal(ev[0].actor.id, kim.user.id);
  assert.equal((await call('', 'POST', '/api/diag/media', { name: 'x' })).status, 401);
});

test('the administrator searches messages by their words (any letter case) in every chat or in one', async () => {
  const root1 = await login('+998900000001', 'Root');
  const mia = await login('+998900000031', 'Mia');
  const ned = await login('+998900000032', 'Ned');
  const sol = await login('+998900000033', 'Sol');
  const c1 = (await call(mia.cookie, 'POST', '/api/chats/direct', { user_id: ned.user.id })).data.chat;
  const c2 = (await call(mia.cookie, 'POST', '/api/chats/direct', { user_id: sol.user.id })).data.chat;
  await call(mia.cookie, 'POST', `/api/chats/${c1.id}/messages`, { text: 'Transfer the MONEY on Friday' });
  await call(ned.cookie, 'POST', `/api/chats/${c1.id}/messages`, { text: 'ok, see you' });
  await call(mia.cookie, 'POST', `/api/chats/${c2.id}/messages`, { text: 'money for the rent' });
  const found = await call(root1.cookie, 'GET', '/api/admin/search?q=money');   const all = found.data.results;
  assert.equal(all.length, 2);
  assert.deepEqual(new Set(all.map((r) => r.chat_id)), new Set([c1.id, c2.id]));
  assert.equal((await call(root1.cookie, 'GET', `/api/admin/search?q=money&chat_id=${c2.id}`)).data.results.length, 1);
  assert.equal((await call(root1.cookie, 'GET', '/api/admin/search?q=m')).status, 400);
  assert.equal((await call(mia.cookie, 'GET', '/api/admin/search?q=money')).status, 403);
  // the meaning mode answers 503 while the embedding service is not there, and every search is in the journal
  const sem = await call(root1.cookie, 'GET', '/api/admin/search?q=payment&mode=meaning');
  assert.ok([200, 503].includes(sem.status));
  const log = (await call(root1.cookie, 'GET', '/api/admin/audit?action=admin.search')).data.events;
  assert.ok(log.length >= 3);
  assert.ok(log.some((e) => e.details?.q === 'money' && e.details?.mode === 'text'));
});

test('the daily check: finds a lost file, repairs the search index, keeps the history, and tells the time of day in the right zone', async () => {
  const { localClock } = await import('../server/src/clock.js');
  const root1 = await login('+998900000001', 'Root');
  const una = await login('+998900000041', 'Una');
  const vik = await login('+998900000042', 'Vik');
  const chat = (await call(una.cookie, 'POST', '/api/chats/direct', { user_id: vik.user.id })).data.chat;
  await call(una.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'a message for the index check' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const up = await fetch(`${BASE}/api/chats/${chat.id}/files?name=pic.png`, { method: 'POST', headers: { cookie: una.cookie, 'content-type': 'image/png' }, body: png });
  const fid = (await up.json()).message.file.id;

  const wait = async () => { for (let i = 0; i < 100; i++) { const d = (await call(root1.cookie, 'GET', '/api/admin/integrity')).data; if (!d.state.running) return d; await new Promise((r) => setTimeout(r, 100)); } throw new Error('the check did not finish'); };
  // a clean day
  assert.equal((await call(root1.cookie, 'POST', '/api/admin/integrity/run')).data.started, true);
  let d = await wait();
  const names = d.runs[0].checks.map((c) => c.name);
  for (const n of ['База данных', 'Индекс поиска', 'Файлы на диске', 'Запланированные сообщения', 'Резервные копии', 'Место на диске']) assert.ok(names.includes(n), n);
  assert.equal(d.runs[0].checks.find((c) => c.name === 'Файлы на диске').status, 'ok');

  // the index loses rows: the check puts them back and says so
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'suhbat.db'));
  db.exec('DELETE FROM msg_fts');
  db.close();
  await call(root1.cookie, 'POST', '/api/admin/integrity/run');
  d = await wait();
  const idx = d.runs[0].checks.find((c) => c.name === 'Индекс поиска');
  assert.equal(idx.status, 'warn');
  assert.ok(idx.fixed > 0);
  await call(root1.cookie, 'POST', '/api/admin/integrity/run');
  d = await wait();
  assert.equal(d.runs[0].checks.find((c) => c.name === 'Индекс поиска').status, 'ok');   // the next day it is whole

  // a file disappears from the disk: a problem, with the name of the file
  fs.unlinkSync(path.join(dataDir, 'files', fid));
  await call(root1.cookie, 'POST', '/api/admin/integrity/run');
  d = await wait();
  const lost = d.runs[0].checks.find((c) => c.name === 'Файлы на диске');
  assert.equal(lost.status, 'bad');
  assert.ok(lost.examples.some((x) => x.includes('pic.png')));
  assert.equal(d.runs[0].ok, false);
  assert.ok(d.runs.length >= 4);
  assert.equal((await call(una.cookie, 'GET', '/api/admin/integrity')).status, 403);
  assert.equal((await call(una.cookie, 'POST', '/api/admin/integrity/run')).status, 403);

  // 14:00 in Tashkent is 09:00 in Greenwich
  if (localClock) {
    process.env.INTEGRITY_TZ = 'Asia/Tashkent';
    assert.deepEqual(localClock(Date.UTC(2026, 9, 30, 9, 0)), { day: '2026-10-30', hm: '14:00' });
    assert.deepEqual(localClock(Date.UTC(2026, 9, 30, 20, 30)), { day: '2026-10-31', hm: '01:30' });
  }
});

test('exports: a ZIP with the files, a link with limits and a password, one for a chat and one for a person, revoking, and the journal', async () => {
  const { readZip } = await import('../web/js/zip.js');
  const root1 = await login('+998900000001', 'Root');
  const ada = await login('+998900000051', 'Ada');
  const bek = await login('+998900000052', 'Bek');
  const cat = await login('+998900000053', 'Cat');
  const dm = (await call(ada.cookie, 'POST', '/api/chats/direct', { user_id: bek.user.id })).data.chat;
  const grp = (await call(ada.cookie, 'POST', '/api/chats', { type: 'group', title: 'Команда', member_ids: [bek.user.id, cat.user.id] })).data.chat;
  await call(ada.cookie, 'POST', `/api/chats/${dm.id}/messages`, { text: 'личное от Ады' });
  await call(bek.cookie, 'POST', `/api/chats/${dm.id}/messages`, { text: 'ответ Бека' });
  await call(ada.cookie, 'POST', `/api/chats/${grp.id}/messages`, { text: 'в группе от Ады' });
  await call(cat.cookie, 'POST', `/api/chats/${grp.id}/messages`, { text: 'в группе от Кати' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await fetch(`${BASE}/api/chats/${grp.id}/files?name=${encodeURIComponent('схема.png')}`, { method: 'POST', headers: { cookie: ada.cookie, 'content-type': 'image/png' }, body: png });

  // the administrator only
  assert.equal((await call(ada.cookie, 'POST', '/api/admin/exports', { scope: 'chat', scope_id: dm.id })).status, 403);
  assert.equal((await call(ada.cookie, 'GET', `/api/admin/exports/now?scope=chat&scope_id=${dm.id}&format=txt`)).status, 403);

  // a link for the group: a ZIP with the files, two downloads, a password
  const made = await call(root1.cookie, 'POST', '/api/admin/exports', { scope: 'chat', scope_id: grp.id, format: 'zip', media: true, hours: 24, max_downloads: 2, password: 'sesame1', note: 'для проверки' });
  assert.equal(made.status, 201);
  const token = made.data.link.token;
  assert.equal(made.data.link.status, 'active');
  const landing = await fetch(`${BASE}/x/${token}`);
  assert.equal(landing.status, 200);
  assert.ok((await landing.text()).includes('Команда'));
  const get = (pw) => fetch(`${BASE}/x/${token}/get`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ p: pw }) });
  assert.equal((await get('wrong')).status, 403);
  const ok1 = await get('sesame1');
  assert.equal(ok1.status, 200);
  assert.equal(ok1.headers.get('content-type'), 'application/zip');
  const zip = Buffer.from(await ok1.arrayBuffer());
  const entries = await readZip(new File([zip], 'x.zip'));
  const names = [...entries.keys()];
  for (const n of ['messages.html', 'messages.txt', 'messages.json', 'README.txt']) assert.ok(names.includes(n), n);
  assert.ok(names.some((n) => n.startsWith('files/') && n.endsWith('схема.png')), 'the picture is in the archive');
  const txt = await (await entries.get('messages.txt').file()).text();
  assert.ok(txt.includes('в группе от Ады') && txt.includes('в группе от Кати'), txt);
  assert.ok(!txt.includes('личное от Ады'), 'the other chat is not in it');
  assert.equal((await get('sesame1')).status, 200);
  assert.equal((await get('sesame1')).status, 410, 'the third time the link is used up');
  assert.equal((await fetch(`${BASE}/x/${token}`)).status, 410);

  // everything one person wrote, in every chat, as JSON, by a link without a password; then revoked
  const mine = await call(root1.cookie, 'POST', '/api/admin/exports', { scope: 'user', scope_id: ada.user.id, format: 'json', hours: 1 });
  const tok2 = mine.data.link.token;
  const j = await fetch(`${BASE}/x/${tok2}/get`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(j.status, 200);
  const data = await j.json();
  const texts = data.chats.flatMap((c) => c.messages.map((m) => m.text));
  assert.ok(texts.includes('личное от Ады') && texts.includes('в группе от Ады'));
  assert.ok(!texts.includes('ответ Бека') && !texts.includes('в группе от Кати'), 'only what she wrote');
  assert.equal(data.chats.length, 2);
  const list = (await call(root1.cookie, 'GET', '/api/admin/exports')).data.links;
  assert.equal(list.find((l) => l.token === tok2).downloads, 1);
  assert.equal((await call(root1.cookie, 'DELETE', `/api/admin/exports/${list.find((l) => l.token === tok2).id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/x/${tok2}/get`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' })).status, 410);

  // the direct download, a text of one personal chat
  const direct = await fetch(`${BASE}/api/admin/exports/now?scope=chat&scope_id=${dm.id}&format=txt`, { headers: { cookie: root1.cookie } });
  assert.equal(direct.status, 200);
  const dtxt = await direct.text();
  assert.ok(dtxt.includes('личное от Ады') && dtxt.includes('ответ Бека'));
  assert.equal((await call(root1.cookie, 'POST', '/api/admin/exports', { scope: 'chat', scope_id: 999999 })).status, 404);

  // everything is in the journal
  const ev = (await call(root1.cookie, 'GET', '/api/admin/audit?limit=200')).data.events.map((e) => e.action);
  for (const a of ['admin.export_link', 'admin.export_data', 'admin.export_revoke', 'export.download']) assert.ok(ev.includes(a), a);
});

test('exports: one message, by a link or at once, with its file', async () => {
  const { readZip } = await import('../web/js/zip.js');
  const root1 = await login('+998900000001', 'Root');
  const eli = await login('+998900000061', 'Eli');
  const fay = await login('+998900000062', 'Fay');
  const chat = (await call(eli.cookie, 'POST', '/api/chats/direct', { user_id: fay.user.id })).data.chat;
  const m1 = (await call(eli.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'первое сообщение' })).data.message;
  await call(eli.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'второе сообщение' });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const withFile = (await (await fetch(`${BASE}/api/chats/${chat.id}/files?name=foto.png&caption=${encodeURIComponent('подпись')}`, { method: 'POST', headers: { cookie: eli.cookie, 'content-type': 'image/png' }, body: png })).json()).message;

  // at once: only that message
  const now = await fetch(`${BASE}/api/admin/exports/now?scope=message&scope_id=${m1.id}&format=txt`, { headers: { cookie: root1.cookie } });
  assert.equal(now.status, 200);
  const txt = await now.text();
  assert.ok(txt.includes('первое сообщение') && !txt.includes('второе сообщение'));
  // a link to a message with a picture: the archive holds that message and its file
  const l = (await call(root1.cookie, 'POST', '/api/admin/exports', { scope: 'message', scope_id: withFile.id, format: 'zip', media: true, hours: 1, max_downloads: 1 })).data.link;
  assert.ok(l.title.startsWith(`Сообщение №${withFile.id}`));
  const dl = await fetch(`${BASE}/x/${l.token}/get`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' });
  assert.equal(dl.status, 200);
  const entries = await readZip(new File([Buffer.from(await dl.arrayBuffer())], 'm.zip'));
  assert.ok([...entries.keys()].some((n) => n.startsWith('files/') && n.endsWith('foto.png')));
  const body = await (await entries.get('messages.txt').file()).text();
  assert.ok(body.includes('подпись') && !body.includes('первое сообщение'));
  assert.equal((await fetch(`${BASE}/x/${l.token}/get`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' })).status, 410);
  assert.equal((await call(root1.cookie, 'POST', '/api/admin/exports', { scope: 'message', scope_id: 99999999 })).status, 404);
  assert.equal((await call(eli.cookie, 'POST', '/api/admin/exports', { scope: 'message', scope_id: m1.id })).status, 403);
});
