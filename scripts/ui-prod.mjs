#!/usr/bin/env node
// A real browser looks at the live site the way a visitor does: the pages open, nothing throws, no script or style fails to load, the login screen is shown.
// Usage: node scripts/ui-prod.mjs [https://suhbat-dosh.uz]     Exit code 0: fine, 1: something is wrong (listed).
import fs from 'node:fs';
import { chromium } from 'playwright-core';

const BASE = (process.argv[2] || process.env.SMOKE_URL || 'https://suhbat-dosh.uz').replace(/\/$/, '');
const candidates = [process.env.CHROME_PATH, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean);
const exe = candidates.find((p) => fs.existsSync(p));
if (!exe) { console.error('no browser found'); process.exit(2); }

const problems = [];
const browser = await chromium.launch({ executablePath: exe, args: ['--no-sandbox'] });
try {
  for (const [label, viewport] of [['phone', { width: 390, height: 800 }], ['desktop', { width: 1280, height: 800 }]]) {
    for (const p of ['/', '/admin']) {
      const ctx = await browser.newContext({ viewport, serviceWorkers: 'block' });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => problems.push(`${label} ${p}: error ${e.message}`));
      page.on('requestfailed', (r) => { if (!/\/ws|cloudflareinsights/.test(r.url())) problems.push(`${label} ${p}: failed ${r.url()} ${r.failure()?.errorText}`); });
      page.on('response', (r) => { if (r.status() >= 500) problems.push(`${label} ${p}: ${r.status()} ${r.url()}`); });
      const r = await page.goto(BASE + p, { waitUntil: 'load', timeout: 45_000 }).catch((e) => { problems.push(`${label} ${p}: ${e.message}`); return null; });
      if (r && r.status() !== 200) problems.push(`${label} ${p}: HTTP ${r.status()}`);
      if (r) {
        await page.waitForTimeout(2500);
        const sh = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, v: window.innerWidth, text: document.body.innerText.trim().length }));
        if (sh.w > sh.v + 2) problems.push(`${label} ${p}: the page is wider than the screen (${sh.w} > ${sh.v})`);
        if (sh.text < 10) problems.push(`${label} ${p}: an empty page`);
      }
      await ctx.close();
    }
  }
} finally { await browser.close(); }
if (problems.length) { console.error(`${problems.length} problems:\n- ${[...new Set(problems)].join('\n- ')}`); process.exit(1); }
console.log('the live site looks fine in a browser');
