// End-to-end scenarios against a real server process. Run: npm test
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-test-'));
const dlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-dl-'));
fs.writeFileSync(path.join(dlDir, 'Suhbat-dosh-Setup-1.0-windows-x64.exe'), 'MZ-fake-installer');
fs.writeFileSync(path.join(dlDir, 'Suhbat-dosh-android-1.2.3.apk'), 'PK-fake-apk');
fs.writeFileSync(path.join(dlDir, 'latest.yml'), 'version: 1.2.3');
fs.writeFileSync(path.join(dlDir, 'secret.txt'), 'x');
fs.writeFileSync(path.join(dlDir, 'Suhbat-dosh-1.0-linux-x64.tar.gz'), 'fake');
fs.writeFileSync(path.join(dlDir, 'notes.txt'), 'not an installer');
let server;
// ---- minimal Telegram Bot API stub (getMe / getUpdates / sendMessage / ...)
import http from 'node:http';
const stub = { sent: [], mail: [], queue: [], nextId: 1, port: 0, push(u) { this.queue.push({ update_id: this.nextId++, ...u }); } };
function startStub() {
  const s = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const method = req.url.split('/').pop();
      const data = body ? JSON.parse(body) : {};
      const ok = (result) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, result })); };
      if (method === 'emails') { stub.mail.push({ auth: req.headers.authorization, ...data }); return ok({ id: 'mail_1' }); }
      if (method === 'getMe') return ok({ id: 1, username: 'suhbat_test_bot' });
      if (method === 'getUpdates') {
        const t0 = Date.now();
        while (!stub.queue.length && Date.now() - t0 < 500) await new Promise((r) => setTimeout(r, 25));
        const out = stub.queue.splice(0);
        return ok(out);
      }
      if (method === 'sendMessage') { stub.sent.push({ ...data, chat_id: String(data.chat_id) }); return ok({ message_id: 1 }); }
      return ok(true);
    });
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => { stub.port = s.address().port; stub.server = s; r(); }));
}


class Client {
  constructor(name, phone) { this.name = name; this.phone = phone; this.cookie = ''; this.events = []; }
  async call(method, url, body, { raw, headers } = {}) {
    const res = await fetch(BASE + url, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body && !raw ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: raw ?? (body ? JSON.stringify(body) : undefined),
    });
    const sc = res.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  async login() {
    const r = await this.call('POST', '/api/auth/request', { phone: this.phone });
    assert.equal(r.status, 200);
    let v = await this.call('POST', '/api/auth/verify', { phone: this.phone, code: r.data.dev_code });
    if (v.data.needs_name) v = await this.call('POST', '/api/auth/verify', { phone: this.phone, code: r.data.dev_code, name: this.name });
    assert.equal(v.status, 200);
    this.user = v.data.user;
    return this;
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie: this.cookie } });
      this.ws.onmessage = (e) => {
        const ev = JSON.parse(e.data);
        this.events.push(ev);
        if (ev.type === 'ready') resolve();
      };
      this.ws.onerror = () => reject(new Error('ws failed'));
    });
  }
  async waitFor(type, pred = () => true, ms = 3000) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      const e = this.events.find((x) => x.type === type && pred(x));
      if (e) return e;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for ${type}`);
  }
}

before(async () => {
  await startStub();
  server = spawn(process.execPath, ['server/src/index.js'], {
    cwd: root,
    env: { ...process.env, PORT: String(PORT), DATA_DIR: dataDir, OTP_MODE: 'dev', NODE_ENV: 'test', LOG_LEVEL: 'error', SUPERADMIN_PHONES: '+998901110099', OTP_REQUESTS_PER_IP: '500', RESEND_API_KEY: 're_test_key', RESEND_API_BASE: 'http://127.0.0.1:' + stub.port, EMAIL_FROM: 'Test <no-reply@test.local>', TELEGRAM_BOT_TOKEN: '123:TEST', DOWNLOADS_DIR: dlDir, TELEGRAM_API_BASE: 'http://127.0.0.1:' + stub.port },
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  for (let i = 0; i < 50; i++) {
    try { if ((await fetch(BASE + '/healthz')).ok) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill();
  stub.server?.close();
  setTimeout(() => fs.rmSync(dataDir, { recursive: true, force: true }), 300);
});

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000001e221bc330000000049454e44ae426082', 'hex');

test('production refuses dev OTP mode', () => {
  const r = spawnSync(process.execPath, ['server/src/index.js'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', OTP_MODE: 'dev', APP_SECRET: 'x'.repeat(40), DATA_DIR: dataDir, PORT: '0' },
    encoding: 'utf8',
  });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /OTP_MODE=dev is not allowed/);
});

test('full messenger flow', async (t) => {
  const alice = await new Client('Alice', '+998901110001').login();
  const bob = await new Client('Bob', '+998901110002').login();
  const carol = await new Client('Carol', '+998901110003').login();

  await t.test('unauthenticated access is rejected', async () => {
    const r = await new Client('x', '+1').call('GET', '/api/chats');
    assert.equal(r.status, 401);
  });

  await t.test('cross-origin writes are rejected', async () => {
    const r = await alice.call('PATCH', '/api/me', { name: 'Evil' }, { headers: { origin: 'http://evil.example' } });
    assert.equal(r.status, 403);
  });

  await t.test('wrong OTP is rejected and attempts are limited', async () => {
    const c = new Client('Z', '+998901119999');
    await c.call('POST', '/api/auth/request', { phone: c.phone });
    for (let i = 0; i < 5; i++) {
      const r = await c.call('POST', '/api/auth/verify', { phone: c.phone, code: '000000', name: 'Z' });
      assert.ok([400].includes(r.status) || r.status === 200);
      if (r.status === 200) return; // 1-in-a-million collision, nothing to assert
    }
    const r = await c.call('POST', '/api/auth/verify', { phone: c.phone, code: '000000', name: 'Z' });
    assert.ok([400, 429].includes(r.status));
  });

  await t.test('profile + username search', async () => {
    const r = await bob.call('PATCH', '/api/me', { username: 'bob_builder', bio: 'hi' });
    assert.equal(r.status, 200);
    const s = await alice.call('GET', '/api/users/search?q=@bob_b');
    assert.equal(s.data.users[0].id, bob.user.id);
    assert.equal((await alice.call('PATCH', '/api/me', { username: 'bob_builder' })).status, 409);
  });

  await alice.connect();
  await bob.connect();
  let chat;

  await t.test('direct chat + realtime delivery', async () => {
    const r = await alice.call('POST', '/api/chats/direct', { user_id: bob.user.id });
    chat = r.data.chat;
    const m = await alice.call('POST', `/api/chats/${chat.id}/messages`, { text: 'Привет, Боб!', client_id: 'client-0001' });
    assert.equal(m.status, 201);
    const ev = await bob.waitFor('message.new', (e) => e.message.text === 'Привет, Боб!');
    assert.equal(ev.message.sender_id, alice.user.id);
    await alice.waitFor('delivered', (e) => e.message_id === ev.message.id);
  });

  await t.test('retry with same client_id does not duplicate', async () => {
    const m = await alice.call('POST', `/api/chats/${chat.id}/messages`, { text: 'Привет, Боб!', client_id: 'client-0001' });
    assert.equal(m.status, 200);
    assert.equal(m.data.duplicate, true);
    const h = await alice.call('GET', `/api/chats/${chat.id}/messages`);
    assert.equal(h.data.messages.length, 1);
  });

  await t.test('read receipts + unread counter', async () => {
    const list = await bob.call('GET', '/api/chats');
    assert.equal(list.data.chats[0].unread, 1);
    const last = list.data.chats[0].last_message.id;
    await bob.call('POST', `/api/chats/${chat.id}/read`, { message_id: last });
    await alice.waitFor('read', (e) => e.message_id === last);
    const again = await bob.call('GET', '/api/chats');
    assert.equal(again.data.chats[0].unread, 0);
  });

  await t.test('typing indicator', async () => {
    alice.ws.send(JSON.stringify({ type: 'typing', chat_id: chat.id }));
    await bob.waitFor('typing', (e) => e.user_id === alice.user.id);
    // what the person is doing travels along: a voice message, a video, a file; anything else counts as writing
    alice.ws.send(JSON.stringify({ type: 'typing', chat_id: chat.id, action: 'voice' }));
    assert.equal((await bob.waitFor('typing', (e) => e.user_id === alice.user.id && e.action === 'voice')).action, 'voice');
    alice.ws.send(JSON.stringify({ type: 'typing', chat_id: chat.id, action: 'stop' }));
    await bob.waitFor('typing', (e) => e.user_id === alice.user.id && e.action === 'stop');
    alice.ws.send(JSON.stringify({ type: 'typing', chat_id: chat.id, action: '<script>' }));
    await bob.waitFor('typing', (e) => e.user_id === alice.user.id && e.action === 'typing');
  });

  await t.test('edit, react, reply, pin, delete', async () => {
    const m = (await bob.call('POST', `/api/chats/${chat.id}/messages`, { text: 'one' })).data.message;
    assert.equal((await alice.call('PATCH', `/api/messages/${m.id}`, { text: 'hack' })).status, 403);
    const ed = await bob.call('PATCH', `/api/messages/${m.id}`, { text: 'one (edited)' });
    assert.ok(ed.data.message.edited_at);
    const re = await alice.call('POST', `/api/messages/${m.id}/reactions`, { emoji: '👍' });
    assert.deepEqual(re.data.message.reactions['👍'], [alice.user.id]);
    const rp = await alice.call('POST', `/api/chats/${chat.id}/messages`, { text: 'reply', reply_to: m.id });
    assert.equal(rp.data.message.reply_to.id, m.id);
    const pin = await alice.call('POST', `/api/chats/${chat.id}/pin`, { message_id: m.id });
    assert.equal(pin.data.chat.pinned.id, m.id);
    assert.equal((await alice.call('DELETE', `/api/messages/${m.id}`)).status, 403);
    assert.equal((await bob.call('DELETE', `/api/messages/${m.id}`)).status, 200);
    await alice.waitFor('message.delete', (e) => e.message_id === m.id);
  });

  await t.test('history pagination', async () => {
    for (let i = 0; i < 12; i++) await bob.call('POST', `/api/chats/${chat.id}/messages`, { text: `bulk ${i}` });
    const p1 = await alice.call('GET', `/api/chats/${chat.id}/messages?limit=5`);
    assert.equal(p1.data.messages.length, 5);
    assert.equal(p1.data.has_more, true);
    const p2 = await alice.call('GET', `/api/chats/${chat.id}/messages?limit=5&before=${p1.data.messages[0].id}`);
    assert.ok(p2.data.messages.at(-1).id < p1.data.messages[0].id);
  });

  await t.test('stranger cannot read, search or write into a foreign chat', async () => {
    assert.equal((await carol.call('GET', `/api/chats/${chat.id}/messages`)).status, 404);
    assert.equal((await carol.call('POST', `/api/chats/${chat.id}/messages`, { text: 'x' })).status, 404);
    assert.equal((await carol.call('GET', `/api/chats/${chat.id}`)).status, 404);
    const s = await carol.call('GET', '/api/search/messages?q=bulk');
    assert.equal(s.data.messages.length, 0);
    const own = await alice.call('GET', '/api/search/messages?q=bulk');
    assert.ok(own.data.messages.length >= 12);
  });

  await t.test('file upload, authorized download, type spoofing', async () => {
    const up = await alice.call('POST', `/api/chats/${chat.id}/files?name=pic.png`, null, { raw: PNG, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(up.status, 201);
    assert.equal(up.data.message.kind, 'image');
    const url = up.data.message.file.url;
    const ok = await bob.call('GET', url);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-type'), 'image/png');
    assert.equal((await carol.call('GET', url)).status, 404);
    assert.equal((await new Client('x', '+1').call('GET', url)).status, 401);

    const exe = await alice.call('POST', `/api/chats/${chat.id}/files?name=run.exe`, null, { raw: Buffer.from('MZ....'), headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(exe.status, 415);

    const spoof = await alice.call('POST', `/api/chats/${chat.id}/files?name=cat.png`, null, { raw: Buffer.from('<html><script>alert(1)</script></html>'), headers: { 'content-type': 'image/png' } });
    assert.equal(spoof.status, 201);
    assert.equal(spoof.data.message.kind, 'file');
    const dl = await bob.call('GET', spoof.data.message.file.url);
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.match(dl.headers.get('content-disposition'), /^attachment/);
  });

  await t.test('voice message', async () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(64)]);
    const r = await alice.call('POST', `/api/chats/${chat.id}/files?name=voice.webm&voice=1&duration=4`, null, { raw: webm, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.data.message.kind, 'voice');
    assert.equal(r.data.message.duration, 4);
  });

  await t.test('upload size cap', async () => {
    const big = Buffer.alloc(51 * 1024 * 1024, 1);
    const r = await alice.call('POST', `/api/chats/${chat.id}/files?name=big.bin`, null, { raw: big, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 413);
  });

  await t.test('blocking stops messages', async () => {
    assert.equal((await bob.call('POST', `/api/blocks/${alice.user.id}`)).status, 200);
    const r = await alice.call('POST', `/api/chats/${chat.id}/messages`, { text: 'still there?' });
    assert.equal(r.status, 403);
    assert.equal(r.data.error, 'blocked');
    const s = await alice.call('GET', '/api/users/search?q=bob_builder');
    assert.equal(s.data.users.length, 0);
    await bob.call('DELETE', `/api/blocks/${alice.user.id}`);
    assert.equal((await alice.call('POST', `/api/chats/${chat.id}/messages`, { text: 'back' })).status, 201);
  });

  await t.test('privacy: last seen hidden from non-contacts', async () => {
    await carol.call('PATCH', '/api/me', { privacy: { last_seen: 'contacts', photo: 'nobody' } });
    const v = await alice.call('GET', `/api/users/${carol.user.id}`);
    assert.equal(v.data.user.last_seen, null);
    assert.equal(v.data.user.online, false);
  });

  await t.test('group: invite link, roles, kick/ban', async () => {
    const g = (await alice.call('POST', '/api/chats', { type: 'group', title: 'Team', member_ids: [bob.user.id] })).data.chat;
    assert.ok(g.invite_code);
    assert.equal((await bob.call('GET', `/api/chats/${g.id}`)).data.chat.invite_code, null);
    const join = await carol.call('POST', `/api/invite/${g.invite_code}/join`);
    assert.equal(join.status, 200);
    assert.equal((await carol.call('PATCH', `/api/chats/${g.id}`, { title: 'Hacked' })).status, 403);
    assert.equal((await alice.call('PATCH', `/api/chats/${g.id}/members/${bob.user.id}`, { role: 'admin' })).status, 200);
    assert.equal((await bob.call('DELETE', `/api/chats/${g.id}/members/${carol.user.id}?ban=1`)).status, 200);
    assert.equal((await carol.call('GET', `/api/chats/${g.id}/messages`)).status, 404);
    assert.equal((await carol.call('POST', `/api/invite/${g.invite_code}/join`)).status, 403);
    assert.equal((await bob.call('DELETE', `/api/chats/${g.id}/members/${alice.user.id}`)).status, 403);
  });

  await t.test('channel: only admins post', async () => {
    const c = (await alice.call('POST', '/api/chats', { type: 'channel', title: 'News', member_ids: [bob.user.id] })).data.chat;
    assert.equal((await bob.call('POST', `/api/chats/${c.id}/messages`, { text: 'hi' })).data.error, 'channel_readonly');
    assert.equal((await alice.call('POST', `/api/chats/${c.id}/messages`, { text: 'news!' })).status, 201);
  });

  await t.test('session management', async () => {
    const second = new Client('Alice', alice.phone);
    await second.login();
    const list = await alice.call('GET', '/api/sessions');
    assert.ok(list.data.sessions.length >= 2);
    const other = list.data.sessions.find((s) => !s.current);
    assert.equal((await alice.call('DELETE', `/api/sessions/${other.id}`)).status, 200);
    assert.equal((await second.call('GET', '/api/chats')).status, 401);
  });

  await t.test('state survives reload (history from server)', async () => {
    const fresh = new Client('Alice', alice.phone);
    await fresh.login();
    const chats = await fresh.call('GET', '/api/chats');
    assert.ok(chats.data.chats.some((c) => c.id === chat.id));
  });
});

test('super admin: sees who wrote, edited and deleted what', async (t) => {
  const admin = await new Client('Root', '+998901110099').login();
  const u1 = await new Client('Anvar', '+998901110011').login();
  const u2 = await new Client('Bekzod', '+998901110012').login();
  assert.equal(admin.user.is_admin, true);
  assert.equal(u1.user.is_admin, false);

  const chat = (await u1.call('POST', '/api/chats/direct', { user_id: u2.user.id })).data.chat;
  const sent = (await u1.call('POST', `/api/chats/${chat.id}/messages`, { text: 'секретный план' })).data.message;
  await u1.call('PATCH', `/api/messages/${sent.id}`, { text: 'план изменён' });
  const second = (await u2.call('POST', `/api/chats/${chat.id}/messages`, { text: 'это удалю' })).data.message;
  await u2.call('DELETE', `/api/messages/${second.id}`);
  await u1.call('PATCH', '/api/me', { name: 'Anvar Karimov', bio: 'новый статус' });

  await t.test('non-admins are refused', async () => {
    assert.equal((await u1.call('GET', '/api/admin/overview')).status, 403);
    assert.equal((await u1.call('GET', '/api/admin/audit')).status, 403);
    assert.equal((await u1.call('GET', `/api/admin/chats/${chat.id}/messages`)).status, 403);
    assert.equal((await new Client('x', '+1').call('GET', '/api/admin/overview')).status, 401);
    assert.equal((await u1.call('GET', '/api/admin/stats?tz=300')).status, 403);
  });

  await t.test('dashboard stats: daily series, kinds, top senders', async () => {
    const r = await admin.call('GET', '/api/admin/stats?tz=300&days=14');
    assert.equal(r.status, 200);
    assert.equal(r.data.days.length, 14);
    for (const k of ['messages', 'users', 'events', 'logins', 'calls']) assert.equal(r.data.series[k].length, 14);
    assert.ok(r.data.series.messages.at(-1) >= 1, 'today has messages');
    assert.ok(r.data.kinds.text >= 1);
    assert.ok(r.data.top_users.length >= 1);
    assert.equal((await admin.call('GET', '/api/admin/stats?tz=99999')).status, 400);
  });

  await t.test('journal records sends, edits (old/new), deletions (text kept) and profile changes', async () => {
    const r = await admin.call('GET', '/api/admin/audit?limit=200');
    assert.equal(r.status, 200);
    const ev = r.data.events;
    assert.ok(ev.some((e) => e.action === 'message.send' && e.actor.id === u1.user.id && e.chat_id === chat.id));
    const edit = ev.find((e) => e.action === 'message.edit');
    assert.deepEqual([edit.details.old, edit.details.new], ['секретный план', 'план изменён']);
    const del = ev.find((e) => e.action === 'message.delete');
    assert.equal(del.details.text, 'это удалю');
    assert.equal(del.details.deleted_by_author, true);
    const prof = ev.find((e) => e.action === 'profile.update');
    assert.deepEqual(prof.details.changed.name, ['Anvar', 'Anvar Karimov']);
    assert.ok(ev.every((e) => e.ts > 0));
  });

  await t.test('full chat history with sender identity and edit history', async () => {
    const r = await admin.call('GET', `/api/admin/chats/${chat.id}/messages`);
    const m = r.data.messages.find((x) => x.id === sent.id);
    assert.equal(m.sender.phone, '+998901110011');
    assert.equal(m.text, 'план изменён');
    assert.equal(m.edits[0].old, 'секретный план');
    assert.equal(r.data.deleted[0].details.text, 'это удалю');
  });

  await t.test('admin reading is itself journaled', async () => {
    const r = await admin.call('GET', '/api/admin/audit?action=admin.view');
    assert.ok(r.data.events.some((e) => e.action === 'admin.view_chat' && e.actor.id === admin.user.id));
  });

  await t.test('users, chats and overview endpoints', async () => {
    const o = await admin.call('GET', '/api/admin/overview');
    assert.ok(o.data.users >= 3 && o.data.messages >= 1);
    const us = await admin.call('GET', '/api/admin/users?q=Anvar');
    assert.equal(us.data.users[0].phone, '+998901110011');
    const ud = await admin.call('GET', `/api/admin/users/${u1.user.id}`);
    assert.ok(ud.data.sessions.length >= 1 && ud.data.chats.length >= 1);
    const cs = await admin.call('GET', '/api/admin/chats');
    assert.ok(cs.data.chats.some((c) => c.id === chat.id && c.people.length === 2));
  });
});

test('sign-in with Telegram is retired (login + password only)', async () => {
  const p = await (await fetch(BASE + '/api/auth/providers')).json();
  assert.equal(p.telegram.enabled, false);
  assert.equal((await fetch(BASE + '/api/auth/telegram/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
});

test('public download page and installers', async (t) => {
  const anon = new Client('anon', '+1');
  await t.test('listing is public and classified by platform', async () => {
    const r = await anon.call('GET', '/api/downloads');
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.data.files.map((x) => [x.platform, x]));
    assert.ok(by.windows && by.android && by.linux);
    assert.equal(r.data.files.some((x) => x.name === 'notes.txt'), false);
    assert.match(by.android.sha256, /^[0-9a-f]{64}$/);
  });
  await t.test('files download as attachments without login', async () => {
    const r = await anon.call('GET', '/downloads/Suhbat-dosh-android-1.2.3.apk');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-disposition'), /^attachment/);
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  });
  await t.test('unlisted files and path traversal are refused', async () => {
    assert.equal((await anon.call('GET', '/downloads/notes.txt')).status, 404);
    assert.equal((await anon.call('GET', '/downloads/..%2Fsuhbat.db')).status, 404);
    assert.equal((await anon.call('GET', '/downloads/%2E%2E%2F%2E%2E%2Fetc%2Fpasswd')).status, 404);
  });
  await t.test('download page is served', async () => {
    const r = await fetch(BASE + '/download');
    assert.equal(r.status, 200);
    assert.match(await r.text(), /Suhbat-dosh/);
  });
});

test('saved messages and archive', async (t) => {
  const u = await new Client('Saver', '+998901110055').login();
  const other = await new Client('Other', '+998901110056').login();
  let saved;
  await t.test('saved chat is private, idempotent and sendable', async () => {
    saved = (await u.call('POST', '/api/chats/saved')).data.chat;
    assert.equal(saved.saved, true);
    assert.equal(saved.peer.id, u.user.id);
    assert.equal((await u.call('POST', '/api/chats/saved')).data.chat.id, saved.id);
    const m = await u.call('POST', `/api/chats/${saved.id}/messages`, { text: 'заметка для себя' });
    assert.equal(m.status, 201);
    const list = await u.call('GET', '/api/chats');
    assert.equal(list.data.chats.find((c) => c.id === saved.id).unread, 0);
    assert.equal((await other.call('GET', `/api/chats/${saved.id}/messages`)).status, 404);
  });
  await t.test('archive flag is per user and toggles', async () => {
    const dm = (await u.call('POST', '/api/chats/direct', { user_id: other.user.id })).data.chat;
    assert.equal(dm.archived, false);
    const a = await u.call('PATCH', `/api/chats/${dm.id}/me`, { archived: true });
    assert.equal(a.data.chat.archived, true);
    const theirs = (await other.call('GET', '/api/chats')).data.chats.find((c) => c.id === dm.id);
    assert.ok(!theirs || theirs.archived === false);
    assert.equal((await u.call('PATCH', `/api/chats/${dm.id}/me`, { archived: false })).data.chat.archived, false);
  });
});

test('e-mail login', async (t) => {
  const anon = () => new Client('anon', '+1');
  const lastMail = () => stub.mail.at(-1);
  const codeOf = (mail) => /(\d{6})/.exec(mail.text)[1];

  await t.test('providers advertise e-mail', async () => {
    const r = await anon().call('GET', '/api/auth/providers');
    assert.equal(r.data.email, true);
  });

  await t.test('invalid addresses are rejected before anything is sent', async () => {
    const n = stub.mail.length;
    assert.equal((await anon().call('POST', '/api/auth/email/request', { email: 'not-an-email' })).status, 400);
    assert.equal((await anon().call('POST', '/api/auth/email/request', { email: 'a@b' })).status, 400);
    assert.equal(stub.mail.length, n);
  });

  let userId;
  await t.test('new address: code is mailed, name is asked, account is created', async () => {
    const c = anon();
    const r = await c.call('POST', '/api/auth/email/request', { email: 'Ali.Valiyev@Example.com' });
    assert.equal(r.status, 200);
    assert.equal('dev_code' in r.data, false); // never returned to the browser
    const mail = lastMail();
    assert.equal(mail.auth, 'Bearer re_test_key');
    assert.deepEqual(mail.to, ['ali.valiyev@example.com']);
    assert.match(mail.subject, /Suhbat-dosh/);
    const code = codeOf(mail);
    assert.equal((await c.call('POST', '/api/auth/email/verify', { email: 'ali.valiyev@example.com', code: code === '000000' ? '111111' : '000000' })).status, 400);
    const need = await c.call('POST', '/api/auth/email/verify', { email: 'ali.valiyev@example.com', code });
    assert.equal(need.data.needs_name, true);
    const done = await c.call('POST', '/api/auth/email/verify', { email: 'ali.valiyev@example.com', code, name: 'Ali Valiyev' });
    assert.equal(done.status, 200);
    assert.equal(done.data.user.email, 'ali.valiyev@example.com');
    assert.equal(done.data.user.phone, null);
    assert.equal((await c.call('GET', '/api/me')).status, 200);
    userId = done.data.user.id;
    // the code is single use
    assert.equal((await anon().call('POST', '/api/auth/email/verify', { email: 'ali.valiyev@example.com', code, name: 'X' })).status, 400);
  });

  await t.test('returning address signs in to the same account', async () => {
    const c = anon();
    await c.call('POST', '/api/auth/email/request', { email: 'ali.valiyev@example.com' });
    const r = await c.call('POST', '/api/auth/email/verify', { email: 'ali.valiyev@example.com', code: codeOf(lastMail()) });
    assert.equal(r.status, 200);
    assert.equal(r.data.user.id, userId);
  });

  await t.test('wrong codes are limited', async () => {
    const c = anon();
    await c.call('POST', '/api/auth/email/request', { email: 'limit@example.com' });
    const real = codeOf(lastMail());
    const bad = real === '123456' ? '654321' : '123456';
    let last;
    for (let i = 0; i < 6; i++) last = await c.call('POST', '/api/auth/email/verify', { email: 'limit@example.com', code: bad, name: 'L' });
    assert.ok([400, 429].includes(last.status));
    // the code is destroyed after too many wrong attempts: even the right one no longer works
    assert.ok([400, 429].includes((await c.call('POST', '/api/auth/email/verify', { email: 'limit@example.com', code: real, name: 'L' })).status));
  });

  await t.test('link an address to an existing account from settings', async () => {
    const u = await new Client('Linker', '+998901110077').login();
    assert.equal((await u.call('POST', '/api/me/email', { email: 'ali.valiyev@example.com' })).status, 409);
    assert.equal((await u.call('POST', '/api/me/email', { email: 'linker@example.com' })).status, 200);
    const code = codeOf(lastMail());
    assert.equal((await u.call('POST', '/api/me/email/verify', { email: 'linker@example.com', code })).data.user.email, 'linker@example.com');
    // now the same account signs in by e-mail
    const c = anon();
    await c.call('POST', '/api/auth/email/request', { email: 'linker@example.com' });
    const r = await c.call('POST', '/api/auth/email/verify', { email: 'linker@example.com', code: codeOf(lastMail()) });
    assert.equal(r.data.user.id, u.user.id);
    assert.equal((await u.call('DELETE', '/api/me/email')).data.user.email, null);
  });
});

test('realtime: profile changes reach other people and own devices instantly', async () => {
  const a = await new Client('Rt-A', '+998901110061').login();
  const b = await new Client('Rt-B', '+998901110062').login();
  const a2 = new Client('Rt-A', a.phone);
  a2.cookie = a.cookie;
  await b.call('POST', '/api/chats/direct', { user_id: a.user.id });
  await b.connect();
  await a2.connect();
  await a.call('PATCH', '/api/me', { name: 'Rt-A Renamed', status: 'в пути' });
  const seen = await b.waitFor('presence', (e) => e.user.id === a.user.id && e.user.name === 'Rt-A Renamed');
  assert.equal(seen.user.status, 'в пути');
  const own = await a2.waitFor('me.update', (e) => e.user.name === 'Rt-A Renamed');
  assert.equal(own.user.id, a.user.id);
});

test('media: thumbnails, range streaming, inline PDF, gallery', async (t) => {
  const a = await new Client('Med-A', '+998901110071').login();
  const b = await new Client('Med-B', '+998901110072').login();
  const x = await new Client('Med-X', '+998901110073').login();
  const chat = (await a.call('POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  const up = (name, buf) => a.call('POST', `/api/chats/${chat.id}/files?name=${encodeURIComponent(name)}`, null, { raw: buf, headers: { 'content-type': 'application/octet-stream' } });
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(1024 * 1024, 7)]);
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF');

  const img = await up('photo.png', PNG);
  const vid = await up('clip.mp4', mp4);
  const doc = await up('report.pdf', pdf);

  await t.test('owner uploads a thumbnail; it is visible to members only', async () => {
    await b.connect();
    const r = await a.call('POST', `/api/files/${img.data.message.file.id}/thumb?w=640&h=480`, null, { raw: PNG, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(r.status, 200);
    const ev = await b.waitFor('message.update', (e) => e.message.id === img.data.message.id);
    assert.ok(ev.message.file.thumb);
    assert.equal(ev.message.file.width, 640);
    assert.equal((await b.call('GET', ev.message.file.thumb)).status, 200);
    assert.equal((await x.call('GET', ev.message.file.thumb)).status, 404);
    // only the sender may attach a thumbnail, and it must be an image
    assert.equal((await b.call('POST', `/api/files/${img.data.message.file.id}/thumb`, null, { raw: PNG, headers: { 'content-type': 'application/octet-stream' } })).status, 404);
    assert.equal((await a.call('POST', `/api/files/${vid.data.message.file.id}/thumb`, null, { raw: Buffer.from('<html>'), headers: { 'content-type': 'application/octet-stream' } })).status, 415);
  });

  await t.test('video is streamed with byte ranges (seeking / partial download)', async () => {
    const res = await fetch(BASE + vid.data.message.file.url, { headers: { cookie: b.cookie, range: 'bytes=100-199' } });
    assert.equal(res.status, 206);
    assert.match(res.headers.get('content-range'), /^bytes 100-199\//);
    assert.equal((await res.arrayBuffer()).byteLength, 100);
    assert.equal(res.headers.get('accept-ranges'), 'bytes');
    assert.match(res.headers.get('cache-control'), /private/);
  });

  await t.test('PDF opens inline only when asked and only frameable by our own pages', async () => {
    const url = doc.data.message.file.url;
    const plain = await b.call('GET', url);
    assert.match(plain.headers.get('content-disposition'), /^attachment/);
    const inline = await b.call('GET', `${url}?inline=1`);
    assert.match(inline.headers.get('content-disposition'), /^inline/);
    assert.equal(inline.headers.get('content-type'), 'application/pdf');
    assert.equal(inline.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(inline.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    assert.equal((await b.call('GET', `${img.data.message.file.url}?dl=1`)).headers.get('content-disposition').startsWith('attachment'), true);
  });

  await t.test('gallery lists media, files and links of the chat', async () => {
    await a.call('POST', `/api/chats/${chat.id}/messages`, { text: 'смотри https://example.com/page?x=1 и ещё' });
    const media = await b.call('GET', `/api/chats/${chat.id}/media?kind=media`);
    assert.equal(media.data.messages.length, 2);
    const files = await b.call('GET', `/api/chats/${chat.id}/media?kind=files`);
    assert.equal(files.data.messages.length, 1);
    const links = await b.call('GET', `/api/chats/${chat.id}/media?kind=links`);
    assert.deepEqual(links.data.messages[0].links, ['https://example.com/page?x=1']);
    assert.equal((await x.call('GET', `/api/chats/${chat.id}/media?kind=media`)).status, 404);
  });
});

test('updates: version endpoint and installer metadata', async () => {
  const anon = new Client('anon', '+1');
  const v = await anon.call('GET', '/api/version');
  assert.equal(v.status, 200);
  assert.match(v.data.build, /^[0-9a-f]{12}$/);
  assert.ok(v.data.server);
  assert.equal(v.data.apps.android.version, '1.2.3');
  // electron-updater metadata is public, other stray files are not
  assert.equal((await anon.call('GET', '/downloads/latest.yml')).status, 200);
  assert.equal((await anon.call('GET', '/downloads/secret.txt')).status, 404);
});

test('calls: a sleeping app (push device) keeps ringing and gets the call when it opens', async () => {
  const a = await new Client('Rng-A', '+998901110091').login();
  const b = await new Client('Rng-B', '+998901110092').login();
  const chat = (await a.call('POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  await a.connect();
  const sub = await b.call('POST', '/api/push/subscribe', { subscription: { endpoint: 'https://127.0.0.1:9/push-test', keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' } } });
  assert.equal(sub.status, 200);
  const id = 'callid-' + Math.random().toString(36).slice(2, 12);
  a.ws.send(JSON.stringify({ type: 'call.invite', chat_id: chat.id, call_id: id, video: false, sdp: 'v=0 offer' }));
  const ringing = await a.waitFor('call.ringing', (e) => e.call_id === id);
  assert.notEqual(ringing.offline, true); // not an instant miss: the callee has a device to wake
  await new Promise((r) => setTimeout(r, 500));
  await b.connect(); // the app is opened from the notification
  const inc = await b.waitFor('call.incoming', (e) => e.call_id === id);
  assert.equal(inc.from.id, a.user.id);
  b.ws.send(JSON.stringify({ type: 'call.answer', call_id: id, sdp: 'v=0 answer' }));
  assert.ok(await a.waitFor('call.answered', (e) => e.call_id === id));
  a.ws.send(JSON.stringify({ type: 'call.end', call_id: id }));
});

test('calls: signalling, renegotiation, grace on reconnect, quality metrics', async (t) => {
  const admin = await new Client('Root', '+998901110099').login();
  const a = await new Client('Cal-A', '+998901110081').login();
  const b = await new Client('Cal-B', '+998901110082').login();
  const chat = (await a.call('POST', '/api/chats/direct', { user_id: b.user.id })).data.chat;
  await a.connect();
  await b.connect();
  const id = 'callid-' + Math.random().toString(36).slice(2, 12);
  const send = (c, m) => c.ws.send(JSON.stringify(m));

  await t.test('invite -> incoming -> answer -> answered', async () => {
    send(a, { type: 'call.invite', chat_id: chat.id, call_id: id, video: true, sdp: 'v=0 offer' });
    const inc = await b.waitFor('call.incoming', (e) => e.call_id === id);
    assert.equal(inc.video, true);
    assert.equal(inc.from.id, a.user.id);
    send(b, { type: 'call.answer', call_id: id, sdp: 'v=0 answer' });
    const ans = await a.waitFor('call.answered', (e) => e.call_id === id);
    assert.equal(ans.sdp, 'v=0 answer');
  });

  await t.test('ICE restart is relayed in both directions, including the restart request', async () => {
    send(a, { type: 'call.reneg', call_id: id, kind: 'offer', sdp: 'v=0 re-offer' });
    const off = await b.waitFor('call.reneg', (e) => e.kind === 'offer');
    assert.equal(off.sdp, 're-offer'.length ? 'v=0 re-offer' : '');
    send(b, { type: 'call.reneg', call_id: id, kind: 'answer', sdp: 'v=0 re-answer' });
    assert.equal((await a.waitFor('call.reneg', (e) => e.kind === 'answer')).sdp, 'v=0 re-answer');
    send(b, { type: 'call.reneg', call_id: id, kind: 'restart' });
    assert.ok(await a.waitFor('call.reneg', (e) => e.kind === 'restart'));
  });

  await t.test('live captions: text is relayed to the other side only', async () => {
    send(a, { type: 'call.caption', call_id: id, text: 'Привет, как дела?', lang: 'ru-RU', final: true });
    const cap = await b.waitFor('call.caption', (e) => e.call_id === id);
    assert.equal(cap.text, 'Привет, как дела?');
    assert.equal(cap.lang, 'ru-RU');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(a.events.some((e) => e.type === 'call.caption'), false);
    send(a, { type: 'call.caption', call_id: id, text: 'x'.repeat(1000), lang: 'ru-RU' });
    const long = await b.waitFor('call.caption', (e) => e.text.length > 100);
    assert.equal(long.text.length, 300);
  });

  await t.test('a stranger cannot inject signalling into the call', async () => {
    const x = await new Client('Cal-X', '+998901110083').login();
    await x.connect();
    send(x, { type: 'call.reneg', call_id: id, kind: 'offer', sdp: 'evil' });
    send(x, { type: 'call.end', call_id: id });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(a.events.some((e) => e.type === 'call.ended' && e.call_id === id), false);
    assert.equal(b.events.some((e) => e.type === 'call.reneg' && e.sdp === 'evil'), false);
  });

  await t.test('a short connection loss does not end the call (grace period)', async () => {
    b.ws.close();
    await new Promise((r) => setTimeout(r, 600));
    await b.connect(); // device came back within the grace window
    await b.waitFor('call.resumed', (e) => e.call_id === id);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(a.events.some((e) => e.type === 'call.ended' && e.call_id === id), false);
  });

  await t.test('quality metrics are stored as numbers only, then hang up writes the history', async () => {
    send(a, { type: 'call.stats', call_id: id, stats: { rtt_ms: 42.2, loss_pct: 0.5, jitter_ms: 4, kbps_in: 900, kbps_out: 850, width: 1280, height: 720, fps: 30, codec: 'VP8', relay: false, mode: 'auto', reconnects: 1, duration: 33, samples: 16, evil: '<script>', transcript: 'secret words' } });
    send(a, { type: 'call.end', call_id: id, reason: 'hangup' });
    await a.waitFor('call.ended', (e) => e.call_id === id && e.reason === 'ended');
    const log = await admin.call('GET', '/api/admin/audit?action=call.quality');
    const q = log.data.events.find((e) => e.target_id === id);
    assert.ok(q, 'quality entry exists');
    assert.equal(q.details.codec, 'VP8');
    assert.equal(q.details.height, 720);
    assert.equal('evil' in q.details, false);
    assert.equal('transcript' in q.details, false);
    const hist = await a.call('GET', `/api/chats/${chat.id}/messages`);
    assert.equal(hist.data.messages.at(-1).kind, 'call');
  });
});


test('sign-up needs a verified e-mail address', async (t) => {
  const anon = () => new Client('anon', '+1');
  const codeOf = () => /(\d{6})/.exec(stub.mail.at(-1).text)[1];
  const body = { name: 'Мария', username: 'maria_pw', password: 'long-enough-1', email: 'maria@example.com' };
  await t.test('no code, no account', async () => {
    assert.equal((await anon().call('POST', '/api/auth/register', body)).status, 400);
    assert.equal((await anon().call('POST', '/api/auth/register', { ...body, email: undefined })).status, 400);
  });
  await t.test('code is mailed, then the account is created with the address verified', async () => {
    const c = anon();
    assert.equal((await c.call('POST', '/api/auth/register/code', { username: body.username, email: body.email })).status, 200);
    const code = codeOf();
    assert.equal((await c.call('POST', '/api/auth/register', { ...body, code: code === '000000' ? '111111' : '000000' })).status, 400);
    const r = await c.call('POST', '/api/auth/register', { ...body, code });
    assert.equal(r.status, 201);
    assert.equal(r.data.user.email, 'maria@example.com');
    assert.equal((await anon().call('POST', '/api/auth/login', { login: 'maria_pw', password: body.password })).status, 200);
  });
  await t.test('an address or a login cannot be used twice', async () => {
    assert.equal((await anon().call('POST', '/api/auth/register/code', { username: 'maria_two', email: body.email })).status, 409);
    assert.equal((await anon().call('POST', '/api/auth/register/code', { username: body.username, email: 'other@example.com' })).status, 409);
  });
});
