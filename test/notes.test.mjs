// Shared notes: the edit rewriting rules, many clients typing at once (they must all end with the server's text),
// and the HTTP side (revisions, a repeated request, outsiders).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyOp, diffOp, shiftCaret, transform } from '../shared/ot.js';
import { NoteClient } from '../web/js/notesync.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6260 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-note-')), REGISTRATION_OPEN: '1',
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

test('diff and apply round trip; carets move with edits', () => {
  for (const [a, b] of [['hello', 'hello world'], ['hello world', 'hello'], ['abc', 'axc'], ['', 'x'], ['x', ''], ['aaa', 'aaaa'], ['привет мир', 'привет, мир!']]) {
    const op = diffOp(a, b);
    assert.equal(applyOp(a, op ?? { pos: 0, del: 0, ins: '' }), b);
  }
  assert.equal(diffOp('same', 'same'), null);
  assert.equal(shiftCaret(5, { pos: 2, del: 0, ins: 'xx' }), 7);
  assert.equal(shiftCaret(1, { pos: 2, del: 0, ins: 'xx' }), 1);
  assert.equal(shiftCaret(4, { pos: 2, del: 4, ins: '' }), 2);
});

test('transform: inserts at the same place keep their order, overlapping deletes lose nothing typed', () => {
  const base = 'abcdef';
  const a = { pos: 3, del: 0, ins: 'A' };
  const b = { pos: 3, del: 0, ins: 'B' };
  assert.equal(applyOp(applyOp(base, b), transform(a, b)), 'abcBAdef');
  const delA = { pos: 1, del: 3, ins: '' };
  const delB = { pos: 2, del: 3, ins: '' };
  const afterB = applyOp(base, delB);
  assert.ok(applyOp(afterB, transform(delA, delB)).length >= 1);
  const typed = { pos: 2, del: 0, ins: 'XYZ' };
  assert.ok(applyOp(applyOp(base, { pos: 0, del: 6, ins: '' }), transform(typed, { pos: 0, del: 6, ins: '' })).includes('XYZ'));
});

// a deterministic random generator so a failure can be replayed
const rng = (seed) => () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };

test('fuzz: clients typing at once over a slow network all end with the server text', async () => {
  for (let seed = 1; seed <= 40; seed++) {
    const rnd = rng(seed);
    const srv = { body: 'Заметка: ', rev: 0, ops: [] };
    const clients = [];
    const inbox = []; // [deliverAtTick, clientIndex, event]
    let tick = 0;
    const lastAt = new Map(); // a socket delivers in order: an event never overtakes an earlier one
    const broadcast = (rev, op, cid) => {
      for (let i = 0; i < clients.length; i++) {
        const at = Math.max((lastAt.get(i) || 0) + 0.001, tick + 1 + Math.floor(rnd() * 6));
        lastAt.set(i, at);
        inbox.push([at, i, { rev, op, cid }]);
      }
    };
    const post = (req) => new Promise((resolve) => {
      inbox.push([tick + 1 + Math.floor(rnd() * 5), -1, () => {
        let op = { pos: req.pos, del: req.del, ins: req.ins };
        for (const m of srv.ops.slice(req.rev)) op = transform(op, m);
        op = { ...op, pos: Math.min(op.pos, srv.body.length) };
        op.del = Math.min(op.del, srv.body.length - op.pos);
        srv.body = applyOp(srv.body, op);
        srv.rev += 1;
        srv.ops.push(op);
        broadcast(srv.rev, op, req.cid);
        inbox.push([tick + 1 + Math.floor(rnd() * 5), -1, () => resolve({ rev: srv.rev, op })]);
      }]);
    });
    for (let c = 0; c < 4; c++) {
      const cl = new NoteClient({ send: post, onText: () => {}, onResync: () => { throw new Error('unexpected resync'); }, cid: `c${c}` });
      cl.init(srv.body, srv.rev);
      clients.push(cl);
    }
    const drain = () => {
      inbox.sort((x, y) => x[0] - y[0]);
      while (inbox.length && inbox[0][0] <= tick) {
        const [, who, ev] = inbox.shift();
        if (who === -1) ev(); else clients[who].serverOp(ev);
      }
    };
    for (; tick < 120; tick++) {
      const cl = clients[Math.floor(rnd() * clients.length)];
      if (rnd() < 0.7) {
        const t = cl.local;
        const pos = Math.floor(rnd() * (t.length + 1));
        const r = rnd();
        const next = r < 0.6 ? t.slice(0, pos) + 'abcxyz'[Math.floor(rnd() * 6)] + t.slice(pos)
          : r < 0.85 ? t.slice(0, Math.max(0, pos - 2)) + t.slice(pos) : t.slice(0, pos) + 'вставка ' + t.slice(pos);
        cl.edit(next);
      }
      drain();
    }
    for (let k = 0; k < 200 && (inbox.length || clients.some((c) => c.inflight || c.local !== c.doc)); k++) { tick += 1; drain(); }
    for (const cl of clients) {
      assert.equal(cl.doc, srv.body, `seed ${seed}: confirmed text differs`);
      assert.equal(cl.local, srv.body, `seed ${seed}: visible text differs`);
    }
  }
});

test('HTTP: create a note, edit from two people against old revisions, repeat a request, outsiders', async () => {
  const a = await signup('alice_nt');
  const b = await signup('boris_nt');
  const eve = await signup('eve_nt');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const mk = await call(a.cookie, 'POST', `/api/chats/${chat.id}/notes`, { title: 'План' });
  assert.equal(mk.status, 201);
  assert.equal(mk.data.message.kind, 'note');
  const id = mk.data.message.note.id;
  const o1 = await call(a.cookie, 'POST', `/api/notes/${id}/op`, { rev: 0, pos: 0, del: 0, ins: 'Привет', cid: 'a1' });
  assert.equal(o1.data.rev, 1);
  const rep = await call(a.cookie, 'POST', `/api/notes/${id}/op`, { rev: 0, pos: 0, del: 0, ins: 'Привет', cid: 'a1' });
  assert.equal(rep.data.rev, 1, 'the same request is answered, not applied twice');
  // boris still sees revision 0 and inserts at the start: the server puts it after alice's text keeping both
  const o2 = await call(b.cookie, 'POST', `/api/notes/${id}/op`, { rev: 0, pos: 0, del: 0, ins: '!', cid: 'b1' });
  assert.equal(o2.data.rev, 2);
  const got = await call(b.cookie, 'GET', `/api/notes/${id}`);
  assert.equal(got.data.note.body, 'Привет!');
  assert.equal(got.data.note.rev, 2);
  assert.equal((await call(a.cookie, 'POST', `/api/notes/${id}/op`, { rev: 9, pos: 0, del: 0, ins: 'x' })).status, 409);
  assert.equal((await call(eve.cookie, 'GET', `/api/notes/${id}`)).status, 404);
  assert.equal((await call(eve.cookie, 'POST', `/api/notes/${id}/op`, { rev: 2, pos: 0, del: 0, ins: 'x' })).status, 404);
  assert.equal((await call(a.cookie, 'POST', `/api/notes/${id}/op`, { rev: 2, pos: 0, del: 0, ins: '' })).status, 400);
  const exp = await fetch(`${BASE}/api/notes/${id}/export`, { headers: { cookie: a.cookie } });
  assert.equal(await exp.text(), 'Привет!');
  const msgs = (await call(a.cookie, 'GET', `/api/chats/${chat.id}/messages`)).data.messages;
  assert.equal(msgs.find((m) => m.kind === 'note').note.preview, 'Привет!');
});
