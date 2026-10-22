// Import of a Telegram Desktop export: the parser and the server side (batches, files, resume without duplicates).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExport, tgText } from '../web/js/tgparse.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6160 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-imp-')), REGISTRATION_OPEN: '1',
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
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
const signup = (username) => call('', 'POST', '/api/auth/register', { name: username, username, password: 'longenough1' });

const EXPORT = {
  personal_information: { first_name: 'Алиса', last_name: '' },
  chats: {
    list: [{
      name: 'Друзья', type: 'private_group', id: 777, messages: [
        { id: 1, type: 'service', action: 'create_group', date: '2024-01-01T10:00:00', date_unixtime: '1704103200' },
        { id: 2, type: 'message', date: '2024-01-01T10:01:00', date_unixtime: '1704103260', from: 'Алиса', text: 'Привет всем' },
        { id: 3, type: 'message', date: '2024-01-01T10:02:00', date_unixtime: '1704103320', from: 'Борис', text: ['Смотри ', { type: 'bold', text: 'тут' }, ' ', { type: 'text_link', text: 'ссылка', href: 'https://example.com' }], reply_to_message_id: 2 },
        { id: 4, type: 'message', date: '2024-01-01T10:03:00', date_unixtime: '1704103380', from: 'Борис', photo: 'photos/a.png', text: 'Фото' },
        { id: 5, type: 'message', date: '2024-01-01T10:04:00', date_unixtime: '1704103440', from: 'Борис', file: '(File not included. Change data exporting settings to download.)', media_type: 'video_file', text: '' },
      ],
    }],
  },
};

test('parser flattens entities, drops service messages, finds who is who', () => {
  assert.equal(tgText(['a', { type: 'bold', text: 'b' }, { type: 'text_link', text: 'l', href: 'https://x.y' }]), 'abl (https://x.y)');
  const p = parseExport(EXPORT);
  assert.equal(p.me, 'Алиса');
  assert.equal(p.chats.length, 1);
  const c = p.chats[0];
  assert.equal(c.messages.length, 4);
  assert.equal(c.messages[1].text, 'Смотри тут ссылка (https://example.com)');
  assert.equal(c.messages[1].reply, 2);
  assert.equal(c.messages[2].media.kind, 'image');
  assert.equal(c.messages[3].missing, true);
  assert.deepEqual(c.authors.map((a) => a.name), ['Борис', 'Алиса']);
  // a single exported chat has the messages at the top level
  assert.equal(parseExport({ name: 'X', id: 1, messages: [{ id: 1, type: 'message', date_unixtime: '1704103260', from: 'A', text: 'hi' }] }).chats.length, 1);
});

test('import: texts with replies and original times, a photo, resume without duplicates, only the owner sees it', async () => {
  const a = await signup('alice_imp');
  const eve = await signup('eve_imp');
  const start = await call(a.cookie, 'POST', '/api/import/telegram/start', { title: 'Друзья', me_name: 'Алиса', key: '777' });
  assert.equal(start.status, 201);
  const id = start.data.chat_id;
  const b1 = await call(a.cookie, 'POST', `/api/import/telegram/${id}/batch`, { messages: [
    { key: '777:2', ts: 1704103260000, author: 'Алиса', text: 'Привет всем' },
    { key: '777:3', ts: 1704103320000, author: 'Борис', text: 'Смотри тут' },
  ] });
  assert.equal(b1.status, 200);
  const [m2, m3] = b1.data.ids;
  assert.ok(m2 && m3 && m3 > m2);
  // a reply to an earlier imported message
  const b2 = await call(a.cookie, 'POST', `/api/import/telegram/${id}/batch`, { messages: [{ key: '777:6', ts: 1704103500000, author: 'Борис', text: 'ответ', reply_to: m2 }, { key: '777:2', ts: 1, author: 'x', text: 'dup' }] });
  assert.equal(b2.data.ids[1], m2, 'the same key returns the same id');
  // a photo
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const f = await call(a.cookie, 'POST', `/api/import/telegram/${id}/file?key=777:4&name=a.png&ts=1704103380000&author=${encodeURIComponent('Борис')}&caption=${encodeURIComponent('Фото')}`, null, png);
  assert.equal(f.status, 201);
  const again = await call(a.cookie, 'POST', `/api/import/telegram/${id}/file?key=777:4&name=a.png&ts=1&author=x`, null, png);
  assert.equal(again.data.duplicate, true);
  // not visible in the list before the end
  assert.equal((await call(a.cookie, 'GET', '/api/chats')).data.chats.some((c) => c.id === id), false);
  const fin = await call(a.cookie, 'POST', `/api/import/telegram/${id}/finish`);
  assert.equal(fin.status, 200);
  assert.equal(fin.data.chat.imported, 'telegram');
  assert.equal(fin.data.chat.import_me, 'Алиса');
  assert.equal(fin.data.chat.unread, 0);
  const msgs = (await call(a.cookie, 'GET', `/api/chats/${id}/messages`)).data.messages;
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].import_author, 'Алиса');
  assert.equal(msgs[0].created_at, 1704103260000);
  assert.equal(msgs.find((m) => m.kind === 'image').text, 'Фото');
  assert.equal(msgs.find((m) => m.text === 'ответ').reply_to.id, m2);
  // starting the same import again continues it
  const again2 = await call(a.cookie, 'POST', '/api/import/telegram/start', { title: 'Друзья', me_name: 'Алиса', key: '777' });
  assert.equal(again2.data.chat_id, id);
  assert.equal(again2.data.existing, 4);
  // somebody else cannot write into it or read it
  assert.equal((await call(eve.cookie, 'POST', `/api/import/telegram/${id}/batch`, { messages: [{ key: 'z', ts: 1, author: 'e', text: 'x' }] })).status, 404);
  assert.equal((await call(eve.cookie, 'GET', `/api/chats/${id}/messages`)).status, 404);
  // bad input
  assert.equal((await call(a.cookie, 'POST', `/api/import/telegram/${id}/batch`, { messages: [] })).status, 400);
});
