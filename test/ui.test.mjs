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

let dataDir;
before(async () => {
  if (!canRun) return;
  const env = {
    ...process.env, PORT: String(PORT), HOST: '127.0.0.1', NODE_ENV: 'development', OTP_MODE: 'dev', LOG_LEVEL: 'error', OTP_REQUESTS_PER_IP: '300',
    DATA_DIR: (dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'suhbat-ui-'))), SUPERADMIN_PHONES: ADMIN_PHONE,
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
    const headTop = await page.$eval('.adm-head', (e) => Math.round(e.getBoundingClientRect().top));
    const sideH = await page.$eval('.adm-side', (e) => Math.round(e.getBoundingClientRect().height));
    assert.ok(headTop - sideH < 40, `a short page starts right under the menu, not far below it (gap ${headTop - sideH})`);
    await page.click('.chips .chip:has-text("Группы")');
    assert.match(await page.textContent('.achats'), /Семья/);
    await page.click('.chips .chip:has-text("Личные")');
    await page.click('.achat:has-text("Любимый")');
    await page.waitForSelector('.abub');
    assert.ok((await page.$$('.abub')).length >= 5);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: voice messages look like Telegram, the player shows who and when, goes on to the next by itself, and keeps playing when the section changes', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/chat/${seed.chat}`);
    await page.waitForSelector('.avm');
    assert.equal(await page.$$eval('.avm-wave i', (b) => b.length > 20), true, 'a waveform is drawn');
    assert.equal(await page.$$eval('audio.abub-audio', (a) => a.length), 0, 'no grey browser players');
    await page.locator('.avm .avm-play').first().click();
    await page.waitForSelector('.apl:not([hidden])');
    assert.equal(await page.$eval('.apl', (e) => e.parentElement.className), 'adm-side', 'on a phone the player is in the top bar, always in view');
    const top = await page.$eval('.apl', (e) => Math.round(e.getBoundingClientRect().top));
    assert.ok(top >= 0 && top < 200, `and in view (${top})`);
    assert.match(await page.textContent('.apl-who'), /Мадина|Любимый/);
    assert.equal(await page.$eval('.avm.act .avm-play', (b) => b.textContent), '⏸', 'the message that plays shows pause');
    if (process.env.UI_SHOT) await page.screenshot({ path: process.env.UI_SHOT });
    // a tap near the end of the waveform: the message ends and the next one starts by itself
    const box = await page.locator('.avm-wave').first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.98, box.y + box.height / 2);
    await page.waitForFunction(() => { const a = document.querySelectorAll('.avm'); return !a[0].classList.contains('act') && a[1]?.classList.contains('act'); }, null, { timeout: 8000 });
    // another section: the sound and the bar stay
    await page.evaluate(() => { location.hash = '#/overview'; });
    await page.waitForFunction(() => !document.querySelector('.avm'), null, { timeout: 8000 });
    assert.equal(await page.$eval('.apl', (e) => e.hidden), false, 'the bar is still there');
    assert.match(await page.textContent('.apl-who'), /Мадина|Любимый/);
    assert.ok(await page.$eval('.apl', (e) => e.isConnected && e.getBoundingClientRect().height > 0), 'and visible');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: the gallery of a conversation on a phone: icon buttons, square pictures, two fingers change their size', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/chat/${seed.chat}`);
    await page.waitForSelector('.tbtn');
    const w = await page.$$eval('.tbtn', (b) => b.map((x) => Math.round(x.getBoundingClientRect().width)));
    assert.ok(w.length >= 4 && w.every((x) => x === 44), `icon buttons only, no text, on a phone (search, filters, download, media, summary): ${w}`);
    await page.click('.tbtn[aria-label="Медиа и файлы"]');
    await page.click('.amedia-row:has-text("фотографий")');
    await page.waitForSelector('.agal .agal-item img');
    assert.equal(await page.$eval('.aconv.agal', (e) => e.dataset.cols), '3');
    const box = await page.$eval('.agal-item img', (i) => { const r = i.getBoundingClientRect(); return Math.abs(r.width - r.height) < 2; });
    assert.equal(box, true, 'square pictures');
    const pinch = (d0, d1) => page.evaluate(([a, b]) => {
      const el = document.querySelector('.aconv.agal');
      const t = (id, x) => new Touch({ identifier: id, target: el, clientX: x, clientY: 400 });
      const ev = (type, xs) => el.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: xs.map((x, i) => t(i, x)), targetTouches: xs.map((x, i) => t(i, x)), changedTouches: xs.map((x, i) => t(i, x)) }));
      ev('touchstart', [195 - a / 2, 195 + a / 2]);
      ev('touchmove', [195 - b / 2, 195 + b / 2]);
      ev('touchend', []);
    }, [d0, d1]);
    await pinch(100, 160);   // fingers apart: bigger pictures, fewer in a row
    assert.equal(await page.$eval('.aconv.agal', (e) => e.dataset.cols), '2');
    await pinch(160, 90);    // fingers together: smaller
    assert.equal(await page.$eval('.aconv.agal', (e) => e.dataset.cols), '3');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: copied older history takes its place by the time without redrawing the page or moving what is being read', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/chat/${seed.chat}`);
    await page.waitForSelector('.abub');
    await page.waitForTimeout(1200);
    const first = await page.$eval('.abub', (e) => e.dataset.id);
    await page.evaluate(() => window.scrollTo(0, 300));   // reading somewhere in the middle
    await page.waitForTimeout(300);
    const gap = await page.evaluate(() => document.querySelector('.achat-who').getBoundingClientRect().top - document.querySelector('.adm-side').getBoundingClientRect().bottom);
    assert.ok(Math.abs(gap) <= 2, `the bar of the chat sticks right under the menu, no gap (${gap}px)`);
    const mark = await page.evaluate(() => { const el = [...document.querySelectorAll('.abub')].find((e) => e.getBoundingClientRect().top > 100); el.dataset.keep = '1'; return { id: el.dataset.id, top: Math.round(el.getBoundingClientRect().top) }; });
    // a message that the copy of a Telegram chat adds later, with an older time than the first one
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'suhbat.db'));
    const f = db.prepare('SELECT created_at, sender_id FROM messages WHERE id = ?').get(Number(first));
    db.prepare("INSERT INTO messages (chat_id, sender_id, kind, text, created_at) VALUES (?, ?, 'text', 'самое раннее', ?)").run(seed.chat, f.sender_id, f.created_at - 86400000);
    db.close();
    await page.waitForFunction(() => [...document.querySelectorAll('.abub')].some((e) => e.textContent.includes('самое раннее')), null, { timeout: 12000 });
    const after = await page.evaluate(() => { const el = document.querySelector('[data-keep="1"]'); return el ? Math.round(el.getBoundingClientRect().top) : null; });
    assert.notEqual(after, null, 'the page was not redrawn: the same element is still there');
    assert.ok(Math.abs(after - mark.top) <= 2, `the place being read did not move (${mark.top} -> ${after})`);
    assert.equal(await page.$eval('.abub', (e) => e.textContent.includes('самое раннее')), true, 'and it stands first, by its time');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: the summary window fits a phone screen', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/chat/${seed.chat}`);
    await page.waitForSelector('.tbtn');
    await page.click('.tbtn[aria-label="Сводка"]');
    await page.waitForSelector('.asum');
    const r = await page.$eval('.asum', (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: innerWidth, sw: document.documentElement.scrollWidth }; });
    assert.ok(r.l >= 0 && r.r <= r.w + 1, `the window is inside the screen: ${JSON.stringify(r)}`);
    assert.ok(r.sw <= r.w + 1, 'the page does not scroll sideways');
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

// ---------------------------------------------------------------- everything, on a phone and on a computer
const VIEWPORTS = [['phone', { width: 390, height: 800 }, true], ['computer', { width: 1280, height: 800 }, false]];
async function watchedPage(cookieStr, [, viewport, touch]) {
  const ctx = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch, deviceScaleFactor: 1 });
  await ctx.addCookies(cookiesOf(cookieStr));
  const page = await ctx.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`script error: ${e}`));
  // a screen must never make the server fail: no 5xx from the API on any of them
  page.on('response', (r) => { if (r.status() >= 500 && r.url().includes('/api/')) problems.push(`server error ${r.status()} on ${new URL(r.url()).pathname}`); });
  return { ctx, page, problems };
}

test('messenger: the app is in the share list of other apps (web share target): the shared file waits, the person picks the chat and it is sent', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.madina);
  try {
    const manifest = await (await fetch(`${BASE}/manifest.webmanifest`)).json();
    assert.equal(manifest.share_target.action, '/share-target');
    assert.equal(manifest.share_target.method, 'POST');
    await open('/');
    await page.waitForSelector('.chatlist .ci');
    await page.evaluate(async () => { await navigator.serviceWorker.ready; await new Promise((r) => (navigator.serviceWorker.controller ? r() : navigator.serviceWorker.addEventListener('controllerchange', r))); });
    // what another app does: a POST with the file (the service worker answers it)
    await page.evaluate(async () => {
      const fd = new FormData();
      fd.append('title', 'Подпись');
      fd.append('files', new File([new Uint8Array([137, 80, 78, 71])], 'shared-from-another-app.png', { type: 'image/png' }));
      await fetch('/share-target', { method: 'POST', body: fd, redirect: 'manual' });
    });
    await page.goto(`${BASE}/?shared=1`);
    await page.waitForSelector('.ws-list .cal-row', { timeout: 15000 });
    assert.match(await page.textContent('.modal-body'), /shared-from-another-app\.png/);
    assert.equal(await page.evaluate(() => location.search), '', 'the address is clean again');
    await page.click(`.ws-list .cal-row:has-text("Любимый")`);
    await page.waitForFunction(async ([id]) => { const r = await fetch(`/api/chats/${id}/messages?limit=5`); const j = await r.json(); return j.messages.some((m) => m.file?.name?.includes('shared-from-another-app') || m.kind === 'image' && m.created_at > Date.now() - 60000 && m.text === 'Подпись'); }, [seed.chat], { timeout: 15000 }).catch(() => {});
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('messenger: voice messages have a waveform and a round button, the player goes to the next by itself and keeps going in another chat', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.madina);
  try {
    await open('/');
    await page.waitForSelector('.chatlist .ci');
    await page.click(`.ci[data-chat-id="${seed.chat}"]`);
    await page.waitForSelector('.voice');
    assert.equal(await page.$$eval('.voice .voice-wave i', (b) => b.length > 20), true, 'a waveform');
    await page.locator('.voice .voice-play').first().click();
    await page.waitForSelector('.gplayer');
    if (process.env.UI_SHOT2) await page.screenshot({ path: process.env.UI_SHOT2 });
    const box = await page.locator('.voice .voice-wave').first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.98, box.y + box.height / 2);
    await page.waitForFunction(() => { const v = document.querySelectorAll('.voice'); return !v[0].classList.contains('playing') && v[1]?.classList.contains('playing'); }, null, { timeout: 8000 });
    // another chat: the player stays and goes on
    await page.goBack().catch(() => {});
    await page.waitForSelector('.chatlist .ci', { state: 'attached' });
    assert.ok(await page.$('.gplayer'), 'the player is still there after leaving the chat');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

for (const vp of VIEWPORTS) {
  test(`admin, ${vp[0]}: every section opens, shows its content and makes no errors`, { skip: !canRun }, async () => {
    const { ctx, page, problems } = await watchedPage(seed.admin, vp);
    try {
      for (const tab of ['overview', 'users', 'admins', 'reports', 'chats', 'journal', 'server', 'access', 'quality']) {
        await page.goto(`${BASE}/admin.html#/${tab}`);
        await page.waitForSelector('.adm-view > *', { timeout: 15000 });
        await page.waitForTimeout(700);
        const failed = await page.$('.adm-view .panel.err');
        assert.equal(failed, null, `${tab}: the screen shows an error: ${failed ? await failed.textContent() : ''}`);
        const title = await page.textContent('.adm-head h1');
        assert.ok(title && title.length > 2, `${tab}: has a title`);
        const filled = await page.$eval('.adm-view', (v) => v.innerText.trim().length);
        assert.ok(filled > 20, `${tab}: is not empty`);
      }
      // the layout: the two cards of the overview are of one height; the menu of a computer reaches its last button on a low screen
      await page.goto(`${BASE}/admin.html#/overview`);
      await page.waitForSelector('.row-2 > .panel');
      const heights = await page.$$eval('.row-2 > .panel', (p) => p.map((x) => Math.round(x.getBoundingClientRect().height)));
      if (!vp[2]) {
        assert.equal(heights[0], heights[1], `overview cards: ${heights}`);
        await page.setViewportSize({ width: 1280, height: 600 });
        await page.waitForTimeout(300);
        await page.$eval('.adm-side', (e) => { e.scrollTop = e.scrollHeight; });
        const back = await page.$eval('.adm-back', (e) => { const r = e.getBoundingClientRect(); return r.bottom <= innerHeight + 1 && r.top >= 0; });
        assert.equal(back, true, 'the way back to the messenger is in view on a low screen');
        await page.setViewportSize({ width: 1280, height: 800 });
      }
      // the administrators: on a phone a folded list, one card opens at a time; on a computer every card is open
      await page.goto(`${BASE}/admin.html#/admins`);
      await page.waitForSelector('.aperm-card');
      const open = await page.$$eval('.aperm-card', (c) => c.map((x) => x.open));
      if (vp[2]) assert.ok(open.every((x) => !x), 'folded on a phone'); else assert.ok(open.every((x) => x), 'open on a computer');
      // a person, a chat, and a person's page
      await page.goto(`${BASE}/admin.html#/chats`);
      await page.waitForSelector('.achat');
      await page.click('.achat:has-text("Мадина")');
      await page.waitForSelector('.achat');
      await page.click('.achat:has-text("Любимый")');
      await page.waitForSelector('.abub');
      await page.goto(`${BASE}/admin.html#/user/${seed.madinaId}`);
      await page.waitForSelector('.adm-view h2', { timeout: 15000 });
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });

  test(`messenger, ${vp[0]}: the list, a chat, sending a message and the colours work and make no errors`, { skip: !canRun }, async () => {
    const { ctx, page, problems } = await watchedPage(seed.madina, vp);
    try {
      await page.goto(`${BASE}/`);
      await page.waitForSelector('.chatlist .ci');
      // a chat opens and a message is sent from the composer; it reaches the server
      await page.click(`.ci[data-chat-id="${seed.chat}"]`);
      await page.waitForSelector('textarea');
      const text = `проверка ${vp[0]} ${Date.now()}`;
      await page.fill('textarea', text);
      if (vp[2]) await page.click('.send-btn'); else await page.keyboard.press('Enter');   // on a phone Enter is a new line
      await page.waitForSelector(`.messages .bubble:has-text("${text}")`, { timeout: 10000 });
      const stored = (await call(seed.madina, 'GET', `/api/chats/${seed.chat}/messages`)).data.messages.map((m) => m.text);
      assert.ok(stored.includes(text), 'the message is saved on the server');
      // the colours: every one applies and changes the accent
      const accents = new Set();
      for (const pal of ['gold', 'ocean', 'violet', 'forest', 'rose', 'graphite']) {
        await page.evaluate((p) => { const s = JSON.parse(localStorage.getItem('suhbat.prefs') || '{}'); s.palette = p; localStorage.setItem('suhbat.prefs', JSON.stringify(s)); }, pal);
        await page.reload();
        await page.waitForSelector('.chatlist .ci', { state: 'attached' });   // on a phone the open chat hides the list
        const got = await page.evaluate(() => ({ p: document.documentElement.dataset.palette || 'gold', brand: getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() }));
        assert.equal(got.p, pal, `the ${pal} colours are applied`);
        accents.add(got.brand);
      }
      assert.equal(accents.size, 6, 'the six palettes have six different accents');
      assert.deepEqual(problems, []);
    } finally { await ctx.close(); }
  });
}

test('messenger on a phone: the bottom menu opens every screen, and the settings rows open one by one', { skip: !canRun }, async () => {
  const { ctx, page, problems } = await watchedPage(seed.madina, VIEWPORTS[0]);
  try {
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.bottomnav button');
    const n = (await page.$$('.bottomnav button')).length;
    assert.ok(n >= 4, `the bottom menu has its buttons (${n})`);
    for (let i = 0; i < n; i++) {
      await page.goto(`${BASE}/`);
      await page.waitForSelector('.bottomnav button');
      await (await page.$$('.bottomnav button'))[i].click();
      await page.waitForTimeout(600);
      await page.keyboard.press('Escape');
    }
    await page.goto(`${BASE}/`);
    await page.waitForSelector('.bottomnav button');
    const buttons = await page.$$('.bottomnav button');
    await buttons[buttons.length - 1].click();
    await page.waitForSelector('.srow', { timeout: 10000 });
    const rows = (await page.$$('.srow')).length;
    assert.ok(rows >= 8, `the settings have their rows (${rows})`);
    for (let i = 0; i < rows; i++) {
      const row = (await page.$$('.srow'))[i];
      if (!row) break;
      if (await row.evaluate((e) => e.classList.contains('danger'))) continue;   // log out and the like are not walked into
      await row.click();
      await page.waitForTimeout(350);
      const back = await page.$('.settings-back, .modal-back, [aria-label="Назад"], [aria-label="Back"], .icon-btn.back');
      if (back) await back.click(); else await page.keyboard.press('Escape');
      await page.waitForTimeout(250);
      if (!(await page.$('.srow'))) {
        await page.goto(`${BASE}/`);
        await page.waitForSelector('.bottomnav button');
        await (await page.$$('.bottomnav button')).at(-1).click();
        await page.waitForSelector('.srow');
      }
    }
    assert.deepEqual(problems, []);
  } finally { await ctx.close(); }
});

test('admin: the chats of a person can be searched by name and by kind (personal, groups, channels)', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/user/${seed.madinaId}`);
    await page.waitForSelector('.ud-chatbar input');
    assert.ok((await page.$$('.ud-chats .ud-chat')).length >= 4, 'all the chats of the person');
    await page.fill('.ud-chatbar input', 'сем');
    assert.equal((await page.$$('.ud-chats .ud-chat')).length, 1, 'found by a part of the name');
    assert.match(await page.textContent('.ud-chats'), /Семья/);
    await page.fill('.ud-chatbar input', '');
    await page.click('.ud-kind:has-text("Каналы")');
    assert.match(await page.textContent('.ud-chats'), /Новости/);
    assert.equal((await page.$$('.ud-chats .ud-chat')).length, 1, 'only channels');
    await page.fill('.ud-chatbar input', 'нет такого');
    assert.match(await page.textContent('.ud-chats'), /Ничего не найдено/);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: a word is looked for IN the conversation (all messages stay, the word is marked, arrows go between the places), and the search stays in sight', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/chat/${seed.chat}`);
    await page.waitForSelector('.achat-who .tbtn[aria-label="Поиск по чату"]');
    await page.waitForSelector('.abub');
    const all = (await page.$$('.abub')).length;
    assert.ok(all >= 10, `the whole conversation is shown first (${all})`);
    // search, filters and download are icons in the top bar, between Back and Media
    const order = await page.evaluate(() => [...document.querySelectorAll('.achat-who > *')].map((e) => e.getAttribute('aria-label') || e.firstElementChild?.getAttribute('aria-label') || e.className));
    const at = (s) => order.findIndex((x) => String(x).includes(s));
    assert.ok(at('Назад') < at('Поиск по чату') && at('Поиск по чату') < at('Фильтры') && at('Фильтры') < at('Медиа и файлы'), `the order of the bar: ${order.join(' | ')}`);
    assert.ok(!(await page.isVisible('.achat-find')), 'the field is closed until the search icon is pressed');
    await page.click('.achat-who .tbtn[aria-label="Поиск по чату"]');
    await page.waitForSelector('.achat-find input', { state: 'visible' });
    await page.fill('.achat-find input', 'сообщение 1');
    await page.waitForFunction(() => /из \d+/.test(document.querySelector('.achat-count')?.textContent || ''), null, { timeout: 10000 });
    assert.ok((await page.$$('.abub')).length >= all, 'the other messages are not hidden');
    assert.ok((await page.$$('.abub-text mark')).length >= 1, 'the word is marked');
    assert.match(await page.textContent('.abub-text mark'), /сообщение 1/i);
    const top = await page.evaluate(() => document.querySelector('.achat-find').getBoundingClientRect().top);
    assert.ok(top >= 0 && top < 400, `the search is in sight (top ${top})`);
    await page.evaluate(() => window.scrollBy(0, 400));
    const still = await page.evaluate(() => document.querySelector('.achat-find').getBoundingClientRect().top);
    assert.ok(still >= 0 && still < 400, `and stays in sight after scrolling (${still})`);
    await page.click('.achat-who .afilters > summary');
    assert.ok(await page.isVisible('.afilters-body'), 'the filters open as a sheet');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'hidden', 'the page behind does not scroll while the sheet is open');
    const sheet = await page.evaluate(() => { const r = document.querySelector('.afilters-body').getBoundingClientRect(); return { bottom: Math.round(r.bottom), h: innerHeight, top: Math.round(r.top) }; });
    assert.ok(sheet.bottom <= sheet.h && sheet.top >= 0, `the sheet is inside the screen (${JSON.stringify(sheet)})`);
    await page.click('.afilters-head .btn');
    assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).overflow), 'visible', 'closed: the page scrolls again');
    await page.fill('.achat-find input', 'такого слова нет нигде');
    await page.waitForFunction(() => document.querySelector('.achat-count')?.textContent === 'Нет', null, { timeout: 10000 });
    assert.equal((await page.$$('.abub-text mark')).length, 0);
    assert.ok((await page.$$('.abub')).length >= all, 'nothing found, the conversation is whole');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: the bar of a conversation has a Back button, and going back returns to the same place of the list, not to its top', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/user/${seed.madinaId}`);
    await page.waitForSelector('.ud-chats .ud-chat');
    await page.evaluate(() => window.scrollTo(0, 300));
    const before = await page.evaluate(() => Math.round(window.scrollY));
    assert.ok(before >= 200, `the page of a person is long enough and was scrolled (${before})`);
    await page.evaluate(() => document.querySelector('.ud-chats .ud-chat').click());
    await page.waitForSelector('.achat-who .acw-back');
    assert.ok(await page.isVisible('.achat-who .acw-back'), 'the Back button is in the bar');
    await page.click('.achat-who .acw-back');
    await page.waitForSelector('.ud-chats .ud-chat');
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => ({ y: Math.round(window.scrollY), max: document.documentElement.scrollHeight - innerHeight }));
    assert.ok(Math.abs(after.y - before) <= 2, `returned to the same place (${after.y} instead of ${before}, page allows ${after.max})`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('messenger: the search opens like in Telegram (frequent contacts, tabs), remembers what was opened, and a picture opens whole', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.madina);
  try {
    await open('/');
    await page.waitForSelector('.chatlist .ci');
    await page.evaluate(() => document.querySelector('.search input').focus());
    await page.waitForSelector('.stabs .stab');
    assert.equal((await page.$$('.stabs .stab')).length, 6, 'six tabs');
    assert.ok(await page.$('.sp-frequent button'), 'frequent contacts');
    await page.click('.sp-frequent button');   // opens that chat and remembers it
    await page.waitForSelector('.bubble');
    assert.ok(await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('suhbat.recentsearch.') && localStorage.getItem(k).includes('"chat"'))), 'remembered');
    await open('/');
    await page.waitForSelector('.chatlist .ci');
    await page.evaluate(() => document.querySelector('.search input').focus());
    await page.waitForSelector('.sp-head');
    assert.match(await page.textContent('.chatlist'), /Недавние/);
    await page.click('.stab:has-text("Фото")');
    await page.waitForSelector('.chatlist .ci, .chatlist .empty');
    // a picture shown whole: inside the screen, no scrollbars
    await page.evaluate(async () => { const { lightbox } = await import('/js/ui.js'); const c = document.createElement('canvas'); c.width = 1600; c.height = 2400; c.getContext('2d').fillRect(0, 0, 1600, 2400); lightbox(c.toDataURL('image/png')); });
    await page.waitForSelector('.lb-wrap img');
    const box = await page.$eval('.lb-wrap img', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: innerWidth, h: innerHeight }; });
    assert.ok(box.l >= 0 && box.r <= box.w && box.t >= 0 && box.b <= box.h, JSON.stringify(box));
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('messenger: pictures sent together are one album block; several chosen files go as one album', { skip: !canRun }, async () => {
  const me = await login('+998900021041', 'Альбомщик');
  const mate = await login('+998900021042', 'Приёмщик');
  const chat = (await call(me.cookie, 'POST', '/api/chats/direct', { user_id: mate.data.user.id })).data.chat;
  const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${BASE}/api/chats/${chat.id}/files?name=a${i}.jpg&album=album-ui-key-1`, { method: 'POST', headers: { cookie: me.cookie, 'content-type': 'image/jpeg' }, body: JPEG });
    assert.equal(r.status, 201);
  }
  const { ctx, page, errors, open } = await phonePage(me.cookie);
  try {
    await open('/');
    await page.waitForSelector('.chatlist .ci');
    await page.click('.chatlist .ci:has-text("Приёмщик")');
    await page.waitForSelector('.malb .malb-t');
    assert.equal((await page.$$('.malb')).length, 1, 'one album block');
    assert.equal((await page.$$('.malb .malb-t')).length, 3, 'three pictures in it');
    assert.equal((await page.$$('.bubble .media-btn')).length, 0, 'no separate picture bubbles');
    // choosing several files at once: one window, they go as one album
    await page.setInputFiles('input[type=file]', [1, 2, 3, 4].map((n) => ({ name: `pick${n}.png`, mimeType: 'image/png', buffer: png(40 + n, 60) })));
    await page.waitForSelector('.malb-prev .malb-prev-t');
    assert.equal((await page.$$('.malb-prev .malb-prev-t')).length, 4, 'all four are in the window');
    await page.click('.modal .btn:has-text("Отправить альбом")');
    const ok = await page.waitForFunction(async (id) => {
      const j = await (await fetch(`/api/chats/${id}/messages?limit=30`)).json();
      const keys = {};
      for (const m of j.messages) if (m.album && m.album !== 'album-ui-key-1') keys[m.album] = (keys[m.album] || 0) + 1;
      return Object.values(keys).some((n) => n === 4);
    }, chat.id, { timeout: 30000 }).then(() => true).catch(() => false);
    assert.ok(ok, 'the four pictures went with one album key');
    await page.waitForFunction(() => document.querySelectorAll('.malb').length === 2, null, { timeout: 15000 });
    assert.equal((await page.$$('.malb-n4')).length, 1, 'the new album is a 2x2 block');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('messenger: passing a message on to a group with topics asks which topic, like Telegram', { skip: !canRun }, async () => {
  const lola = await login('+998900021031', 'Нигора');
  const mate = await login('+998900021032', 'Рустам');
  const grp = (await call(lola.cookie, 'POST', '/api/chats', { type: 'group', title: 'Снабжение', member_ids: [mate.data.user.id] })).data.chat;
  assert.equal((await call(lola.cookie, 'POST', `/api/chats/${grp.id}/forum`, { on: true })).status, 200);
  await call(lola.cookie, 'POST', `/api/chats/${grp.id}/topics`, { title: 'Дефицит', emoji: '' });
  const second = (await call(lola.cookie, 'POST', `/api/chats/${grp.id}/topics`, { title: 'Склад приход', emoji: '' })).data.topic;
  const direct = (await call(lola.cookie, 'POST', '/api/chats/direct', { user_id: mate.data.user.id })).data.chat;
  await call(lola.cookie, 'POST', `/api/chats/${direct.id}/messages`, { text: 'накладная для пересылки' });
  const { ctx, page, errors, open } = await phonePage(lola.cookie);
  try {
    await open('/');
    await page.waitForSelector('.chatlist .ci');
    await page.click('.chatlist .ci:has-text("Рустам")');
    await page.click('.bubble:has-text("накладная для пересылки")', { button: 'right' });
    await page.click('text=Переслать');
    await page.waitForSelector('.fwd-row');
    await page.click('.fwd-row:has-text("Снабжение")');
    await page.waitForSelector('.fwd-topics .fwd-topic:has-text("Склад приход")');
    assert.ok((await page.$$('.fwd-topics .fwd-topic')).length >= 3, 'General and both topics are offered');
    await page.click('.fwd-topic:has-text("Склад приход")');
    await page.click('.fwd-modal .btn:has-text("Передать")');
    const ok = await page.waitForFunction(async ([id, tid]) => {
      const j = await (await fetch(`/api/chats/${id}/messages?limit=10&topic=${tid}`)).json();
      return j.messages.some((m) => m.text === 'накладная для пересылки');
    }, [grp.id, second.id], { timeout: 15000 }).then(() => true).catch(() => false);
    assert.ok(ok, 'the message landed in the chosen topic');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: older messages are put in front of the page; the ones already there are not built again and the place being read stays', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    const made = await call(seed.madina, 'POST', '/api/chats', { type: 'group', title: 'Длинная переписка', members: [] });
    const chat = (await call(seed.madina, 'GET', '/api/chats')).data.chats.find((c) => c.title === 'Длинная переписка')?.id;
    assert.ok(chat, `the long conversation exists (${made.status})`);
    for (let i = 1; i <= 230; i++) {
      const r = await call(seed.madina, 'POST', `/api/chats/${chat}/messages`, { text: `сообщение ${i}` });
      if (r.status >= 300) { await new Promise((x) => setTimeout(x, 50)); i--; }
    }
    await open(`/admin.html#/chat/${chat}`);
    await page.waitForSelector('.abub');
    const before = await page.$$eval('.abub', (b) => b.length);
    assert.ok(before >= 50 && before <= 120, `the newest part first (${before})`);
    await page.evaluate(() => { document.querySelectorAll('.abub').forEach((e, i) => { e.__same = i; }); });
    await page.click('button:has-text("Загрузить более ранние")');
    await page.waitForFunction((n) => document.querySelectorAll('.abub').length > n, before);
    const kept = await page.$$eval('.abub', (b) => b.filter((e) => e.__same !== undefined).length);
    assert.ok(kept >= before - 1, `the bubbles that were there are the same elements (${kept} of ${before})`);
    const ids = await page.$$eval('.abub', (b) => b.map((e) => Number(e.dataset.id)));
    assert.deepEqual(ids, [...ids].sort((x, y) => x - y), 'in order');
    assert.equal(new Set(ids).size, ids.length, 'no message twice');
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});

test('admin: a script of somebody else that fails to load (the statistics script of the tunnel) does not make the page reload again and again', { skip: !canRun }, async () => {
  const { ctx, page, open } = await phonePage(seed.admin);
  try {
    let loads = 0;
    page.on('load', () => { loads += 1; });
    await open('/admin.html#/overview');
    await page.waitForSelector('.adm-side, .abub, #admin-root > *');
    await page.evaluate(() => { const s = document.createElement('script'); s.src = 'https://static.example.invalid/beacon.min.js'; document.head.append(s); });
    await page.waitForTimeout(1500);
    assert.equal(loads, 1, 'the page was loaded once and stayed');
  } finally { await ctx.close(); }
});

test('admin: the bar of a personal conversation shows how to reach each side (the phone number, else the nickname)', { skip: !canRun }, async () => {
  const { ctx, page, errors, open } = await phonePage(seed.admin);
  try {
    await open(`/admin.html#/chat/${seed.chat}`);
    await page.waitForSelector('.achat-who .acw-contact');
    const lines = await page.$$eval('.achat-who .acw-contact', (e) => e.map((x) => x.textContent));
    assert.ok(lines.length >= 1 && lines.every((t) => /^(\+\d{6,}|@\w+)$/.test(t)), `a phone or a nickname under the name (${lines})`);
    assert.deepEqual(errors, []);
  } finally { await ctx.close(); }
});
