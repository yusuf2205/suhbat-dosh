// Link previews: only public addresses are contacted; the card is made from the page's own title, description and picture.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPrivateIp, parseMeta } from '../server/src/linkpreview.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 6460 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;
let server;
let site;
let sitePort;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

before(async () => {
  site = http.createServer((req, res) => {
    if (req.url === '/page') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(`<html><head><title>Ignored</title><meta property="og:title" content="Привет &amp; мир"><meta property="og:description" content="Описание страницы"><meta property="og:image" content="/pic.png"><meta property="og:site_name" content="Тест"></head><body>x</body></html>`);
    } else if (req.url === '/pic.png') { res.setHeader('content-type', 'image/png'); res.end(Buffer.concat([PNG, Buffer.alloc(300)])); }
    else if (req.url === '/redirect') { res.statusCode = 302; res.setHeader('location', '/page'); res.end(); }
    else if (req.url === '/file') { res.setHeader('content-type', 'application/zip'); res.end('PK'); }
    else { res.statusCode = 404; res.end(); }
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  sitePort = site.address().port;
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-lp-')), REGISTRATION_OPEN: '1',
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env: { ...env, LINKPREVIEW_ALLOW_LOCAL: process.env.LP_LOCAL === '0' ? '' : '1' }, stdio: 'inherit' });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) return; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no start');
});
after(() => { server?.kill(); site?.close(); });

async function call(cookie, url) {
  const r = await fetch(BASE + url, { headers: cookie ? { cookie } : {} });
  return { status: r.status, data: await r.json().catch(() => ({})), type: r.headers.get('content-type') };
}

test('private and special addresses are recognised', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '224.0.0.1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) assert.equal(isPrivateIp(ip), false, ip);
});

test('meta tags: open graph first, entities decoded, picture resolved against the page', () => {
  const m = parseMeta('<title>Старый</title><meta property="og:title" content="A &amp; B"><meta name="description" content="Текст"><meta property="og:image" content="/i.jpg">', 'https://example.com/a/b');
  assert.equal(m.title, 'A & B');
  assert.equal(m.description, 'Текст');
  assert.equal(m.image, 'https://example.com/i.jpg');
  assert.equal(parseMeta('<title>Только заголовок</title>', 'https://x.y').title, 'Только заголовок');
});

test('the endpoint builds a card, follows a redirect, stores the picture, refuses non-pages and bad urls', async () => {
  const reg = await fetch(`${BASE}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'lp', username: 'lp_user', password: 'longenough1' }) });
  const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
  const url = (p) => `/api/preview?url=${encodeURIComponent(`http://127.0.0.1:${sitePort}${p}`)}`;
  const a = await call(cookie, url('/page'));
  assert.equal(a.data.preview.title, 'Привет & мир');
  assert.equal(a.data.preview.site, 'Тест');
  assert.ok(a.data.preview.image?.startsWith('/api/preview/img/'));
  const img = await fetch(BASE + a.data.preview.image, { headers: { cookie } });
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await call(cookie, url('/redirect'))).data.preview.title, 'Привет & мир');
  assert.equal((await call(cookie, url('/file'))).data.preview, null);
  assert.equal((await call(cookie, url('/missing'))).data.preview, null);
  assert.equal((await call(cookie, '/api/preview?url=ftp://x.y/z')).status, 400);
  assert.equal((await call('', url('/page'))).status, 401);
  assert.equal((await fetch(`${BASE}/api/preview/img/${'a'.repeat(32)}`, { headers: { cookie } })).status, 404);
});

test('by default the server never contacts its own machine or network', async () => {
  const port = PORT + 1;
  const env = {
    ...process.env, PORT: String(port), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'log', LOG_LEVEL: 'error',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-lp2-')), REGISTRATION_OPEN: '1',
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT; delete env.LINKPREVIEW_ALLOW_LOCAL;
  const s2 = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  try {
    for (let i = 0; i < 60; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) break; } catch { /* starting */ } await new Promise((r) => setTimeout(r, 100)); }
    const reg = await fetch(`http://127.0.0.1:${port}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'lp', username: 'lp_user2', password: 'longenough1' }) });
    const cookie = (reg.headers.get('set-cookie') || '').split(';')[0];
    for (const target of [`http://127.0.0.1:${sitePort}/page`, 'http://localhost/page', 'http://169.254.169.254/latest/meta-data', 'http://[::1]/x', 'http://192.168.1.1/']) {
      const r = await fetch(`http://127.0.0.1:${port}/api/preview?url=${encodeURIComponent(target)}`, { headers: { cookie } });
      assert.equal((await r.json()).preview, null, target);
    }
  } finally { s2.kill(); }
});
