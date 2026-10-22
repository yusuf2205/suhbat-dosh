// Tasks from messages, focus mode and the unread digest.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6060 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-tk-')), REGISTRATION_OPEN: '1',
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

async function call(cookie, method, url, body) {
  const r = await fetch(BASE + url, {
    method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const signup = (username) => call('', 'POST', '/api/auth/register', { name: username, username, password: 'longenough1' });

test('a task is made from a message, assigned, completed; lists follow', async () => {
  const a = await signup('alice_tk');
  const b = await signup('boris_tk');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const src = (await call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: 'Отправь отчёт до пятницы' })).data.message;
  const due = Date.now() + 3 * 86400_000;
  const mk = await call(a.cookie, 'POST', `/api/chats/${chat.id}/tasks`, { title: 'Отправить отчёт', assignee_id: b.data.user.id, due_at: due, source_id: src.id });
  assert.equal(mk.status, 201);
  const task = mk.data.message.task;
  assert.equal(task.assignee_id, b.data.user.id);
  assert.equal(mk.data.message.kind, 'task');
  assert.equal(mk.data.message.reply_to.id, src.id);
  const mineB = await call(b.cookie, 'GET', '/api/tasks?scope=mine');
  assert.equal(mineB.data.tasks.length, 1);
  assert.equal((await call(b.cookie, 'GET', '/api/tasks/count')).data.open, 1);
  assert.equal((await call(a.cookie, 'GET', '/api/tasks?scope=given')).data.tasks.length, 1);
  const done = await call(b.cookie, 'POST', `/api/tasks/${task.id}/toggle`, {});
  assert.equal(done.data.message.task.done, true);
  assert.equal((await call(b.cookie, 'GET', '/api/tasks?scope=mine')).data.tasks.length, 0);
  assert.equal((await call(b.cookie, 'GET', '/api/tasks?scope=done')).data.tasks.length, 1);
  const past = await call(a.cookie, 'POST', `/api/chats/${chat.id}/tasks`, { title: 'x', due_at: Date.now() - 86400_000 });
  assert.equal(past.status, 400);
  const outsider = await signup('eve_tk');
  assert.equal((await call(outsider.cookie, 'POST', `/api/tasks/${task.id}/toggle`, {})).status, 404);
});

test('focus mode: stored, normalized, and the schedule logic is right', async () => {
  const { focusActive, focusAllows, normalizeFocus } = await import('../shared/focus.js');
  const a = await signup('alice_fc');
  const r = await call(a.cookie, 'PATCH', '/api/me', { focus: { on: true, until: Date.now() + 3600_000, allow: [5, 'x', 5], tz: 300 } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.user.focus.allow, [5]);
  assert.equal(focusActive(r.data.user.focus), true);
  assert.equal(focusActive({ on: true, until: Date.now() - 1 }), false);
  // overnight window 22:00-08:00 in UTC+5, every day
  const sched = { sched: { from: '22:00', to: '08:00', days: [0, 1, 2, 3, 4, 5, 6] }, tz: 300 };
  const at = (h, m = 0) => Date.UTC(2026, 5, 3, h - 5, m); // local hour h in UTC+5
  assert.equal(focusActive(sched, at(23)), true);
  assert.equal(focusActive(sched, at(7, 59)), true);
  assert.equal(focusActive(sched, at(12)), false);
  // weekdays only (Mon-Fri): Saturday 02:00 still belongs to Friday night
  const wk = { sched: { from: '22:00', to: '08:00', days: [1, 2, 3, 4, 5] }, tz: 0 };
  assert.equal(focusActive(wk, Date.UTC(2026, 5, 6, 2)), true); // 2026-06-06 is a Saturday
  assert.equal(focusActive(wk, Date.UTC(2026, 5, 7, 2)), false); // Sunday early morning: Saturday night is not selected
  assert.equal(focusAllows({ allow: [7] }, { senderId: 7 }), true);
  assert.equal(focusAllows({ allow: [7], calls: false }, { senderId: 7, call: true }), false);
  assert.equal(focusAllows({}, { senderId: 9, urgent: true }), true);
  assert.equal(focusAllows({ urgent: false }, { senderId: 9, urgent: true }), false);
  assert.equal(normalizeFocus({ sched: { from: '25:00', to: '08:00' } }).sched, null);
});

test('focus mode declines calls from strangers; chosen people get through', async () => {
  const a = await signup('alice_fcc');
  const b = await signup('boris_fcc');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  await call(b.cookie, 'PATCH', '/api/me', { focus: { on: true, until: 0, allow: [] } });
  const me = (await call(b.cookie, 'GET', '/api/me')).data.user;
  assert.equal(me.focus.on, true);
  assert.ok(chat.id);
});

test('digest finds mentions, questions, plans and counts media', async () => {
  const a = await signup('alice_dg');
  const b = await signup('boris_dg');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const say = (t) => call(a.cookie, 'POST', `/api/chats/${chat.id}/messages`, { text: t });
  await say('Привет! Как дела с проектом?');
  await say('@boris_dg встреча завтра в 15:30 в офисе');
  await say('Бюджет 5 000 000 сум, договорились?');
  await say('проект проект проект сдаём');
  await say('ок');
  const d = await call(b.cookie, 'GET', `/api/chats/${chat.id}/digest?ai=0`);
  assert.equal(d.status, 200);
  assert.equal(d.data.count, 5);
  assert.equal(d.data.mentions.length, 1);
  assert.ok(d.data.questions.length >= 2);
  assert.ok(d.data.plans.length >= 2);
  assert.ok(d.data.topics.includes('проект'));
  assert.equal(d.data.mode, 'rules');
  const all = await call(b.cookie, 'GET', '/api/digest');
  assert.equal(all.data.chats[0].chat_id, chat.id);
  assert.equal((await call(a.cookie, 'GET', `/api/chats/${chat.id}/digest`)).data.count, 0);
});
