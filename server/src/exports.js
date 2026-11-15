// Exports of messages: a chat (a personal chat, a group, a channel) or everything one person wrote, as a ZIP (with the files), a page, a text or JSON.
// The administrator downloads it at once or gives a link that works for a limited time and a limited number of times, optionally with a password.
import express from 'express';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { q } from './db.js';
import { config } from './config.js';
import { alert } from './ops.js';
import { HttpError, int, now, rateLimit, rid, str } from './util.js';
import { filePath } from './files.js';
import { audit, getUser } from './service.js';
import { chatHiddenFrom } from './adminperms.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { ZipWriter } from '../../web/js/zip.js';

export const FORMATS = { zip: ['zip', 'application/zip'], html: ['html', 'text/html; charset=utf-8'], txt: ['txt', 'text/plain; charset=utf-8'], json: ['json', 'application/json; charset=utf-8'] };
const TYPE_NAME = { direct: 'личный чат', group: 'группа', channel: 'канал' };
const MEDIA_CAP = 1.5 * 1024 ** 3;   // the files that go into one archive: up to this much, the rest is listed in README
const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const stamp = (t) => new Date(t).toISOString().replace('T', ' ').slice(0, 19);
const KIND = { image: 'Фото', video: 'Видео', voice: 'Голосовое', audio: 'Аудио', file: 'Файл', location: 'Геопозиция', call: 'Звонок', sticker: 'Стикер', poll: 'Опрос', deal: 'Договорённость' };

// ---------------------------------------------------------------- what is exported
function chatName(c) {
  if (c.title) return c.title;
  const names = q.all('SELECT u.name FROM members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? LIMIT 3', c.id).map((r) => r.name);
  return names.join(' и ') || `Чат ${c.id}`;
}

/** The title of an export and its scope, or a 404 when there is nothing like it. */
export function describeScope(scope, id) {
  if (scope === 'message') {
    const m = q.get('SELECT m.id, m.kind, m.chat_id, c.e2e, c.title FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.id = ?', id);
    if (!m) throw new HttpError(404, 'not_found');
    if (m.kind === 'secret' || m.e2e) throw new HttpError(400, 'not_exportable');   // the server cannot read it
    return { title: `Сообщение №${m.id} · ${chatName(q.get('SELECT * FROM chats WHERE id = ?', m.chat_id))}`, kind: 'сообщение' };
  }
  if (scope === 'chat') {
    const c = q.get('SELECT * FROM chats WHERE id = ?', id);
    if (!c) throw new HttpError(404, 'not_found');
    return { title: chatName(c), kind: TYPE_NAME[c.type] || c.type };
  }
  if (scope === 'user') {
    const u = getUser(id);
    if (!u) throw new HttpError(404, 'not_found');
    return { title: `Сообщения: ${u.name}`, kind: 'пользователь' };
  }
  throw new HttpError(400, 'invalid_input');
}

/** The messages, oldest first, in pieces (a long chat is never held in memory at once). Secret and encrypted messages cannot be read by the server and are skipped. */
function* messagesOf({ scope, scope_id: id, since, until }) {
  let lastAt = -1;
  let lastId = 0;   // by the time of writing, then the number: copied history of Telegram stands where it was written
  for (;;) {
    const where = [`(m.created_at, m.id) > (?, ?)`, `m.kind != 'secret'`, `c.e2e = 0`];
    const params = [lastAt, lastId];
    if (scope === 'chat') { where.push('m.chat_id = ?'); params.push(id); } else if (scope === 'message') { where.push('m.id = ?'); params.push(id); } else { where.push('m.sender_id = ?'); params.push(id); }
    if (since) { where.push('m.created_at >= ?'); params.push(since); }
    if (until) { where.push('m.created_at <= ?'); params.push(until); }
    const rows = q.all(`SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id WHERE ${where.join(' AND ')} ORDER BY m.created_at, m.id LIMIT 500`, ...params);
    if (!rows.length) return;
    for (const m of rows) yield m;
    lastAt = rows.at(-1).created_at;
    lastId = rows.at(-1).id;
  }
}

/** What is closed to whoever asks for it now, or to whoever made the link: a link gives no more than its author may read today. */
function closedTo(spec) {
  const who = spec.viewer ?? getUser(spec.created_by);
  const seen = new Map();
  return (chatId) => {
    if (!seen.has(chatId)) seen.set(chatId, chatHiddenFrom(chatId, who));
    return seen.get(chatId);
  };
}

function shape(m, chats) {
  let c = chats.get(m.chat_id);
  if (!c) {
    const row = q.get('SELECT * FROM chats WHERE id = ?', m.chat_id);
    c = { id: m.chat_id, title: row ? chatName(row) : `Чат ${m.chat_id}`, type: row ? (TYPE_NAME[row.type] || row.type) : '' };
    chats.set(m.chat_id, c);
  }
  const f = m.file_id ? q.get('SELECT id, name, mime, size FROM files WHERE id = ?', m.file_id) : null;
  return {
    id: m.id, chat_id: m.chat_id, chat: c.title, chat_type: c.type, at: m.created_at, author: m.import_author || getUser(m.sender_id)?.name || '—',
    kind: m.kind, text: m.text || '', file: f ? { id: f.id, name: f.name, mime: f.mime, size: f.size } : null,
    reply_to: m.reply_to || null, forward_from: m.forward_from || null, edited_at: m.edited_at || null, deleted_in_telegram: !!m.tg_deleted,
  };
}

const line = (e) => `[${stamp(e.at)}] ${e.author}: ${e.kind === 'text' ? e.text : `[${KIND[e.kind] || e.kind}${e.file ? ` ${e.file.name}` : ''}]${e.text ? ` ${e.text}` : ''}`}${e.deleted_in_telegram ? ' (удалено в Телеграме)' : ''}`;

function renderTxt(title, groups) {
  return `${title}\n${'='.repeat(Math.min(60, title.length))}\n\n${groups.map((g) => `# ${g.chat} (${g.type})\n${g.items.map(line).join('\n')}`).join('\n\n')}\n`;
}

const DAY = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Tashkent' });
const CLOCK = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Tashkent' });

/** A page that reads like the chat itself: bubbles, a side and a colour for each person, days as dividers, the pictures inside. */
function renderHtml(title, groups, mediaPath) {
  let inline = 0;   // a page without a folder of files carries small pictures inside itself (up to a limit)
  const media = (e) => {
    if (!e.file) return '';
    const href = mediaPath ? esc(mediaPath(e)) : null;
    if (!href) {
      if (e.file.mime.startsWith('image/') && inline < 20_000_000) {
        try {
          const thumb = `${filePath(e.file.id)}.thumb`;
          const src = fs.existsSync(thumb) ? thumb : (e.file.size <= 250_000 ? filePath(e.file.id) : null);
          if (src) {
            const buf = fs.readFileSync(src);
            inline += buf.length;
            return `<img src="data:${src === thumb ? 'image/jpeg' : e.file.mime};base64,${buf.toString('base64')}" alt="">`;
          }
        } catch { /* the file is gone: only its name */ }
      }
      return `<div class="f">📎 ${esc(e.file.name)}</div>`;
    }
    if (e.file.mime.startsWith('image/')) return `<a href="${href}"><img src="${href}" alt="" loading="lazy"></a>`;
    if (e.file.mime.startsWith('video/')) return `<video src="${href}" controls preload="none"></video>`;
    if (e.file.mime.startsWith('audio/')) return `<audio src="${href}" controls preload="none"></audio>`;
    return `<div class="f">📎 <a href="${href}">${esc(e.file.name)}</a></div>`;
  };
  const section = (g) => {
    const people = [...new Set(g.items.map((e) => e.author))];
    let lastDay = '';
    let prev = null;
    const msgs = g.items.map((e) => {
      const d = DAY.format(e.at);
      const sep = d !== lastDay ? `<div class="d"><span>${esc(d)}</span></div>` : '';
      lastDay = d;
      const n = people.indexOf(e.author);
      const same = !sep && prev === e.author;
      prev = e.author;
      const label = e.kind !== 'text' && !e.file ? `<div class="k">${esc(KIND[e.kind] || e.kind)}</div>` : '';
      return `${sep}<div class="r s${n % 2}"><div class="m${e.deleted_in_telegram ? ' x' : ''}">${same ? '' : `<div class="w c${n % 6}">${esc(e.author)}</div>`}${media(e)}${label}${e.text ? `<div class="b">${esc(e.text)}</div>` : ''}<span class="t">${esc(CLOCK.format(e.at))}${e.edited_at ? ' · изменено' : ''}${e.deleted_in_telegram ? ' · удалено в Телеграме' : ''}</span></div></div>`;
    }).join('\n');
    return `<h2>${esc(g.chat)} <small>${esc(g.type)} · ${g.items.length}</small></h2>${msgs}`;
  };
  const total = groups.reduce((a, g) => a + g.items.length, 0);
  return `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>
:root{color-scheme:light}body{font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#efe7d0;color:#1d1d1f}
header{position:sticky;top:0;z-index:2;background:#fbc700;padding:10px 16px;box-shadow:0 1px 4px #0003}header h1{margin:0;font-size:1.05rem}header small{opacity:.7}
main{max-width:780px;margin:0 auto;padding:6px 10px 40px}h2{margin:26px 0 4px;font-size:1rem}h2 small{font-weight:400;color:#7a6a2e}.d{text-align:center;margin:14px 0 6px}.d span{background:#0000001f;color:#fff;border-radius:999px;padding:3px 12px;font-size:.78rem}
.r{display:flex;margin:2px 0}.r.s1{justify-content:flex-end}.m{max-width:82%;background:#fff;border-radius:14px 14px 14px 4px;padding:6px 10px 4px;box-shadow:0 1px 2px #0002;overflow-wrap:anywhere}
.s1 .m{background:#fff3b8;border-radius:14px 14px 4px 14px}.m.x{opacity:.65}.w{font-weight:700;font-size:.85rem}.c0{color:#b25e00}.c1{color:#1c7c3a}.c2{color:#1c5fa8}.c3{color:#9b2d8f}.c4{color:#a82d2d}.c5{color:#00796b}
.b{white-space:pre-wrap}.k{color:#7a6a2e;font-size:.85rem}.f{font-size:.85rem}.t{display:block;text-align:right;color:#888;font-size:.7rem;margin-top:2px}img,video{display:block;max-width:100%;max-height:340px;border-radius:10px;margin:4px 0}audio{width:100%;margin:4px 0}
@media print{header{position:static;box-shadow:none}body{background:#fff}.m{box-shadow:none;border:1px solid #ddd;break-inside:avoid}}
</style>
<header><h1>${esc(title)}</h1><small>${total} сообщ.</small></header>
<main>${groups.map(section).join('\n')}</main>
</html>`;
}

/** Everything of an export, grouped by chat: [{ chat, type, items: [...] }]. */
function gather(spec) {
  const chats = new Map();
  const groups = new Map();
  let count = 0;
  const closed = closedTo(spec);
  for (const m of messagesOf(spec)) {
    if (closed(m.chat_id)) continue;
    const e = shape(m, chats);
    if (!groups.has(e.chat_id)) groups.set(e.chat_id, { chat: e.chat, type: e.chat_type, chat_id: e.chat_id, items: [] });
    groups.get(e.chat_id).items.push(e);
    count += 1;
  }
  return { groups: [...groups.values()], count };
}

// ---------------------------------------------------------------- writing it out
const sink = (res) => ({ write: (u8) => new Promise((ok, no) => res.write(Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength), (e) => (e ? no(e) : ok()))) });
const safeName = (s) => String(s || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_').trim().slice(0, 80) || 'file';

/** Streams the export into `res` (headers included). */
export async function streamExport(res, spec) {
  const about = describeScope(spec.scope, spec.scope_id);
  const { groups, count } = gather(spec);
  const [ext, mime] = FORMATS[spec.format] || FORMATS.zip;
  const day = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${safeName(about.title)}-${day}.${ext}`)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  if (spec.format === 'txt') { res.end(renderTxt(about.title, groups)); return count; }
  if (spec.format === 'json') {
    res.end(JSON.stringify({ title: about.title, exported_at: new Date().toISOString(), count, chats: groups.map((g) => ({ chat_id: g.chat_id, chat: g.chat, type: g.type, messages: g.items })) }, null, 1));
    return count;
  }
  if (spec.format === 'html') { res.end(renderHtml(about.title, groups, null)); return count; }
  // an archive: the page, the text, the data, and (when asked) the files themselves
  const zip = new ZipWriter(sink(res));
  const skipped = [];
  let used = 0;
  const paths = new Map();
  if (spec.media) {
    for (const g of groups) for (const e of g.items) {
      if (!e.file) continue;
      const rel = `files/${g.chat_id}/${e.id}_${safeName(e.file.name)}`;
      paths.set(e.id, rel);
    }
  }
  await zip.add('messages.html', renderHtml(about.title, groups, spec.media ? (e) => paths.get(e.id) : null));
  await zip.add('messages.txt', renderTxt(about.title, groups));
  await zip.add('messages.json', JSON.stringify({ title: about.title, count, chats: groups.map((g) => ({ chat_id: g.chat_id, chat: g.chat, type: g.type, messages: g.items })) }, null, 1));
  if (spec.media) {
    for (const g of groups) for (const e of g.items) {
      if (!e.file) continue;
      const p = filePath(e.file.id);
      let size = 0;
      try { size = fs.statSync(p).size; } catch { skipped.push(`${e.file.name}: файла нет на диске`); continue; }
      if (used + size > MEDIA_CAP) { skipped.push(`${e.file.name}: не поместился в архив (${(size / 1048576).toFixed(0)} МБ)`); continue; }
      used += size;
      await zip.add(paths.get(e.id), await fs.openAsBlob(p), new Date(e.at));
    }
  }
  await zip.add('README.txt', `${about.title}\nСообщений: ${count}\nСоздано: ${stamp(Date.now())} UTC\n${spec.media ? `Файлов: ${used ? 'включены' : 'нет'}\n` : ''}Зашифрованные (секретные) сообщения сервер прочитать не может, их здесь нет.\n${skipped.length ? `\nНе вошло в архив:\n${skipped.join('\n')}\n` : ''}`);
  await zip.close();
  res.end();
  return count;
}

// ---------------------------------------------------------------- links
const link = (r) => {
  const viewUsed = r.max_views !== null && r.views >= r.max_views;
  const dlUsed = r.max_downloads !== null && r.downloads >= r.max_downloads;
  return {
    id: r.id, token: r.token, created_by: r.created_by, scope: r.scope, scope_id: r.scope_id, title: r.title, format: r.format, media: !!r.media, since: r.since, until: r.until, note: r.note,
    created_at: r.created_at, expires_at: r.expires_at, password: !!r.pass_hash, revoked_at: r.revoked_at,
    view: !!r.view, allow_download: !!r.allow_download, hide_names: !!r.hide_names, notify: !!r.notify,
    max_downloads: r.max_downloads, downloads: r.downloads, last_download_at: r.last_download_at, max_views: r.max_views, views: r.views, first_view_at: r.first_view_at, last_view_at: r.last_view_at,
    // a page with content is over when it was opened as often as allowed; a download-only link, when it was downloaded as often as allowed
    status: r.revoked_at ? 'revoked' : r.expires_at <= now() ? 'expired' : (r.view ? viewUsed : dlUsed) ? 'used' : 'active',
    downloads_left: r.allow_download && !dlUsed ? (r.max_downloads === null ? null : r.max_downloads - r.downloads) : 0,
  };
};

const limitOf = (v, name) => (v === null || v === undefined || v === '' ? null : int(v, name, { min: 1, max: 10000 }));
export function createLink(adminId, b) {
  const scope = b.scope === 'user' ? 'user' : b.scope === 'message' ? 'message' : 'chat';
  const scopeId = int(b.scope_id, 'scope_id');
  const about = describeScope(scope, scopeId);
  const format = FORMATS[b.format] ? b.format : 'zip';
  const hours = Math.min(90 * 24, Math.max(1, Math.round(Number(b.hours) || 24)));
  const pass = typeof b.password === 'string' && b.password ? str(b.password, 'password', { min: 4, max: 100 }) : null;
  const view = b.view === true || b.view === 1;
  const allow = b.allow_download === undefined ? true : b.allow_download === true || b.allow_download === 1;
  if (!view && !allow) throw new HttpError(400, 'invalid_input');   // a link must show something or give something
  const token = rid(24);
  const since = b.since ? int(b.since, 'since', { min: 0 }) : null;
  const until = b.until ? int(b.until, 'until', { min: 0 }) : null;
  q.run(
    `INSERT INTO export_links (token, scope, scope_id, title, format, media, since, until, note, created_by, created_at, expires_at, max_downloads, pass_hash, view, allow_download, max_views, hide_names, notify)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    token, scope, scopeId, about.title, format, format === 'zip' && b.media ? 1 : 0, since, until, str(String(b.note ?? ''), 'note', { max: 200 }), adminId, now(), now() + hours * 3600_000,
    limitOf(b.max_downloads, 'max_downloads'), pass ? hashPassword(pass) : null, view ? 1 : 0, allow ? 1 : 0, limitOf(b.max_views, 'max_views'), b.hide_names ? 1 : 0, b.notify ? 1 : 0,
  );
  return link(q.get('SELECT * FROM export_links WHERE token = ?', token));
}
export const listLinks = () => q.all('SELECT * FROM export_links ORDER BY id DESC LIMIT 200').map(link);
export function revokeLink(id) {
  const r = q.run('UPDATE export_links SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', now(), id);
  if (!r.changes) throw new HttpError(404, 'not_found');
}
/** A link that is about to run out can be given more time (from now, or from its end if that is later). */
export function extendLink(id, hours) {
  const h = Math.min(90 * 24, Math.max(1, Math.round(Number(hours) || 24)));
  const r = q.get('SELECT * FROM export_links WHERE id = ? AND revoked_at IS NULL', id);
  if (!r) throw new HttpError(404, 'not_found');
  q.run('UPDATE export_links SET expires_at = ? WHERE id = ?', Math.max(now(), r.expires_at) + h * 3600_000, id);
  return link(q.get('SELECT * FROM export_links WHERE id = ?', id));
}

// ---------------------------------------------------------------- the public side: no account needed
export const exportsPublic = express.Router();
const WHEN = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const BOT = /bot\b|crawl|spider|preview|facebookexternalhit|whatsapp|telegram|slack|discord|twitter|linkedin|skype|embedly|vkshare|google-read|mediapartners|bingpreview/i;
const KEY_TTL = 15 * 60_000;   // the files of an opened page stay reachable for this long

/** The page chrome. `extra`: more head tags (a title for link previews). */
const page = (res, status, body, { title = 'Suhbat-dosh', scripts = false } = {}) => {
  res.status(status).setHeader('Content-Security-Policy', `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self'; ${scripts ? "script-src 'self'; " : ''}base-uri 'none'; form-action 'self'; frame-ancestors 'none'`);
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.type('html').send(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><meta property="og:title" content="${esc(title)}"><meta property="og:site_name" content="Suhbat-dosh"><title>${esc(title)}</title><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/c-page.css"><link rel="stylesheet" href="/x.css"><main class="pp xv">${body}</main>${scripts ? '<script src="/x.js"></script>' : ''}</html>`);
};
const dead = (res) => page(res, 410, '<h1>Ссылка не работает</h1><p>Срок действия закончился, ссылкой уже воспользовались или её отозвали.</p>');
const row = (token) => q.get('SELECT * FROM export_links WHERE token = ?', String(token || ''));
const live = (token) => { const r = row(token); return r && link(r).status === 'active' ? r : null; };

const sign = (token, exp, what) => crypto.createHmac('sha256', config.secret).update(`x:${token}:${exp}:${what}`).digest('base64url').slice(0, 32);
const signed = (token, exp, what, k) => { const want = sign(token, exp, what); return typeof k === 'string' && k.length === want.length && crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want)); };

/** Does this file belong to what the link gives? (a link to one message never opens the other files of the chat) */
function inScope(r, fid) {
  const base = `SELECT m.chat_id FROM messages m JOIN chats c ON c.id = m.chat_id WHERE m.file_id = ? AND m.kind != 'secret' AND c.e2e = 0`;
  const closed = closedTo(r);
  const open = (rows) => rows.some((m) => !closed(m.chat_id));
  if (r.scope === 'message') return open(q.all(`${base} AND m.id = ?`, fid, r.scope_id));
  if (r.scope === 'chat') return open(q.all(`${base} AND m.chat_id = ?`, fid, r.scope_id));
  return open(q.all(`${base} AND m.sender_id = ?`, fid, r.scope_id));
}

/** The last messages of what the link gives (at most `n`), oldest first. */
function recent(r, n = 300) {
  const where = [`m.kind != 'secret'`, 'c.e2e = 0'];
  const params = [];
  if (r.scope === 'chat') { where.push('m.chat_id = ?'); params.push(r.scope_id); } else if (r.scope === 'message') { where.push('m.id = ?'); params.push(r.scope_id); } else { where.push('m.sender_id = ?'); params.push(r.scope_id); }
  if (r.since) { where.push('m.created_at >= ?'); params.push(r.since); }
  if (r.until) { where.push('m.created_at <= ?'); params.push(r.until); }
  const rows = q.all(`SELECT m.* FROM messages m JOIN chats c ON c.id = m.chat_id WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`, ...params, n + 1);
  const chats = new Map();
  const closed = closedTo(r);
  return { items: rows.slice(0, n).reverse().filter((m) => !closed(m.chat_id)).map((m) => shape(m, chats)), more: rows.length > n };
}

const INLINE = /^(image\/(jpeg|png|gif|webp)|video\/|audio\/)/;
function itemHtml(e, r, keys) {
  const exp = keys.exp;
  const url = (f, dl) => `/x/${r.token}/m/${f.id}?e=${exp}&k=${sign(r.token, exp, f.id)}${dl ? '&dl=1' : ''}`;
  let media = '';
  if (e.file) {
    const f = e.file;
    const can = !!r.allow_download;
    if (/^image\//.test(f.mime) && INLINE.test(f.mime)) media = `<img class="pp-img" src="${url(f)}" alt="" loading="lazy" draggable="false">`;
    else if (f.mime.startsWith('video/')) media = `<video class="pp-video" src="${url(f)}" controls playsinline preload="metadata"${can ? '' : ' controlsList="nodownload noremoteplayback" disablepictureinpicture'}></video>`;
    else if (f.mime.startsWith('audio/')) media = `<audio class="xv-audio" src="${url(f)}" controls preload="metadata"${can ? '' : ' controlsList="nodownload"'}></audio>`;
    else media = `<div class="pp-file">📎 ${esc(f.name)} <small>(${f.size < 1048576 ? `${Math.max(1, Math.round(f.size / 1024))} КБ` : `${(f.size / 1048576).toFixed(1)} МБ`})</small>${can ? '' : '<br><small>Этот файл нельзя открыть на странице, а скачивание отключено.</small>'}</div>`;
    if (can) media += `<div class="xv-dl"><a href="${url(f, true)}">⬇ Скачать${/^image\/|^video\/|^audio\//.test(f.mime) ? '' : ' файл'}</a></div>`;
  }
  let text = '';
  const geo = /^geo:(-?[\d.]+),(-?[\d.]+)/.exec(e.text);
  if (e.kind === 'location' && geo) text = `<div class="pp-text">📍 Геопозиция: <a href="https://yandex.ru/maps/?pt=${esc(geo[2])},${esc(geo[1])}&z=16&l=map" target="_blank" rel="noopener noreferrer">${esc(geo[1])}, ${esc(geo[2])}</a> <small>Яндекс Карты</small></div>`;
  else if (e.text) text = `<div class="pp-text">${esc(e.text).replace(/\n/g, '<br>')}</div>`;
  else if (!e.file) text = `<div class="pp-text"><i>[${esc(KIND[e.kind] || e.kind)}]</i></div>`;
  const who = r.hide_names ? '' : `<b>${esc(e.author)}</b>${r.scope !== 'message' ? ` · ${esc(e.chat)}` : ''} · `;
  return `<article class="pp-post">${media}${text}<footer>${who}${esc(WHEN.format(new Date(e.at)))}</footer></article>`;
}

/** Counts one opening (under the limit, atomically) and shows what the link gives. */
function openPage(req, res, r) {
  const t = q.run('UPDATE export_links SET views = views + 1, last_view_at = ?, first_view_at = COALESCE(first_view_at, ?) WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (max_views IS NULL OR views < max_views)', now(), now(), r.id, now());
  if (!t.changes) return dead(res);
  audit(null, 'export.view', { target_type: 'export', target_id: String(r.id), ip: req.ip, details: { title: r.title } });
  if (r.notify && !r.first_view_at) alert(`🔗 Ссылку «${r.title}» открыли (${req.ip}).`);
  const { items, more } = recent(r);
  const keys = { exp: Date.now() + KEY_TTL };
  const dl = r.allow_download && (r.max_downloads === null || r.downloads < r.max_downloads);
  const heading = r.hide_names ? 'Материал' : r.title;
  page(res, 200, `<h1>${esc(heading)}</h1>${more ? `<p class="muted">Показаны последние ${items.length} сообщений.</p>` : ''}
${items.length ? items.map((e) => itemHtml(e, r, keys)).join('\n') : '<p class="muted">Здесь пока нечего показывать.</p>'}
${dl ? `<form method="post" action="/x/${esc(r.token)}/get" class="xv-all"><input type="hidden" name="e" value="${keys.exp}"><input type="hidden" name="k" value="${sign(r.token, keys.exp, 'dl')}"><button type="submit">⬇ Скачать всё (${esc(FORMATS[r.format][0].toUpperCase())}${r.media ? ', с файлами' : ''})</button></form>` : ''}
<p class="muted xv-foot">${r.allow_download ? '' : 'Скачивание отключено. '}Ссылка действует до ${esc(WHEN.format(new Date(r.expires_at)))}.</p>`, { title: heading, scripts: !r.allow_download });
}

const passForm = (r, msg = '') => `<h1>${esc(r.hide_names ? 'Материал' : r.title)}</h1>${msg ? `<p class="err">${esc(msg)}</p>` : '<p>Чтобы открыть, введите пароль.</p>'}<form method="post" action="/x/${esc(r.token)}/open"><p><input type="password" name="p" placeholder="Пароль" autocomplete="off" required autofocus></p><p><button type="submit">Открыть</button></p></form>`;

exportsPublic.get('/x/:token', (req, res) => {
  const r = live(req.params.token);
  if (!r) return dead(res);
  // a messenger that previews the address must not use up a one-time link: it gets only the name
  if (BOT.test(String(req.headers['user-agent'] || ''))) return page(res, 200, `<h1>${esc(r.hide_names ? 'Материал' : r.title)}</h1><p>Вам прислали материал в Suhbat-dosh. Откройте ссылку в браузере.</p>`, { title: r.hide_names ? 'Материал' : r.title });
  if (r.view) return r.pass_hash ? page(res, 200, passForm(r), { title: 'Suhbat-dosh' }) : openPage(req, res, r);
  const left = r.max_downloads === null ? '' : `<p class="muted">Можно скачать ещё раз: ${r.max_downloads - r.downloads}</p>`;
  page(res, 200, `<h1>${esc(r.title)}</h1><p>Выгрузка сообщений (${esc(FORMATS[r.format][0].toUpperCase())}${r.media ? ', с файлами' : ''}). Ссылка действует до ${esc(WHEN.format(new Date(r.expires_at)))}.</p>${left}
<form method="post" action="/x/${esc(r.token)}/get">${r.pass_hash ? '<p><input type="password" name="p" placeholder="Пароль" autocomplete="off" required></p>' : ''}<p><button type="submit">Скачать</button></p></form>`);
});

exportsPublic.post('/x/:token/open', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
  if (!rateLimit(`xopen:${req.ip}`, 30, 600_000)) return page(res, 429, '<h1>Слишком много попыток</h1><p>Подождите несколько минут.</p>');
  const r = live(req.params.token);
  if (!r || !r.view) return dead(res);
  if (r.pass_hash && !verifyPassword(String(req.body?.p ?? ''), r.pass_hash)) return page(res, 403, passForm(r, 'Неверный пароль.'));
  openPage(req, res, r);
});

// a file of an opened page: shown there, and downloaded only when the link allows it
exportsPublic.get('/x/:token/m/:fid', (req, res) => {
  const r = row(req.params.token);
  const fid = String(req.params.fid || '');
  const exp = Number(req.query.e);
  if (!r || r.revoked_at || r.expires_at <= now() || !Number.isFinite(exp) || exp < Date.now() || !signed(r.token, exp, fid, req.query.k)) return dead(res);
  const f = q.get('SELECT * FROM files WHERE id = ?', fid);
  if (!f || !inScope(r, fid) || !fs.existsSync(filePath(fid))) return res.status(404).type('text').send('not found');
  const wantsDownload = req.query.dl === '1';
  if (wantsDownload) {
    if (!r.allow_download) return res.status(403).type('text').send('Скачивание отключено');
    const t = q.run('UPDATE export_links SET downloads = downloads + 1, last_download_at = ? WHERE id = ? AND revoked_at IS NULL AND (max_downloads IS NULL OR downloads < max_downloads)', now(), r.id);
    if (!t.changes) return res.status(403).type('text').send('Лимит скачиваний исчерпан');
    audit(null, 'export.download', { target_type: 'export', target_id: String(r.id), ip: req.ip, details: { title: r.title, file: f.name } });
  } else if (!INLINE.test(f.mime)) return res.status(403).type('text').send('Этот файл нельзя открыть на странице');
  res.setHeader('Content-Type', wantsDownload && !INLINE.test(f.mime) ? 'application/octet-stream' : f.mime);
  res.setHeader('Content-Disposition', `${wantsDownload ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Accept-Ranges', 'bytes');
  res.sendFile(filePath(fid), { dotfiles: 'allow', cacheControl: false, lastModified: false }, (err) => { if (err && !res.headersSent) res.status(404).end(); });
});

exportsPublic.post('/x/:token/get', express.urlencoded({ extended: false, limit: '2kb' }), async (req, res) => {
  if (!rateLimit(`xdl:${req.ip}`, 20, 600_000)) return page(res, 429, '<h1>Слишком много попыток</h1><p>Подождите несколько минут.</p>');
  const r = live(req.params.token);
  if (!r) return dead(res);
  if (!r.allow_download) return page(res, 403, '<h1>Скачивание отключено</h1><p>Содержимое можно только посмотреть на странице.</p>');
  // a page that was already opened (with its password) carries a signed key; otherwise the password is asked
  const unlocked = r.view && signed(r.token, Number(req.body?.e), 'dl', req.body?.k) && Number(req.body.e) > Date.now();
  if (r.pass_hash && !unlocked && !verifyPassword(String(req.body?.p ?? ''), r.pass_hash)) return page(res, 403, `<h1>${esc(r.title)}</h1><p>Неверный пароль.</p><p><a href="/x/${esc(r.token)}">Попробовать ещё раз</a></p>`);
  // the count is taken at once and under the limit: two people with the last download cannot both get it
  const t = q.run('UPDATE export_links SET downloads = downloads + 1, last_download_at = ? WHERE id = ? AND revoked_at IS NULL AND expires_at > ? AND (max_downloads IS NULL OR downloads < max_downloads)', now(), r.id, now());
  if (!t.changes) return dead(res);
  audit(null, 'export.download', { target_type: 'export', target_id: String(r.id), ip: req.ip, details: { title: r.title, format: r.format } });
  try { await streamExport(res, r); } catch (e) { if (!res.headersSent) page(res, 500, '<h1>Не удалось подготовить файл</h1>'); else res.destroy(); }
});
