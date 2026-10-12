// Folders, pinned chats, scheduled messages & reminders, polls, global search, data export.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5100 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-feat-')), OTP_REQUESTS_PER_IP: '500',
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
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => ({})) : await r.text(), headers: r.headers };
}
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.headers.get('set-cookie').split(';')[0], user: v.data.user };
}

test('folders, pins, schedule, reminders, polls, search, export', async () => {
  const a = await login('+998900000021', 'Ann');
  const b = await login('+998900000022', 'Bek');
  const c = await login('+998900000023', 'Cem');
  const dm = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  const dm2 = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: c.user.id })).data.chat;
  const group = (await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'Team', member_ids: [b.user.id, c.user.id] })).data.chat;

  // ---- pinned chats come first
  await call(a.cookie, 'POST', `/api/chats/${dm.id}/messages`, { text: 'first' });
  await call(a.cookie, 'POST', `/api/chats/${group.id}/messages`, { text: 'in the group' });
  const pin = await call(a.cookie, 'POST', `/api/chats/${dm.id}/pin-chat`, { pinned: true });
  assert.ok(pin.data.chat.pinned_at);
  const list = (await call(a.cookie, 'GET', '/api/chats')).data.chats;
  assert.equal(list[0].id, dm.id, 'pinned chat is first although it is older');
  await call(a.cookie, 'POST', `/api/chats/${dm.id}/pin-chat`, { pinned: false });

  // ---- folders (only own chats can be added)
  const f = await call(a.cookie, 'POST', '/api/folders', { name: 'Работа', emoji: '💼', chat_ids: [dm.id, group.id, 99999] });
  assert.equal(f.status, 201);
  assert.deepEqual(f.data.folders[0].chat_ids.sort(), [dm.id, group.id].sort());
  const fid = f.data.folders[0].id;
  assert.equal((await call(b.cookie, 'PATCH', `/api/folders/${fid}`, { name: 'hack' })).status, 404, 'folders are private');
  const up = await call(a.cookie, 'PATCH', `/api/folders/${fid}`, { chat_ids: [dm2.id] });
  assert.deepEqual(up.data.folders[0].chat_ids, [dm2.id]);
  assert.equal((await call(a.cookie, 'DELETE', `/api/folders/${fid}`)).data.folders.length, 0);

  // ---- per-chat sound
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${dm.id}/sound`, { sound: 'pop' })).data.chat.sound, 'pop');
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${dm.id}/sound`, { sound: 'evil' })).status, 400);

  // ---- scheduled message is delivered by the server clock
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${dm.id}/schedule`, { text: 'too early', send_at: Date.now() })).status, 400);
  const sched = await call(a.cookie, 'POST', `/api/chats/${dm.id}/schedule`, { text: 'from the future', send_at: Date.now() + 11_000 });
  assert.equal(sched.status, 201);
  assert.equal(sched.data.scheduled.length, 1);
  const rem = await call(a.cookie, 'POST', '/api/reminders', { text: 'drink water', send_at: Date.now() + 11_000 });
  assert.equal(rem.data.scheduled.length, 2);
  const gone = await call(a.cookie, 'POST', `/api/chats/${dm.id}/schedule`, { text: 'cancelled', send_at: Date.now() + 60_000 });
  const cancelId = gone.data.scheduled.find((s) => s.text === 'cancelled').id;
  assert.equal((await call(a.cookie, 'DELETE', `/api/scheduled/${cancelId}`)).data.scheduled.length, 2);
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    const ms = (await call(b.cookie, 'GET', `/api/chats/${dm.id}/messages`)).data.messages;
    if (ms.some((m) => m.text === 'from the future')) break;
  }
  const ms = (await call(b.cookie, 'GET', `/api/chats/${dm.id}/messages`)).data.messages;
  assert.ok(ms.some((m) => m.text === 'from the future' && m.sender_id === a.user.id), 'scheduled message arrived');
  assert.ok(!ms.some((m) => m.text === 'cancelled'));
  const mine = (await call(a.cookie, 'GET', '/api/chats')).data.chats.find((x) => x.peer?.name === 'Suhbat-dosh');
  assert.match(mine.last_message.text, /drink water/);
  assert.equal((await call(a.cookie, 'GET', '/api/scheduled')).data.scheduled.length, 0);

  // ---- polls
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${group.id}/polls`, { question: 'x', options: ['one'] })).status, 400);
  const poll = await call(a.cookie, 'POST', `/api/chats/${group.id}/polls`, { question: 'Где обедаем?', options: ['Плов', 'Лагман', 'Самса'] });
  assert.equal(poll.status, 201);
  const pm = poll.data.message;
  assert.equal(pm.kind, 'poll');
  assert.equal(pm.poll.options.length, 3);
  const pid = pm.poll.id;
  assert.equal((await call(b.cookie, 'POST', `/api/polls/${pid}/vote`, { options: [0] })).data.message.poll.options[0].votes.length, 1);
  assert.equal((await call(c.cookie, 'POST', `/api/polls/${pid}/vote`, { options: [0] })).data.message.poll.total_voters, 2);
  assert.equal((await call(c.cookie, 'POST', `/api/polls/${pid}/vote`, { options: [0, 1] })).status, 400, 'single choice');
  const re = await call(c.cookie, 'POST', `/api/polls/${pid}/vote`, { options: [2] });
  assert.deepEqual(re.data.message.poll.options.map((o) => o.votes.length), [1, 0, 1]);
  assert.equal((await call(b.cookie, 'POST', `/api/polls/${pid}/close`)).status, 403, 'only the author closes');
  assert.equal((await call(a.cookie, 'POST', `/api/polls/${pid}/close`)).data.message.poll.closed, true);
  assert.equal((await call(b.cookie, 'POST', `/api/polls/${pid}/vote`, { options: [1] })).status, 400);

  // ---- global search with filters
  await call(b.cookie, 'POST', `/api/chats/${group.id}/messages`, { text: 'смотри https://example.com/article' });
  const s1 = await call(a.cookie, 'GET', '/api/search/global?q=group');
  assert.ok(s1.data.results.some((r) => r.message.text === 'in the group' && r.chat_title === 'Team'));
  const s2 = await call(a.cookie, 'GET', `/api/search/global?from_user=${b.user.id}&type=link`);
  assert.equal(s2.data.results.length, 1);
  assert.equal(s2.data.results[0].sender_name, 'Bek');
  const s3 = await call(a.cookie, 'GET', '/api/search/global?q=in&chat_type=direct');
  assert.ok(s3.data.results.every((r) => r.chat_type === 'direct'));
  assert.equal((await call(c.cookie, 'GET', '/api/search/global?q=from%20the%20future')).data.results.length, 0, 'not in that chat');

  // ---- export
  const ex = await call(a.cookie, 'GET', '/api/export');
  assert.equal(ex.status, 200);
  const dump = JSON.parse(typeof ex.data === 'string' ? ex.data : JSON.stringify(ex.data));
  assert.equal(dump.user.name, 'Ann');
  assert.ok(dump.chats.some((c2) => c2.title === 'Team' && c2.messages.some((m) => m.text === 'in the group')));
});
