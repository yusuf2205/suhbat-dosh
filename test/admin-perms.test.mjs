// Rights of administrators: only the main one hands them out; each one opens exactly its part; what is not listed stays closed.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 21020; // its own range of ten ports: test files run side by side
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-ap-')), BACKUP_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-apb-')), SUPERADMIN_PHONES: '+998900000001', OTP_REQUESTS_PER_IP: '500' };
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
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.cookie, id: v.data.user.id };
}
const say = (who, chat, text) => call(who.cookie, 'POST', `/api/chats/${chat}/messages`, { text, client_id: crypto.randomUUID() });
const setPerms = (owner, id, perms) => call(owner.cookie, 'PUT', `/api/admin/users/${id}/admin-perms`, { perms });

let owner; let helper; let u1; let u2; let u3; let chat; let ownerChat;
test('setting up', async () => {
  owner = await login('+998900000001', 'Главный');
  helper = await login('+998900000002', 'Помощник');
  u1 = await login('+998900000003', 'Люда');
  u2 = await login('+998900000004', 'Камол');
  u3 = await login('+998900000005', 'Жасур');
  chat = (await call(u1.cookie, 'POST', '/api/chats/direct', { user_id: u2.id })).data.chat.id;
  ownerChat = (await call(owner.cookie, 'POST', '/api/chats/direct', { user_id: u1.id })).data.chat.id;
  await say(u1, chat, 'обычная переписка');
  await say(owner, ownerChat, 'личное главного админа');
  const me = (await call(owner.cookie, 'GET', '/api/admin/me')).data;
  assert.equal(me.owner, true);
  assert.equal(me.perms.length, me.catalog.length);
});

test('only the main administrator appoints; a new administrator starts with nothing', async () => {
  assert.equal((await call(u1.cookie, 'POST', `/api/admin/users/${helper.id}/admin`, { is_admin: true })).status, 403);
  assert.equal((await call(owner.cookie, 'POST', `/api/admin/users/${helper.id}/admin`, { is_admin: true })).status, 200);
  const me = (await call(helper.cookie, 'GET', '/api/admin/me')).data;
  assert.equal(me.owner, false);
  assert.deepEqual(me.perms, []);
  for (const url of ['/overview', '/users', '/chats', '/audit', '/settings', '/system', '/backups', '/reports', '/call-quality', '/bridge', '/admins']) {
    assert.equal((await call(helper.cookie, 'GET', `/api/admin${url}`)).status, 403, url);
  }
});

test('each right opens exactly its part', async () => {
  const opens = {
    overview: ['/overview'], users_view: ['/users', `/users/${u1.id}`], chats_read: ['/chats', `/chats/${chat}`, `/chats/${chat}/messages`, `/chats/${chat}/stats`],
    journal: ['/audit'], access: ['/settings', '/invites'], bridge: ['/bridge'], server: ['/system', '/backups', '/integrity'], quality: ['/call-quality'], reports: ['/reports'], chats_export: ['/exports'],
  };
  const everything = Object.values(opens).flat();
  for (const [perm, urls] of Object.entries(opens)) {
    const set = await setPerms(owner, helper.id, [perm]);
    assert.equal(set.status, 200);
    const granted = set.data.perms;
    for (const url of everything) {
      const expect = urls.includes(url) || granted.some((g) => opens[g]?.includes(url));
      const got = (await call(helper.cookie, 'GET', `/api/admin${url}`)).status;
      assert.equal(got === 403, !expect, `with ${perm}: ${url} gave ${got}`);
    }
  }
});

test('what a right needs comes with it; nonsense is dropped', async () => {
  const r = await setPerms(owner, helper.id, ['chats_export', 'users_delete', 'fly_to_the_moon']);
  assert.deepEqual(r.data.perms.sort(), ['chats_export', 'chats_read', 'users_delete', 'users_view'].sort());
  assert.equal((await call(owner.cookie, 'PUT', `/api/admin/users/${helper.id}/admin-perms`, { perms: 'all' })).status, 400);
  assert.equal((await setPerms(owner, u3.id, ['journal'])).status, 400, 'not an administrator');
});

test('an action needs its own right, not only the sight of the page', async () => {
  await setPerms(owner, helper.id, ['users_view']);
  assert.equal((await call(helper.cookie, 'POST', `/api/admin/users/${u3.id}/ban`, { banned: true })).status, 403);
  assert.equal((await call(helper.cookie, 'POST', `/api/admin/users/${u3.id}/logout`, {})).status, 403);
  assert.equal((await call(helper.cookie, 'DELETE', `/api/admin/users/${u3.id}`, { confirm: 'DELETE' })).status, 403);
  await setPerms(owner, helper.id, ['users_manage']);
  assert.equal((await call(helper.cookie, 'POST', `/api/admin/users/${u3.id}/ban`, { banned: true })).status, 200);
  assert.equal((await call(helper.cookie, 'POST', `/api/admin/users/${u3.id}/ban`, { banned: false })).status, 200);
  assert.equal((await call(helper.cookie, 'DELETE', `/api/admin/users/${u3.id}`, { confirm: 'DELETE' })).status, 403);
});

test('some things stay with the main administrator whatever is ticked', async () => {
  const all = (await call(owner.cookie, 'GET', '/api/admin/me')).data.catalog.map((p) => p.id);
  await setPerms(owner, helper.id, all);
  assert.equal((await call(helper.cookie, 'GET', '/api/admin/credentials')).status, 403);
  assert.equal((await call(helper.cookie, 'POST', '/api/admin/backups/x/restore', {})).status, 403);
  assert.equal((await call(helper.cookie, 'DELETE', '/api/admin/backups/x')).status, 403);
  assert.equal((await call(helper.cookie, 'GET', '/api/admin/admins')).status, 403);
  assert.equal((await setPerms(helper, u1.id, ['journal'])).status, 403, 'cannot hand out rights');
  assert.equal((await setPerms(helper, helper.id, all)).status, 403, 'nor to itself');
  assert.equal((await call(helper.cookie, 'POST', `/api/admin/users/${u1.id}/admin`, { is_admin: true })).status, 403);
  assert.equal((await call(helper.cookie, 'GET', '/api/admin/some/future/route')).status, 403, 'what nobody listed is closed');
});

test('the main administrator and the other administrators are out of reach', async () => {
  for (const [method, url, body] of [['POST', `/api/admin/users/${owner.id}/ban`, { banned: true }], ['POST', `/api/admin/users/${owner.id}/logout`, {}], ['DELETE', `/api/admin/users/${owner.id}`, { confirm: 'DELETE' }], ['PUT', `/api/admin/users/${owner.id}/quota`, { quota_mb: 1 }]]) {
    assert.equal((await call(helper.cookie, method, url, body)).status, 403, url);
  }
  assert.equal((await call(owner.cookie, 'POST', `/api/admin/users/${owner.id}/admin`, { is_admin: false })).status, 400, 'the main administrator stays');
  assert.equal((await setPerms(owner, owner.id, [])).status, 400);
  assert.equal((await call(helper.cookie, 'GET', `/api/admin/users/${owner.id}`)).status, 403);
});

test('the personal chats of the main administrator are closed to the others', async () => {
  for (const url of [`/chats/${ownerChat}`, `/chats/${ownerChat}/messages`, `/chats/${ownerChat}/stats`, `/chats/${ownerChat}/export`, `/exports/now?scope=chat&scope_id=${ownerChat}`, `/exports/now?scope=user&scope_id=${owner.id}`]) {
    assert.equal((await call(helper.cookie, 'GET', `/api/admin${url}`)).status, 403, url);
  }
  assert.equal((await call(helper.cookie, 'POST', '/api/admin/exports', { scope: 'chat', scope_id: ownerChat })).status, 403);
  const list = (await call(helper.cookie, 'GET', '/api/admin/chats')).data.chats.map((c) => c.id);
  assert.ok(list.includes(chat));
  assert.ok(!list.includes(ownerChat));
  const found = (await call(helper.cookie, 'GET', `/api/admin/search?q=${encodeURIComponent('личное главного')}`)).data.results;
  assert.equal(found.length, 0);
  assert.equal((await call(owner.cookie, 'GET', `/api/admin/search?q=${encodeURIComponent('личное главного')}`)).data.results.length, 1);
  assert.equal((await call(owner.cookie, 'GET', `/api/admin/chats/${ownerChat}`)).status, 200, 'the main one sees everything');
  const msg = (await call(owner.cookie, 'GET', `/api/admin/chats/${ownerChat}/messages`)).data.messages[0];
  assert.equal((await call(helper.cookie, 'POST', `/api/admin/messages/${msg.id}/mark`, {})).status, 403);
  const events = (await call(helper.cookie, 'GET', '/api/admin/audit?limit=200')).data.events;
  assert.ok(events.every((e) => e.chat_id !== ownerChat));
});

test('the main administrator chooses whose conversations each administrator reads', async () => {
  const setRead = (mode, people, who = owner) => call(who.cookie, 'PUT', `/api/admin/users/${helper.id}/admin-read`, { mode, people });
  const chatIds = async () => (await call(helper.cookie, 'GET', '/api/admin/chats')).data.chats.map((c) => c.id);
  const found = async (word) => (await call(helper.cookie, 'GET', `/api/admin/search?q=${encodeURIComponent(word)}`)).data.results.length;
  const closed = async (id) => {
    for (const url of [`/chats/${id}`, `/chats/${id}/messages`, `/chats/${id}/stats`, `/chats/${id}/export`, `/exports/now?scope=chat&scope_id=${id}`]) assert.equal((await call(helper.cookie, 'GET', `/api/admin${url}`)).status, 403, url);
  };
  await setPerms(owner, helper.id, ['chats_read', 'chats_export', 'users_view', 'reports', 'bridge', 'journal']);
  const c13 = (await call(u1.cookie, 'POST', '/api/chats/direct', { user_id: u3.id })).data.chat.id; // Люда and Жасур
  const c23 = (await call(u2.cookie, 'POST', '/api/chats/direct', { user_id: u3.id })).data.chat.id; // Камол and Жасур
  await say(u1, c13, 'слово-люды-жасуру');
  await say(u2, c23, 'слово-камола-жасуру');
  await say(u1, chat, 'слово-люды-камолу');
  const grp = (await call(u2.cookie, 'POST', '/api/chats', { type: 'group', title: 'Группа Камола', member_ids: [u3.id] })).data.chat.id;
  await say(u2, grp, 'слово-в-группе');

  // nobody but the main administrator chooses, and the rule cannot be nonsense
  assert.equal((await setRead('all', [], helper)).status, 403);
  assert.equal((await setRead('nobody', [])).status, 400);
  assert.equal((await call(owner.cookie, 'PUT', `/api/admin/users/${u3.id}/admin-read`, { mode: 'all', people: [] })).status, 400, 'not an administrator');

  // everybody but Камол: his personal chats, his group, his files and what was reported in them
  const r = await setRead('except', [u2.id, owner.id, helper.id, 99999]);
  assert.deepEqual(r.data.read.people.map((p) => p.id), [u2.id], 'the main one, oneself and strangers are not listed');
  assert.equal((await call(helper.cookie, 'GET', '/api/admin/me')).data.read_limited, true);
  let list = await chatIds();
  assert.ok(list.includes(c13));
  for (const id of [chat, c23, grp]) { assert.ok(!list.includes(id), `chat ${id}`); await closed(id); }
  assert.equal(await found('слово-люды-жасуру'), 1);
  assert.equal(await found('слово-камола'), 0);
  assert.equal(await found('слово-люды-камолу'), 0, 'what is said to a closed person is closed too');
  assert.equal(await found('слово-в-группе'), 0);
  assert.equal((await call(helper.cookie, 'GET', `/api/admin/exports/now?scope=user&scope_id=${u2.id}&format=json`)).status, 403);
  assert.equal((await call(helper.cookie, 'GET', `/api/admin/bridge/${u2.id}/chats`)).status, 403);
  const openUser = await call(helper.cookie, 'GET', `/api/admin/exports/now?scope=user&scope_id=${u1.id}&format=json`);
  assert.deepEqual(openUser.data.chats.map((c) => c.chat_id).sort(), [c13].sort(), 'an export of an open person leaves out the closed chats');
  const profile = (await call(helper.cookie, 'GET', `/api/admin/users/${u1.id}`)).data;
  assert.ok(profile.chats.every((c) => c.id !== chat), 'the profile does not name them either');
  assert.ok((await call(helper.cookie, 'GET', '/api/admin/audit?limit=200')).data.events.every((e) => ![chat, c23, grp].includes(e.chat_id)));
  const hiddenMsg = (await call(owner.cookie, 'GET', `/api/admin/chats/${c23}/messages`)).data.messages[0];
  assert.equal((await call(helper.cookie, 'POST', `/api/admin/messages/${hiddenMsg.id}/mark`, {})).status, 403);
  u3 = await login('+998900000005', 'Жасур'); // the earlier test blocked and unblocked him, which ended his session
  assert.equal((await call(u3.cookie, 'POST', `/api/messages/${hiddenMsg.id}/report`, { reason: 'spam' })).status, 200);
  assert.ok((await call(helper.cookie, 'GET', '/api/admin/reports')).data.reports.every((x) => x.chat_id !== c23), 'a report does not open it');
  const report = (await call(owner.cookie, 'GET', '/api/admin/reports')).data.reports.find((x) => x.chat_id === c23);
  assert.equal((await call(helper.cookie, 'POST', `/api/admin/reports/${report.id}/resolve`, { action: 'delete' })).status, 403);
  assert.equal((await call(owner.cookie, 'POST', `/api/admin/reports/${report.id}/resolve`, { action: 'dismiss' })).status, 200);

  // only Люда: her chats, with whoever, and nothing else; the main administrator's stay closed
  await setRead('only', [u1.id]);
  list = await chatIds();
  assert.ok(list.includes(chat) && list.includes(c13));
  assert.ok(!list.includes(c23) && !list.includes(grp) && !list.includes(ownerChat));
  await closed(c23); await closed(ownerChat);
  assert.equal(await found('слово-люды-камолу'), 1);
  assert.equal(await found('слово-камола'), 0);
  assert.equal((await call(helper.cookie, 'GET', `/api/admin/exports/now?scope=user&scope_id=${u2.id}&format=json`)).status, 403);

  // nobody listed: nothing is open
  await setRead('only', []);
  assert.deepEqual(await chatIds(), []);

  // a link stops giving what its author may no longer read
  await setRead('all', []);
  const made = await call(helper.cookie, 'POST', '/api/admin/exports', { scope: 'chat', scope_id: c23, view: true, allow_download: true, format: 'json' });
  assert.equal(made.status, 201);
  const page = async () => (await fetch(`${BASE}/x/${made.data.link.token}`)).text();
  assert.ok((await page()).includes('слово-камола-жасуру'));
  await setRead('except', [u2.id]);
  assert.ok(!(await page()).includes('слово-камола-жасуру'));

  // somebody else's link is not shown or changed: it carries its secret address
  const mine = await call(owner.cookie, 'POST', '/api/admin/exports', { scope: 'chat', scope_id: ownerChat, allow_download: true, format: 'json' });
  assert.ok((await call(helper.cookie, 'GET', '/api/admin/exports')).data.links.every((l) => l.id !== mine.data.link.id));
  assert.equal((await call(helper.cookie, 'DELETE', `/api/admin/exports/${mine.data.link.id}`)).status, 403);

  // the main administrator sees the list, the journal keeps the choice, and the rule goes with the rights
  assert.deepEqual((await call(owner.cookie, 'GET', '/api/admin/admins')).data.admins.find((a) => a.id === helper.id).read.people.map((p) => p.id), [u2.id]);
  assert.deepEqual((await call(owner.cookie, 'GET', '/api/admin/audit?limit=50')).data.events.find((e) => e.action === 'admin.set_read').details, { mode: 'except', people: ['Камол'] });
  await call(owner.cookie, 'POST', `/api/admin/users/${helper.id}/admin`, { is_admin: false });
  await call(owner.cookie, 'POST', `/api/admin/users/${helper.id}/admin`, { is_admin: true });
  assert.equal((await call(owner.cookie, 'GET', '/api/admin/admins')).data.admins.find((a) => a.id === helper.id).read.mode, 'all');
  await setPerms(owner, helper.id, ['chats_read']);
});

test('the list of administrators; taking the rights away works at once', async () => {
  const list = (await call(owner.cookie, 'GET', '/api/admin/admins')).data.admins;
  assert.deepEqual(list.map((a) => [a.id, a.owner]), [[owner.id, true], [helper.id, false]]);
  assert.equal((await call(owner.cookie, 'GET', `/api/admin/users/${helper.id}`)).status, 200);
  assert.equal((await call(helper.cookie, 'GET', '/api/admin/chats')).status, 200);
  await setPerms(owner, helper.id, []);
  assert.equal((await call(helper.cookie, 'GET', '/api/admin/chats')).status, 403);
  await setPerms(owner, helper.id, ['journal']);
  const log = (await call(owner.cookie, 'GET', '/api/admin/audit?limit=20')).data.events.find((e) => e.action === 'admin.set_perms');
  assert.deepEqual(log.details.perms, ['journal']);
  assert.equal((await call(owner.cookie, 'POST', `/api/admin/users/${helper.id}/admin`, { is_admin: false })).status, 200);
  assert.equal((await call(helper.cookie, 'GET', '/api/admin/audit')).status, 403);
  await call(owner.cookie, 'POST', `/api/admin/users/${helper.id}/admin`, { is_admin: true });
  assert.deepEqual((await call(helper.cookie, 'GET', '/api/admin/me')).data.perms, [], 'appointed again: rights do not come back by themselves');
});
