// Public pages of channels: https://<server>/c/<name> shows the latest posts to anybody, without signing in, and search engines can read it.
// A page exists only when the channel owner made the channel public and gave it an address; nothing else of the server is visible.
import express from 'express';
import fs from 'node:fs';
import { q } from './db.js';
import { filePath } from './files.js';
import { escapeLike } from './util.js';

export const publicPage = express.Router();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const when = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Asia/Tashkent', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** Escaped text with web addresses turned into links (new lines kept). */
function body(text) {
  const parts = String(text || '').split(/(https?:\/\/[^\s<>"']+)/gi);
  return parts.map((p, i) => {
    if (i % 2 === 0) return esc(p).replace(/\n/g, '<br>');
    const url = p.replace(/[.,;:!?)]+$/, '');
    const tail = p.slice(url.length);
    return `<a href="${esc(url)}" rel="nofollow noopener noreferrer ugc" target="_blank">${esc(url)}</a>${esc(tail)}`;
  }).join('');
}

const channelOf = (slug) => q.get("SELECT * FROM chats WHERE slug = ? AND is_public = 1 AND type = 'channel' AND e2e = 0", String(slug || '').toLowerCase());

function postHtml(slug, m) {
  let media = '';
  if (m.file_id) {
    const f = q.get('SELECT mime, name FROM files WHERE id = ?', m.file_id);
    const src = `/c/${esc(slug)}/f/${esc(m.file_id)}`;
    if (f && /^image\/(jpeg|png|gif|webp)$/.test(f.mime)) media = `<img class="pp-img" src="${src}" alt="" loading="lazy">`;
    else if (f && /^video\//.test(f.mime)) media = `<video class="pp-video" src="${src}" controls preload="none"></video>`;
    else if (f) media = `<div class="pp-file">\u{1F4CE} ${esc(f.name)}</div>`;
  }
  const text = m.text ? `<div class="pp-text">${body(m.text)}</div>` : '';
  return `<article class="pp-post" id="m${m.id}">${media}${text}<footer><a href="#m${m.id}"><time datetime="${new Date(m.created_at).toISOString()}">${esc(when.format(new Date(m.created_at)))}</time></a></footer></article>`;
}

publicPage.get('/c/:slug', (req, res) => {
  const chat = channelOf(req.params.slug);
  if (!chat) { res.status(404).type('html').send('<!doctype html><meta charset="utf-8"><title>404</title><link rel="stylesheet" href="/c-page.css"><main class="pp"><h1>Канал не найден</h1><p><a href="/">Suhbat-dosh</a></p></main>'); return; }
  const before = Number(req.query.before) > 0 ? Number(req.query.before) : Number.MAX_SAFE_INTEGER;
  const rows = q.all(
    `SELECT * FROM messages WHERE chat_id = ? AND id < ? AND kind IN ('text','image','video','file') AND once = 0 AND (text != '' OR file_id IS NOT NULL)
     ORDER BY id DESC LIMIT 31`, chat.id, before);
  const more = rows.length > 30;
  const posts = rows.slice(0, 30);
  const subs = q.get('SELECT COUNT(*) AS n FROM members WHERE chat_id = ? AND banned = 0', chat.id).n;
  const firstImage = posts.find((m) => m.file_id && /^image\//.test(q.get('SELECT mime FROM files WHERE id = ?', m.file_id)?.mime || ''));
  const origin = `${req.protocol}://${req.get('host')}`;
  const desc = chat.description || posts.find((m) => m.text)?.text?.slice(0, 160) || chat.title;
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(chat.title)} — Suhbat-dosh</title>
<meta name="description" content="${esc(desc.slice(0, 200))}">
<meta property="og:title" content="${esc(chat.title)}"><meta property="og:description" content="${esc(desc.slice(0, 200))}"><meta property="og:type" content="website">
<meta property="og:url" content="${esc(`${origin}/c/${chat.slug}`)}">${firstImage ? `<meta property="og:image" content="${esc(`${origin}/c/${chat.slug}/f/${firstImage.file_id}`)}">` : ''}
<link rel="canonical" href="${esc(`${origin}/c/${chat.slug}`)}"><link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/c-page.css"></head>
<body><main class="pp">
<header class="pp-head"><a class="pp-brand" href="/"><img src="/icon.svg" alt="" width="36" height="36"> Suhbat-dosh</a></header>
<section class="pp-channel"><h1>${esc(chat.title)}</h1>${chat.description ? `<p>${body(chat.description)}</p>` : ''}<p class="pp-meta">${subs} подписчиков</p>
<a class="pp-join" href="/#/join/${esc(chat.invite_code)}">Открыть в Suhbat-dosh</a></section>
${posts.length ? posts.map((m) => postHtml(chat.slug, m)).join('\n') : '<p class="pp-empty">Пока нет записей.</p>'}
${more ? `<p class="pp-more"><a href="/c/${esc(chat.slug)}?before=${posts[posts.length - 1].id}">Более ранние записи</a></p>` : ''}
</main></body></html>`;
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  res.type('html').send(html);
});

/** A picture or a video of a post of a public channel (only those; every other file stays private). */
publicPage.get('/c/:slug/f/:fid', (req, res) => {
  const chat = channelOf(req.params.slug);
  const fid = String(req.params.fid || '');
  if (!chat || !/^[\w-]{8,40}$/.test(fid)) { res.status(404).end(); return; }
  const f = q.get(
    `SELECT f.* FROM files f JOIN messages m ON m.file_id = f.id WHERE f.id = ? AND m.chat_id = ? AND m.once = 0 AND m.kind IN ('image','video')`, fid, chat.id);
  if (!f || !/^(image\/(jpeg|png|gif|webp)|video\/)/.test(f.mime) || !fs.existsSync(filePath(fid))) { res.status(404).end(); return; }
  res.setHeader('Content-Type', f.mime);
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.sendFile(filePath(fid), { dotfiles: 'allow', cacheControl: false, lastModified: false });
});

publicPage.get('/sitemap.xml', (req, res) => {
  const origin = `${req.protocol}://${req.get('host')}`;
  const rows = q.all("SELECT slug FROM chats WHERE slug IS NOT NULL AND is_public = 1 AND type = 'channel' AND e2e = 0 ORDER BY id LIMIT 5000");
  res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${rows.map((r) => `<url><loc>${esc(`${origin}/c/${r.slug}`)}</loc></url>`).join('')}</urlset>`);
});

void escapeLike;
