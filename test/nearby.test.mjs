// Direct transfers: signalling only between the two people of a personal chat; the signed ticket can be checked with no server.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 7170 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', OTP_REQUESTS_PER_IP: '500', LOG_LEVEL: 'error', TRUST_PROXY: 'true', DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-nb-')) };
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
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: (r.headers.get('set-cookie') || '').split(';')[0] };
}
let seq = 0;
async function signup(name) {
  const phone = `+99890${String(3000000 + (seq += 1))}`;
  const a = await call('', 'POST', '/api/auth/request', { phone });
  return call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
}
const open = (cookie) => new Promise((resolve, reject) => {
  const got = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie } });
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  ws.on('open', () => resolve({ ws, got }));
  ws.on('error', reject);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const signals = (c) => c.got.filter((e) => e.type === 'direct.signal');
const b64 = (buf) => Buffer.from(buf).toString('base64url');

test('signalling goes to the other person of a personal chat and nobody else', async () => {
  const a = await signup('Айдар');
  const b = await signup('Мадина');
  const stranger = await signup('Чужой');
  const chat = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  const wa = await open(a.cookie);
  const wb = await open(b.cookie);
  const ws = await open(stranger.cookie);
  await sleep(100);

  wa.ws.send(JSON.stringify({ type: 'direct.signal', chat_id: chat.id, data: { t: 'offer', tid: 'tid-12345678' } }));
  await sleep(200);
  assert.equal(signals(wb).length, 1);
  assert.equal(signals(wb)[0].from, a.data.user.id);
  assert.equal(signals(wb)[0].data.t, 'offer');
  assert.equal(signals(wa).length, 0, 'not echoed to the sender');
  assert.equal(signals(ws).length, 0);

  ws.ws.send(JSON.stringify({ type: 'direct.signal', chat_id: chat.id, data: { t: 'offer', tid: 'tid-87654321' } }));
  await sleep(200);
  assert.equal(signals(wb).length, 1, 'somebody outside the chat cannot reach them');

  // blocked: nothing passes
  assert.equal((await call(b.cookie, 'POST', `/api/blocks/${a.data.user.id}`, {})).status < 300, true);
  wa.ws.send(JSON.stringify({ type: 'direct.signal', chat_id: chat.id, data: { t: 'offer', tid: 'tid-11112222' } }));
  await sleep(200);
  assert.equal(signals(wb).length, 1, 'a blocked person cannot offer files');
  for (const c of [wa, wb, ws]) c.ws.close();
});

test('group chats get no signalling', async () => {
  const a = await signup('Аня');
  const b = await signup('Борис');
  const g = await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'Группа', member_ids: [b.data.user.id] });
  assert.ok(g.data.chat?.id, JSON.stringify(g.data));
  const wb = await open(b.cookie);
  const wa = await open(a.cookie);
  await sleep(100);
  wa.ws.send(JSON.stringify({ type: 'direct.signal', chat_id: g.data.chat.id, data: { t: 'offer', tid: 'tid-33334444' } }));
  await sleep(200);
  assert.equal(signals(wb).length, 0);
  wa.ws.close();
  wb.ws.close();
});

test('a ticket proves the account with no server, and only for the key it names', async () => {
  const a = await signup('Вера');
  assert.equal((await call('', 'POST', '/api/nearby/ticket', { pub: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } })).status, 401);
  assert.equal((await call(a.cookie, 'POST', '/api/nearby/ticket', { pub: { kty: 'EC', crv: 'P-256', x: 'a', y: 'b' } })).status, 400, 'not a point on the curve');

  const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { kty, crv, x, y, d } = await crypto.subtle.exportKey('jwk', pair.privateKey);
  assert.equal((await call(a.cookie, 'POST', '/api/nearby/ticket', { pub: { kty, crv, x, y, d } })).status, 400, 'a private key is refused');

  const r = await call(a.cookie, 'POST', '/api/nearby/ticket', { pub: { kty, crv, x, y } });
  assert.equal(r.status, 200);
  const server = await crypto.subtle.importKey('jwk', r.data.server_key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const enc = new TextEncoder();
  assert.equal(await crypto.subtle.verify(SIGN, server, Buffer.from(r.data.sig, 'base64url'), enc.encode(r.data.ticket)), true, 'the browser can check the signature');
  assert.equal(await crypto.subtle.verify(SIGN, server, Buffer.from(r.data.sig, 'base64url'), enc.encode(`${r.data.ticket}x`)), false);
  const body = JSON.parse(Buffer.from(r.data.ticket, 'base64url').toString());
  assert.equal(body.u, a.data.user.id);
  assert.equal(body.p.x, x);
  assert.ok(body.e > Date.now());
  assert.ok(b64(Buffer.from('x')));
});

test('the signing key survives and stays the same for everyone', async () => {
  const a = await signup('Гуля');
  const b = await signup('Дима');
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const r1 = await call(a.cookie, 'POST', '/api/nearby/ticket', { pub: { kty, crv, x, y } });
  const r2 = await call(b.cookie, 'POST', '/api/nearby/ticket', { pub: { kty, crv, x, y } });
  assert.deepEqual(r1.data.server_key, r2.data.server_key);
  assert.equal(r1.data.server_key.d, undefined, 'the private part is never sent');
});

// Appended to test/nearby.test.mjs: who is introduced to whom on one network.
const lanOpen = (cookie, ip) => new Promise((resolve, reject) => {
  const got = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { cookie, 'x-forwarded-for': ip } });
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  ws.on('open', () => resolve({ ws, got }));
  ws.on('error', reject);
});
const lastPeers = (c) => c.got.filter((e) => e.type === 'direct.lan.peers').pop()?.peers || [];
const lid = () => crypto.randomUUID().replace(/-/g, '');

test('one network: strangers stay nameless, contacts are named, other networks are not told, blocked people are hidden', async () => {
  const a = await signup('Камола');
  const b = await signup('Сосед');
  const c = await signup('Далёкий');
  const friend = await signup('Друг');
  await call(a.cookie, 'POST', '/api/chats/direct', { user_id: friend.data.user.id });
  const [la, lb, lc, lf] = [lid(), lid(), lid(), lid()];
  const wa = await lanOpen(a.cookie, '198.51.100.7');
  const wb = await lanOpen(b.cookie, '198.51.100.7');
  const wc = await lanOpen(c.cookie, '203.0.113.9');
  const wf = await lanOpen(friend.cookie, '203.0.113.50');
  await sleep(100);

  // nobody is visible before they open the screen
  wa.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: la, open: true }));
  await sleep(150);
  assert.deepEqual(lastPeers(wa), []);

  wb.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lb, open: true }));
  wc.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lc, open: true }));
  wf.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lf, open: true }));
  await sleep(250);

  const seen = lastPeers(wa);
  const stranger = seen.find((p) => p.lid === lb);
  assert.equal(stranger.same_ip, true);
  assert.equal(stranger.name, undefined, 'the name of a stranger is not told by the server');
  assert.equal(stranger.uid, undefined);
  assert.equal(seen.some((p) => p.lid === lc), false, 'another network and no relation');
  const fr = seen.find((p) => p.lid === lf);
  assert.equal(fr.name, 'Друг');
  assert.equal(fr.same_ip, false);
  assert.equal(lastPeers(wc).length, 0);

  // signalling passes only between those who were introduced
  wa.ws.send(JSON.stringify({ type: 'direct.lan.signal', to: lb, data: { t: 'x' } }));
  wc.ws.send(JSON.stringify({ type: 'direct.lan.signal', to: la, data: { t: 'spy' } }));
  await sleep(200);
  assert.equal(wb.got.filter((e) => e.type === 'direct.lan.signal').length, 1);
  assert.equal(wb.got.find((e) => e.type === 'direct.lan.signal').from, la);
  assert.equal(wa.got.filter((e) => e.type === 'direct.lan.signal').length, 0, 'someone from another network cannot reach them');

  // taking over somebody's identifier does not work
  wc.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: la, open: true }));
  await sleep(150);
  assert.equal(lastPeers(wa).some((p) => p.lid === la), false);

  // blocked: gone from the list
  await call(a.cookie, 'POST', `/api/blocks/${b.data.user.id}`, {});
  wa.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: la, open: true }));
  await sleep(200);
  assert.equal(lastPeers(wa).some((p) => p.lid === lb), false);

  // closing the screen or the connection takes a device off the list
  wf.ws.send(JSON.stringify({ type: 'direct.lan.leave' }));
  await sleep(200);
  assert.equal(lastPeers(wa).some((p) => p.lid === lf), false);
  for (const x of [wa, wb, wc, wf]) x.ws.close();
});

test('IPv6: the same network is the first 64 bits, also when written differently', async () => {
  const a = await signup('Шести');
  const b = await signup('Версия');
  const wa = await lanOpen(a.cookie, '2001:db8:1:2:aaaa::1');
  const wb = await lanOpen(b.cookie, '2001:0db8:0001:0002:bbbb:0:0:2');
  await sleep(100);
  wa.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lid(), open: true }));
  wb.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lid(), open: true }));
  await sleep(250);
  assert.equal(lastPeers(wa).length, 1);
  assert.equal(lastPeers(wa)[0].same_ip, true);
  wa.ws.close();
  wb.ws.close();
});

test('a device with the app open is reachable; nothing moves until somebody opens the screen', async () => {
  const a = await signup('Спящий');
  const b = await signup('Ищущий');
  const [la, lb] = [lid(), lid()];
  const wa = await lanOpen(a.cookie, '198.51.100.20');
  const wb = await lanOpen(b.cookie, '198.51.100.20');
  await sleep(100);
  wa.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: la, open: false }));
  wb.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lb, open: false }));
  await sleep(200);
  assert.deepEqual(lastPeers(wa), [], 'both only have the app open: no searching');
  assert.deepEqual(lastPeers(wb), []);
  wb.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lb, open: true }));
  await sleep(200);
  assert.equal(lastPeers(wb).length, 1, 'one opened the screen: it finds the other');
  assert.equal(lastPeers(wa).length, 1, 'and the other one is told, so that it can answer');
  assert.equal(lastPeers(wb)[0].name, undefined);
  wb.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lb, open: false }));
  await sleep(200);
  assert.deepEqual(lastPeers(wa), [], 'closed again: the pair is forgotten');
  wa.ws.close();
  wb.ws.close();
});

test('one Wi-Fi seen as IPv4 and IPv6: the addresses the devices saw themselves bring them together; nonsense is ignored', async () => {
  const a = await signup('Ipv4');
  const b = await signup('Ipv6');
  const [la, lb] = [lid(), lid()];
  const wa = await lanOpen(a.cookie, '198.51.100.30');
  const wb = await lanOpen(b.cookie, '2001:db8:9:9::5');
  await sleep(100);
  wa.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: la, open: true, nets: ['not an address', '10.0.0.5', 42] }));
  wb.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: lb, open: true, nets: ['10.0.0.5'] }));
  await sleep(200);
  assert.deepEqual(lastPeers(wa), [], 'a private address says nothing about the network');
  wa.ws.send(JSON.stringify({ type: 'direct.lan.join', lid: la, open: true, nets: ['2001:db8:9:9::77'] }));
  await sleep(200);
  assert.equal(lastPeers(wa).length, 1);
  assert.equal(lastPeers(wa)[0].same_ip, true);
  assert.equal(lastPeers(wb).length, 1);
  wa.ws.close();
  wb.ws.close();
});
