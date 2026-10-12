// Auto-delete timers, reports, spam guard, quotas, stories.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5700 + Math.floor(Math.random() * 150);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-safe-')), OTP_REQUESTS_PER_IP: '300', SUPERADMIN_PHONES: '+998900000071',
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

async function call(cookie, method, url, body, raw, headers = {}) {
  const r = await fetch(BASE + url, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, data: ct.includes('json') ? await r.json().catch(() => ({})) : Buffer.from(await r.arrayBuffer()), headers: r.headers };
}
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  const v = await call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
  return { cookie: v.headers.get('set-cookie').split(';')[0], user: v.data.user };
}
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64');

test('reports, spam guard, quota, auto-delete timer', async () => {
  const adm = await login('+998900000071', 'Boss');
  const a = await login('+998900000072', 'Ann');
  const b = await login('+998900000073', 'Bek');
  const dm = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;

  // report -> admin list -> delete
  const m = (await call(b.cookie, 'POST', `/api/chats/${dm.id}/messages`, { text: 'buy my crypto now' })).data.message;
  assert.equal((await call(a.cookie, 'POST', `/api/messages/${m.id}/report`, { reason: 'spam' })).status, 200);
  const rep = (await call(adm.cookie, 'GET', '/api/admin/reports')).data.reports;
  assert.equal(rep.length, 1);
  assert.equal(rep[0].snapshot, 'buy my crypto now');
  assert.equal((await call(a.cookie, 'GET', '/api/admin/reports')).status, 403);
  await call(adm.cookie, 'POST', `/api/admin/reports/${rep[0].id}/resolve`, { action: 'delete' });
  const left = (await call(a.cookie, 'GET', `/api/chats/${dm.id}/messages`)).data.messages;
  assert.ok(!left.some((x) => x.id === m.id), 'reported message removed');
  assert.equal((await call(adm.cookie, 'GET', '/api/admin/reports')).data.reports.length, 0);

  // quota: 0 MB default = unlimited; a 1 MB user quota blocks a bigger upload
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${dm.id}/files?name=a.png`, null, PNG, { 'content-type': 'application/octet-stream' })).status, 201);
  await call(adm.cookie, 'PUT', `/api/admin/users/${a.user.id}/quota`, { mb: 0 });
  const big = Buffer.concat([PNG, Buffer.alloc(300)]);
  await call(adm.cookie, 'PUT', '/api/admin/settings', { quota_default_mb: 1 });
  await call(adm.cookie, 'PUT', `/api/admin/users/${a.user.id}/quota`, { mb: null });
  const usage = (await call(a.cookie, 'GET', '/api/me/usage')).data;
  assert.equal(usage.quota, 1024 * 1024);
  const fill = Buffer.concat([PNG, Buffer.alloc(1024 * 1024)]);
  const over = await call(a.cookie, 'POST', `/api/chats/${dm.id}/files?name=big.png`, null, fill, { 'content-type': 'application/octet-stream' });
  assert.equal(over.status, 413);
  assert.equal(over.data.error, 'quota_exceeded');
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${dm.id}/files?name=small.png`, null, big, { 'content-type': 'application/octet-stream' })).status, 201);

  // spam guard: one text into 5 chats -> blocked
  const spammer = await login('+998900000074', 'Spammer');
  const victims = [];
  for (let i = 0; i < 5; i++) victims.push(await login(`+99890000008${i}`, `V${i}`));
  let lastStatus = 0;
  for (const v of victims) {
    const c = (await call(spammer.cookie, 'POST', '/api/chats/direct', { user_id: v.user.id })).data.chat;
    lastStatus = (await call(spammer.cookie, 'POST', `/api/chats/${c.id}/messages`, { text: 'Win a free phone: http://scam.example/win' })).status;
  }
  assert.equal(lastStatus, 201);
  assert.equal((await call(spammer.cookie, 'GET', '/api/me')).status, 401, 'sessions ended');
  const svc = (await call(adm.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.peer?.name === 'Suhbat-dosh');
  assert.match(svc.last_message.text, /Автоблокировка/);

  // auto-delete timer is stored and shown to both sides
  const t = await call(a.cookie, 'POST', `/api/chats/${dm.id}/ttl`, { seconds: 86400 });
  assert.equal(t.data.chat.ttl, 86400);
  assert.equal((await call(b.cookie, 'GET', '/api/chats')).data.chats.find((c) => c.id === dm.id).ttl, 86400);
  assert.equal((await call(a.cookie, 'POST', `/api/chats/${dm.id}/ttl`, { seconds: 5 })).status, 400);
});

test('stories: contacts see them, archive keeps them, viewers are listed', async () => {
  const a = await login('+998900000091', 'Ann');
  const b = await login('+998900000092', 'Bek');
  const c = await login('+998900000093', 'Cem');
  await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.user.id });
  const s = await call(a.cookie, 'POST', '/api/stories', null, PNG, { 'content-type': 'application/octet-stream' });
  assert.equal(s.status, 201);
  const text = await call(a.cookie, 'POST', '/api/stories', { text: 'Salom!', bg: '#2563eb' });
  assert.equal(text.status, 201);
  const feedB = (await call(b.cookie, 'GET', '/api/stories')).data.feed;
  const mine = feedB.find((f) => f.user.id === a.user.id);
  assert.equal(mine.stories.length, 2);
  assert.equal(mine.all_seen, false);
  assert.equal((await call(b.cookie, 'GET', s.data.story.media)).status, 200);
  assert.equal((await call(c.cookie, 'GET', s.data.story.media)).status, 404, 'strangers cannot open it');
  assert.equal((await call(c.cookie, 'GET', '/api/stories')).data.feed.some((f) => f.user.id === a.user.id), false);
  await call(b.cookie, 'POST', `/api/stories/${s.data.story.id}/view`);
  const viewers = (await call(a.cookie, 'GET', `/api/stories/${s.data.story.id}/viewers`)).data.viewers;
  assert.equal(viewers.length, 1);
  assert.equal(viewers[0].user.name, 'Bek');
  assert.equal((await call(b.cookie, 'GET', `/api/stories/${s.data.story.id}/viewers`)).status, 404, 'only the author sees viewers');
  assert.equal((await call(a.cookie, 'GET', '/api/stories/archive')).data.stories.length, 2);
  assert.equal((await call(b.cookie, 'DELETE', `/api/stories/${s.data.story.id}`)).status, 404);
  assert.equal((await call(a.cookie, 'DELETE', `/api/stories/${s.data.story.id}`)).status, 200);
});
