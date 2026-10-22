// Link previews: the server opens the page for the user (title, description, picture) so the person's address and device
// are never shown to the site, and shows a card in the chat. Only public internet addresses are ever contacted: names are
// resolved here and every address (also after a redirect) is checked before the connection is made.
import express from 'express';
import dns from 'node:dns';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { q } from './db.js';
import { config } from './config.js';
import { HttpError, log, now, rateLimit, sha256 } from './util.js';
import { filePath, readHead, sniff } from './files.js';

export const linkpreview = express.Router();

const MAX_HTML = 600 * 1024;
const MAX_IMG = 1.5 * 1024 * 1024;
const TTL = 7 * 86400_000;

/** True for addresses that must never be contacted on a user's behalf (own network, loopback, link-local, cloud metadata...). */
export function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(v);
    if (mapped) return isPrivateIp(mapped[1]);
    return v === '::' || v === '::1' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || v.startsWith('ff') || v.startsWith('2001:db8');
  }
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0 && p[2] === 0) || (a === 198 && (b === 18 || b === 19));
}

// LINKPREVIEW_ALLOW_LOCAL=1 exists for the automated tests only (they serve a page from this machine)
const allowLocal = () => process.env.LINKPREVIEW_ALLOW_LOCAL === '1';
const blocked = (ip) => !allowLocal() && isPrivateIp(ip);

function safeLookup(hostname, opts, cb) {
  const o = typeof opts === 'function' ? {} : opts;
  const done = typeof opts === 'function' ? opts : cb;
  dns.lookup(hostname, { ...o, all: true }, (err, list) => {
    if (err) return done(err);
    const ok = list.filter((a) => !blocked(a.address));
    if (!ok.length || ok.length !== list.length) return done(Object.assign(new Error('blocked address'), { code: 'EBLOCKED' }));
    if (o.all) return done(null, ok);
    return done(null, ok[0].address, ok[0].family);
  });
}

/** One GET with a size cap; resolves { status, headers, body } or follows up to 3 redirects. */
function get(url, { max, accept, depth = 0 }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(new Error('bad url')); return; }
    if (!['http:', 'https:'].includes(u.protocol) || (u.port && !allowLocal() && !['80', '443'].includes(u.port)) || u.username || u.password) { reject(new Error('bad url')); return; }
    const bare = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) && blocked(bare)) { reject(new Error('blocked address')); return; }
    if (!allowLocal() && /(^|\.)(localhost|local|internal|lan|home|corp)$/i.test(u.hostname)) { reject(new Error('blocked address')); return; }
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method: 'GET', lookup: safeLookup, timeout: 6000,
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; SuhbatPreview/1.0)', accept, 'accept-language': 'ru,uz;q=0.8,en;q=0.6' },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        if (depth >= 3) { reject(new Error('too many redirects')); return; }
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch { reject(new Error('bad redirect')); return; }
        get(next, { max, accept, depth: depth + 1 }).then(resolve, reject);
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > max) { res.destroy(); resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: u.toString(), truncated: true }); return; }
        chunks.push(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), url: u.toString() }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
const decode = (s) => String(s || '')
  .replace(/&#(\d+);/g, (_m, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
  .replace(/&#x([0-9a-f]+);/gi, (_m, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
  .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
  .replace(/\s+/g, ' ').trim();

/** Title, description, site name and picture from the <head> of a page. */
export function parseMeta(html, base) {
  const head = html.slice(0, MAX_HTML);
  const meta = {};
  for (const tag of head.match(/<meta\s[^>]*>/gi) || []) {
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]?.toLowerCase();
    const val = /content\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag);
    if (key && val && meta[key] === undefined) meta[key] = decode(val[2] ?? val[3]);
  }
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const title = meta['og:title'] || meta['twitter:title'] || decode(titleTag);
  const description = meta['og:description'] || meta['twitter:description'] || meta.description || '';
  let image = meta['og:image'] || meta['og:image:url'] || meta['twitter:image'] || '';
  try { if (image) image = new URL(image, base).toString(); } catch { image = ''; }
  return { title: title.slice(0, 140), description: description.slice(0, 260), site: (meta['og:site_name'] || '').slice(0, 60), image };
}

function charsetOf(headers, buf) {
  const ct = /charset=([\w-]+)/i.exec(headers['content-type'] || '')?.[1] || /<meta[^>]+charset=["']?([\w-]+)/i.exec(buf.subarray(0, 2048).toString('latin1'))?.[1] || 'utf-8';
  return ct.toLowerCase();
}

async function fetchImage(src, hash) {
  try {
    const r = await get(src, { max: MAX_IMG, accept: 'image/*' });
    if (r.status !== 200 || r.truncated || r.body.length < 200) return null;
    const type = sniff(r.body.subarray(0, 32));
    if (!type || type.kind !== 'image') return null;
    fs.writeFileSync(filePath(`lp-${hash}`), r.body, { mode: 0o640 });
    return `lp-${hash}`;
  } catch { return null; }
}

async function build(url) {
  const r = await get(url, { max: MAX_HTML, accept: 'text/html,application/xhtml+xml' });
  const ct = String(r.headers['content-type'] || '');
  if (r.status >= 400 || !/text\/html|application\/xhtml/i.test(ct)) return null;
  const cs = charsetOf(r.headers, r.body);
  let html;
  try { html = new TextDecoder(cs).decode(r.body); } catch { html = r.body.toString('utf8'); }
  const m = parseMeta(html, r.url);
  if (!m.title && !m.description) return null;
  const hash = sha256(url).slice(0, 32);
  const file = m.image ? await fetchImage(m.image, hash) : null;
  return { ...m, hash, image_file: file };
}

const inflight = new Map();

linkpreview.get('/preview', async (req, res) => {
  if (!rateLimit(`lp:${req.user.id}`, 90, 60_000)) throw new HttpError(429, 'slow_down');
  const url = String(req.query.url ?? '').trim();
  if (url.length > 600 || !/^https?:\/\//i.test(url)) throw new HttpError(400, 'invalid_input');
  const key = sha256(url);
  let row = q.get('SELECT * FROM link_previews WHERE key = ?', key);
  if (!row || now() - row.fetched_at > TTL) {
    if (!inflight.has(key)) {
      inflight.set(key, build(url).catch((e) => { log('debug', 'preview failed', { err: String(e.message).slice(0, 60) }); return null; }).finally(() => inflight.delete(key)));
    }
    const m = await inflight.get(key);
    q.run('INSERT OR REPLACE INTO link_previews (key, url, ok, title, description, site, image_file, hash, fetched_at) VALUES (?,?,?,?,?,?,?,?,?)',
      key, url.slice(0, 600), m ? 1 : 0, m?.title || '', m?.description || '', m?.site || '', m?.image_file || null, m?.hash || null, now());
    row = q.get('SELECT * FROM link_previews WHERE key = ?', key);
  }
  if (!row.ok) return res.json({ preview: null });
  return res.json({ preview: { title: row.title, description: row.description, site: row.site, image: row.image_file ? `/api/preview/img/${row.hash}` : null } });
});

linkpreview.get('/preview/img/:hash', (req, res) => {
  const h = String(req.params.hash);
  if (!/^[a-f0-9]{32}$/.test(h)) throw new HttpError(404, 'not_found');
  const p = filePath(`lp-${h}`);
  if (!fs.existsSync(p)) throw new HttpError(404, 'not_found');
  const type = sniff(readHead(p));
  if (!type) throw new HttpError(404, 'not_found');
  res.setHeader('Content-Type', type.mime);
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=604800, immutable');
  res.sendFile(p, { dotfiles: 'allow', cacheControl: false, lastModified: false });
});

void config;
