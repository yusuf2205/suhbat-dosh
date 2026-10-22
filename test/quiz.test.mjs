// Presence (busy / away) and the auto-reply.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5960 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-qz-')), REGISTRATION_OPEN: '1',
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

test('quiz hides the right answer until you answer; one try; slot polls allow several picks', async () => {
  const a = await signup('alice_qz');
  const b = await signup('boris_qz');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const bad = await call(a.cookie, 'POST', `/api/chats/${chat.id}/polls`, { question: 'Q?', options: ['a', 'b'], kind: 'quiz' });
  assert.equal(bad.status, 400);
  const qz = await call(a.cookie, 'POST', `/api/chats/${chat.id}/polls`, { question: '2+2?', options: ['3', '4', '5'], kind: 'quiz', correct: 1, explanation: 'Арифметика' });
  assert.equal(qz.status, 201);
  const poll = qz.data.message.poll;
  assert.equal(poll.kind, 'quiz');
  assert.equal(poll.correct, undefined);
  const before = await call(b.cookie, 'GET', `/api/polls/${poll.id}/result`);
  assert.equal(before.data.correct, null);
  const v1 = await call(b.cookie, 'POST', `/api/polls/${poll.id}/vote`, { options: [0] });
  assert.equal(v1.status, 200);
  const again = await call(b.cookie, 'POST', `/api/polls/${poll.id}/vote`, { options: [1] });
  assert.equal(again.status, 400);
  const after = await call(b.cookie, 'GET', `/api/polls/${poll.id}/result`);
  assert.equal(after.data.correct, 1);
  assert.equal(after.data.explanation, 'Арифметика');
  const sl = await call(a.cookie, 'POST', `/api/chats/${chat.id}/polls`, { question: 'Когда?', options: ['Пн 18:00', 'Вт 19:00'], kind: 'slots' });
  assert.equal(sl.data.message.poll.multiple, true);
  const two = await call(b.cookie, 'POST', `/api/polls/${sl.data.message.poll.id}/vote`, { options: [0, 1] });
  assert.equal(two.status, 200);
});

test('events: create, RSVP, reminders, cancel, ics, calendar', async () => {
  const a = await signup('alice_ev');
  const b = await signup('boris_ev');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const start = Date.now() + 2 * 3600_000;
  const bad = await call(a.cookie, 'POST', `/api/chats/${chat.id}/events`, { title: 'X', start_at: Date.now() - 86400_000 });
  assert.equal(bad.status, 400);
  const mk = await call(a.cookie, 'POST', `/api/chats/${chat.id}/events`, { title: 'Планёрка', start_at: start, duration_min: 45, location: 'Офис', meeting: true });
  assert.equal(mk.status, 201);
  const ev = mk.data.message.event;
  assert.equal(ev.title, 'Планёрка');
  assert.deepEqual(ev.rsvp.yes, [a.data.user.id]);
  const r = await call(b.cookie, 'POST', `/api/events/${ev.id}/rsvp`, { status: 'maybe' });
  assert.deepEqual(r.data.message.event.rsvp.maybe, [b.data.user.id]);
  assert.equal((await call(b.cookie, 'POST', `/api/events/${ev.id}/rsvp`, { status: 'dunno' })).status, 400);
  const up = await call(b.cookie, 'GET', '/api/events/upcoming');
  assert.equal(up.data.events.length, 1);
  assert.equal(up.data.events[0].mine, 'maybe');
  const ics = await fetch(`${BASE}/api/events/${ev.id}/ics`, { headers: { cookie: b.cookie } });
  assert.equal(ics.status, 200);
  const text = await ics.text();
  assert.match(text, /BEGIN:VEVENT/);
  assert.match(text, /SUMMARY:Планёрка/);
  assert.equal((await call(b.cookie, 'POST', `/api/events/${ev.id}/cancel`)).status, 403); // only the author
  assert.equal((await call(a.cookie, 'POST', `/api/events/${ev.id}/cancel`)).status, 200);
  const up2 = await call(b.cookie, 'GET', '/api/events/upcoming');
  assert.equal(up2.data.events.length, 0);
  assert.equal((await call(b.cookie, 'POST', `/api/events/${ev.id}/rsvp`, { status: 'yes' })).status, 400);
});
