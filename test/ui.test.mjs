// The screens, in a real browser at the size of a phone: the admin menu, the people and their chats, swiping through the sections,
// the player of voice messages, turning a picture, and the chat list of the messenger. Skipped when there is no browser on the machine
// (set UI_TEST_BROWSER to a Chrome / Edge / Chromium executable to choose one).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import zlib from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 21200; // its own range of ten ports: test files run side by side
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN_PHONE = '+998900021001';

function findBrowser() {
  const env = process.env.UI_TEST_BROWSER;
  const home = os.homedir();
  const cands = [
    env,
    process.env.PLAYWRIGHT_CHROMIUM,
    ...['chromium-1243', 'chromium-1200', 'chromium-1181'].map((d) => path.join(home, 'AppData/Local/ms-playwright', d, 'chrome-win64/chrome.exe')),
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}
const browserPath = findBrowser();
let chromium = null;
try { ({ chromium } = await import('playwright-core')); } catch { /* not installed: skipped */ }
const canRun = !!(browserPath && chromium);

let server; let browser; let seed;

async function call(cookie, method, url, body, headers = {}) {
  const r = await fetch(BASE + url, { method, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const cookies = (r.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
  return { status: r.status, data: await r.json().catch(() => ({})), cookie: cookies };
}
async function login(phone, name) {
  const a = await call('', 'POST', '/api/auth/request', { phone });
  return call('', 'POST', '/api/auth/verify', { phone, code: a.data.dev_code, name });
}
function wav(sec) {
  const rate = 8000; const n = rate * sec; const b = Buffer.alloc(44 + n);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate, 28); b.writeUInt16LE(1, 32); b.writeUInt16LE(8, 34); b.write('data', 36); b.writeUInt32LE(n, 40);
  for (let i = 0; i < n; i++) b[44 + i] = 128 + Math.round(60 * Math.sin(i / 8));
  return b;
}
// a tall picture made without any library: a PNG of one colour
function png(w, h) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = 40; raw[o + 1] = 90; raw[o + 2] = 200; } }
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

before(async () => {
  if (!canRun) return;
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', OTP_REQUESTS_PER_IP: '300',
    DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-ui-')), SUPERADMIN_PHONES: ADMIN_PHONE,
  };
  delete env.NODE_OPTIONS; delete env.NODE_TEST_CONTEXT;
  server = spawn(process.execPath, ['server/src/index.js'], { cwd: root, env, stdio: 'inherit' });
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${BASE}/healthz`)).ok) break; } catch { /* starting */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  // people and chats: two personal chats, a group and a channel, voice messages and a tall picture
  const root0 = await login(ADMIN_PHONE, 'Админ');
  await call(root0.cookie, 'PUT', '/api/admin/credentials', { login: 'uitester', password: 'a-long-ui-test-password' });
  const adminSession = await call('', 'POST', '/api/auth/admin-login', { login: 'uitester', password: 'a-long-ui-test-password' });
  const a = await login('+998900021011', 'Мадина');
  const b = await login('+998900021012', 'Любимый');
  const c = await login('+998900021013', 'Умиджон');
  const d1 = (await call(a.cookie, 'POST', '/api/chats/direct', { user_id: b.data.user.id })).data.chat;
  await call(a.cookie, 'POST', '/api/chats/direct', { user_id: c.data.user.id });
  await call(a.cookie, 'POST', '/api/chats', { type: 'group', title: 'Семья', member_ids: [b.data.user.id, c.data.user.id] });
  await call(a.cookie, 'POST', '/api/chats', { type: 'channel', title: 'Новости', member_ids: [b.data.user.id] });
  for (let i = 0; i < 3; i++) {
    await call(a.cookie, 'POST', `/api/chats/${d1.id}/messages`, { text: `сообщение ${i}` });
    const r = await fetch(`${BASE}/api/chats/${d1.id}/files?name=voice${i}.wav&kind=voice&duration=2`, { method: 'POST', headers: { cookie: i % 2 ? b.cookie : a.cookie, 'content-type': 'audio/wav' }, body: wav(2) });
    assert.equal(r.status, 201);
  }
  const pic = await fetch(`${BASE}/api/chats/${d1.id}/files?name=tall.png`, { method: 'POST', headers: { cookie: a.cookie, 'content-type': 'image/png' }, body: png(300, 700) });
  assert.equal(pic.status, 201);
  for (let i = 0; i < 12; i++) await call(a.cookie, 'POST', `/api/chats/${d1.id}/messages`, { text: `текст ${i}` });
  seed = { admin: adminSession.cookie, madina: a.cookie, chat: d1.id, madinaId: a.data.user.id };
  browser = await chromium.launch({ executablePath: browserPath, args: ['--autoplay-policy=no-user-gesture-required', '--no-sandbox'] });
});
after(async () => { await browser?.close(); server?.kill(); });

const cookiesOf = (str) => str.split('; ').filter(Boolean).map((p) => { const i = p.indexOf('='); return { name: p.slice(0, i), value: p.slice(i + 1), domain: '127.0.0.1', path: '/' }; });
async function phonePage(cookieStr, hash = '') {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  await ctx.addCookies(cookiesOf(cookieStr));
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return { ctx, page, errors, open: (url) => page.goto(`${BASE}${url}`) };
}
// a swipe made of touch events (the page listens to touchstart / touchend), optionally with something done in between
const swipe = (page, selector, dx, between) => page.evaluate(([sel, dist, hasBetween]) => {
  const el = document.querySelector(sel);
  const t = (x) => new Touch({ identifier: 1, target: el, clientX: x, clientY: 500 });
  const sx = dist < 0 ? 300 : 100;
  el.dispatchEvent(new TouchEvent('touchstart', { bubbles: true, cancelable: true, touches: [t(sx)], targetTouches: [t(sx)], changedTouches: [t(sx)] }));
  if (hasBetween) document.querySelector('.tablewrap').scrollLeft = 80;
  el.dispatchEvent(new TouchEvent('touchend', { bubbles: true, cancelable: true, touches: [], targetTouches: [], changedTouches: [t(sx + dist)] }));
}, [selector, dx, !!between]);

test('admin on a phone: categories with subsections, swiping through all the sections, a wide table does not stop it', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open('/admin.html#/users');
    await page.waitForSelector('.adm-cats button');
    assert.deepEqual(await page.$$eval('.adm-cats button', (bs) => bs.map((b) => b.textContent.trim())), ['Обзор', 'Люди', 'Переписка', 'Система']);
    assert.deepEqual(await page.$$eval('.adm-subrow button', (bs) => bs.map((b) => b.textContent.trim())), ['Пользователи', 'Администраторы', 'Жалобы']);
    await page.waitForSelector('.tablewrap');
    // the table scrolled under the finger: the section stays; at rest the swipe goes on
    await swipe(page, '.tablewrap td', -150, true);
    await page.waitForTimeout(500);
    assert.equal(await page.evaluate(() => location.hash), '#/users');
    await page.evaluate(() => { document.querySelector('.tablewrap').scrollLeft = 0; });
    const seen = [];
    for (let i = 0; i < 9; i++) { await swipe(page, '.adm-view', -150); await page.waitForTimeout(600); seen.push(await page.evaluate(() => location.hash)); }
    assert.deepEqual(seen, ['#/admins', '#/reports', '#/chats', '#/journal', '#/server', '#/access', '#/quality', '#/quality', '#/quality']);
    for (let i = 0; i < 12; i++) { await swipe(page, '.adm-view', 150); await page.waitForTimeout(450); }
    assert.equal(await page.evaluate(() => location.hash), '#/overview', 'and back to the first one');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: every person is a category with personal chats, groups and channels; a chat opens', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open('/admin.html#/chats');
    await page.waitForSelector('.achat');
    const rows = await page.$$eval('.achat', (bs) => bs.map((b) => b.textContent));
    const madina = rows.find((t) => t.includes('Мадина'));
    assert.ok(madina && /Личные 2/.test(madina) && /Группы 1/.test(madina) && /Каналы 1/.test(madina), `the person line says what they have: ${madina}`);
    await page.click('.achat:has-text("Мадина")');
    await page.waitForSelector('.chips .chip');
    assert.deepEqual(await page.$$eval('.chips .chip', (bs) => bs.map((b) => b.textContent.trim())), ['Личные 2', 'Группы 1', 'Каналы 1']);
    await page.click('.chips .chip:has-text("Группы")');
    assert.match(await page.textContent('.achats'), /Семья/);
    await page.click('.chips .chip:has-text("Личные")');
    await page.click('.achat:has-text("Любимый")');
    await page.waitForSelector('.abub');
    assert.ok((await page.$$('.abub')).length >= 5);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: the player sits in the menu bar, shows who and when, and goes on to the next voice message by itself', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/chat/${seed.chat}`);
    await page.waitForSelector('audio.abub-audio');
    await page.evaluate(async () => { const a = document.querySelectorAll('audio.abub-audio')[0]; a.muted = true; a.scrollIntoView({ block: 'center' }); await a.play(); });
    await page.waitForSelector('.apl:not([hidden])');
    assert.equal(await page.$eval('.apl', (e) => e.parentElement.className), 'adm-side', 'on a phone the player is in the top bar, always in view');
    const top = await page.$eval('.apl', (e) => Math.round(e.getBoundingClientRect().top));
    assert.ok(top >= 0 && top < 200, `and in view (${top})`);
    assert.match(await page.textContent('.apl-who'), /Мадина|Любимый/);
    await page.evaluate(() => { document.querySelectorAll('audio.abub-audio')[0].currentTime = 1.8; });
    await page.waitForFunction(() => { const a = document.querySelectorAll('audio.abub-audio'); return a[0].paused && !a[1].paused; }, null, { timeout: 8000 });
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: a turned picture stays centred and inside the screen', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/chat/${seed.chat}`);
    await page.waitForSelector('img.abub-img');
    await page.evaluate(() => document.querySelector('img.abub-img').click());
    await page.waitForSelector('.alb-img');
    await page.click('.alb-turn');
    await page.waitForTimeout(400);
    const box = await page.$eval('.alb-img', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, vw: innerWidth, vh: innerHeight }; });
    assert.ok(box.l >= -1 && box.t >= -1 && box.l + box.w <= box.vw + 1 && box.t + box.h <= box.vh + 1, `inside the screen: ${JSON.stringify(box)}`);
    assert.ok(Math.abs((box.l + box.w / 2) - box.vw / 2) < 3 && Math.abs((box.t + box.h / 2) - box.vh / 2) < 3, `centred: ${JSON.stringify(box)}`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('messenger on a phone: a swipe over the chat list changes the category', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.madina);
  try {
    await open('/');
    await page.waitForSelector('.chatlist .ci');
    const sel = () => page.$eval('.tab[aria-selected=true]', (e) => e.dataset.f);
    const seen = [await sel()];
    for (const d of [-150, -150, 150, 150, 150]) { await swipe(page, '.chatlist', d); await page.waitForTimeout(350); seen.push(await sel()); }
    assert.deepEqual(seen, ['all', 'inbox', 'direct', 'inbox', 'all', 'all']);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
