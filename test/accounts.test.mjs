// Several accounts on one device: cookie swapping.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6660 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
before(async () => {
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-ac-')), REGISTRATION_OPEN: '1',
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
async function raw(cookies, method, url, body) {
  const jar = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const r = await fetch(BASE + url, { method, headers: { cookie: jar, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const set = {};
  for (const line of r.headers.getSetCookie()) { const [kv] = line.split(';'); const i = kv.indexOf('='); set[kv.slice(0, i)] = { value: kv.slice(i + 1), gone: /Max-Age=0/i.test(line) }; }
  return { status: r.status, data: await r.json().catch(() => ({})), set };
}
const apply = (jar, set) => { const out = { ...jar }; for (const [k, v] of Object.entries(set)) { if (v.gone || !v.value) delete out[k]; else out[k] = v.value; } return out; };

test('stash the current account, sign in as another, switch back and forth, remove one', async () => {
  const reg = async (name) => {
    const r = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name, username: name, password: 'longenough1' }) });
    return { jar: { sid: (r.headers.get('set-cookie') || '').split(';')[0].split('=')[1] }, user: (await r.json()).user };
  };
  const a = await reg('alice_ac');
  const b = await reg('boris_ac');
  // the device is signed in as Alice; she puts herself aside
  let jar = a.jar;
  const st = await raw(jar, 'POST', '/api/accounts/stash');
  assert.equal(st.status, 200);
  jar = apply(jar, st.set);
  assert.equal(jar.sid, undefined);
  assert.ok(jar[`sid_${a.user.id}`]);
  assert.equal((await raw(jar, 'GET', '/api/me')).status, 401);
  // Boris signs in on the same device (here: his cookie arrives next to the stashed one)
  jar = { ...jar, sid: b.jar.sid };
  const list = (await raw(jar, 'GET', '/api/accounts')).data;
  assert.deepEqual(list.accounts.map((x) => [x.name, x.current]), [['boris_ac', true], ['alice_ac', false]]);
  assert.equal((await raw(jar, 'GET', '/api/me')).data.user.name, 'boris_ac');
  // switch to Alice
  const sw = await raw(jar, 'POST', '/api/accounts/switch', { user_id: a.user.id });
  jar = apply(jar, sw.set);
  assert.equal((await raw(jar, 'GET', '/api/me')).data.user.name, 'alice_ac');
  assert.ok(jar[`sid_${b.user.id}`], 'Boris stays signed in, stashed');
  // switching to somebody who is not on this device fails
  assert.equal((await raw(jar, 'POST', '/api/accounts/switch', { user_id: 999 })).status, 404);
  // Alice's session expired meanwhile: switching still works
  delete jar.sid;
  const back = await raw(jar, 'POST', '/api/accounts/switch', { user_id: b.user.id });
  jar = apply(jar, back.set);
  assert.equal((await raw(jar, 'GET', '/api/me')).data.user.name, 'boris_ac');
  // removing a stashed account revokes its session
  jar = { ...jar, [`sid_${a.user.id}`]: a.jar.sid };
  const rm = await raw(jar, 'DELETE', `/api/accounts/${a.user.id}`);
  assert.equal(rm.status, 200);
  assert.equal((await raw({ sid: a.jar.sid }, 'GET', '/api/me')).status, 401);
});
