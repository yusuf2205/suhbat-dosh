#!/usr/bin/env node
// A look at a running instance from the outside, the way a browser meets it: the pages, every script of the build (and that each one is valid),
// the styles, the icons, the update files, the API refusing strangers without errors, and the live connection answering.
// Usage: node scripts/smoke-prod.mjs [https://suhbat-dosh.uz]     Exit code 0: all fine, 1: something is wrong (listed).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import WebSocket from 'ws';

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'https://suhbat-dosh.uz').replace(/\/$/, '');
const problems = [];
let checked = 0;
const bad = (what, why) => problems.push(`${what}: ${why}`);
const get = async (p, opt = {}) => {
  const ctl = AbortSignal.timeout(20_000);
  try { return await fetch(BASE + p, { signal: ctl, redirect: 'manual', ...opt }); } catch (e) { return { ok: false, status: 0, error: String(e.message || e), headers: new Headers(), text: async () => '' }; }
};
async function page(p, mustHave, type = /text\/html/) {
  checked++;
  const r = await get(p);
  if (r.status !== 200) return bad(p, `HTTP ${r.status || r.error}`);
  if (!type.test(r.headers.get('content-type') || '')) bad(p, `type ${r.headers.get('content-type')}`);
  const body = await r.text();
  if (mustHave && !body.includes(mustHave)) bad(p, `has no «${mustHave}»`);
  return body;
}

// 1. the pages
const index = await page('/', '<title>');
const admin = await page('/admin.html', 'adm');
await page('/healthz', '"ok"', /json/);
await page('/manifest.webmanifest', 'name', /json|manifest/);
await page('/sw.js', 'CACHE', /javascript/);
await page('/icon.svg', '<svg', /svg/);

// 2. every style and script the pages name, and every module of the build
const assets = new Set();
for (const html of [index, admin]) for (const m of String(html || '').matchAll(/(?:href|src)="(\/[^"]+\.(?:css|js)[^"]*)"/g)) assets.add(m[1]);
const shell = await get('/shell.json');
if (shell.status !== 200) bad('/shell.json', `HTTP ${shell.status}`);
else for (const u of await shell.json()) assets.add(u);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-smoke-'));
let n = 0;
const queue = [...assets];
await Promise.all(Array.from({ length: 8 }, async () => {
  while (queue.length) {
    const u = queue.shift();
    checked++;
    const r = await get(u);
    if (r.status !== 200) { bad(u, `HTTP ${r.status || r.error}`); continue; }
    const body = await r.text();
    if (!body.trim()) { bad(u, 'empty'); continue; }
    if (/\.js(\?|$)/.test(u)) {
      const f = path.join(dir, `m${n++}.mjs`);
      fs.writeFileSync(f, body);
      const c = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
      if (c.status !== 0) bad(u, `not valid JavaScript: ${(c.stderr || '').split('\n').find((l) => /Error/.test(l)) || ''}`);
    }
  }
}));
fs.rmSync(dir, { recursive: true, force: true });

// 3. the API refuses a stranger cleanly (no server errors)
for (const p of ['/api/me', '/api/chats', '/api/admin/me', '/api/admin/users']) {
  checked++;
  const r = await get(p);
  if (![401, 403].includes(r.status)) bad(p, `without a login expected 401/403, got ${r.status || r.error}`);
}

// 4. the update files that the apps look at
const yml = await get('/downloads/latest.yml');
checked++;
if (yml.status === 200) {
  const text = await yml.text();
  const file = /^path:\s*(\S+)/m.exec(text)?.[1];
  if (file) {
    const head = await get(`/downloads/${encodeURIComponent(file)}`, { method: 'HEAD' });
    if (head.status !== 200) bad(`/downloads/${file}`, `named in latest.yml but HTTP ${head.status}`);
  } else bad('/downloads/latest.yml', 'has no path');
} else bad('/downloads/latest.yml', `HTTP ${yml.status}`);

// 5. the live connection: a stranger is turned away at once, not left hanging
checked++;
await new Promise((resolve) => {
  const url = `${BASE.replace(/^http/, 'ws')}/ws`;
  let done = false;
  const finish = (why) => { if (done) return; done = true; if (why) bad('/ws', why); try { ws.terminate(); } catch { /* closed */ } resolve(); };
  const ws = new WebSocket(url, { handshakeTimeout: 10_000 });
  ws.on('unexpected-response', () => finish(''));   // refused with an HTTP status: fine
  ws.on('close', () => finish(''));
  ws.on('error', () => finish(''));
  ws.on('open', () => setTimeout(() => finish(''), 1500));   // opened and then closed by the server after a moment: also fine
  setTimeout(() => finish('no answer in 12 s'), 12_000);
});

// 6. the way pages are served
for (const [p, header] of [['/', 'content-security-policy'], ['/admin.html', 'content-security-policy']]) {
  checked++;
  const r = await get(p);
  if (!r.headers.get(header)) bad(p, `no ${header} header`);
}

console.log(`${BASE}: ${checked} checks, ${problems.length ? `${problems.length} problems` : 'all fine'}`);
for (const p of problems) console.log(` ✖ ${p}`);
process.exit(problems.length ? 1 : 0);
