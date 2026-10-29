// Import of a chat history exported from Telegram Desktop. The browser reads the export, so the server only receives
// small batches: texts as JSON, media as raw uploads. Everything lands in a private chat that only the importer sees;
// the original authors appear as names on the messages (they are not accounts here), with the original timestamps.
import express from 'express';
import { config } from './config.js';
import { q, tx } from './db.js';
import { HttpError, int, now, rateLimit, rid, seconds, str } from './util.js';
import { chatOut, requireMember } from './service.js';
import { emit } from './realtime.js';
import { assertQuota } from './safety.js';
import { checkName, filePath, readHead, receive, removeFile, sniff } from './files.js';
import { LIMITS } from '../../shared/contracts.js';

export const importer = express.Router();

function ownImport(req) {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (!c || c.imported_from !== 'telegram' || c.owner_id !== req.user.id) throw new HttpError(404, 'not_found');
  return c;
}

const clean = (v, max) => String(v ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);

// a time from an old export must be a plausible past time (Telegram started in 2013)
const when = (ts) => {
  const n = Number(ts);
  return Number.isFinite(n) && n > Date.UTC(2013, 0, 1) && n <= now() + 86400_000 ? Math.round(n) : now();
};

importer.post('/import/telegram/start', (req, res) => {
  if (!rateLimit(`import:${req.user.id}`, 40, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const title = str(req.body?.title || 'Telegram', 'title', { min: 1, max: LIMITS.TITLE_MAX - 2 });
  const meName = clean(req.body?.me_name, 64);
  const key = clean(req.body?.key, 64);
  // importing the same chat twice continues the earlier import instead of creating a copy
  let chat = key ? q.get("SELECT * FROM chats WHERE imported_from = 'telegram' AND owner_id = ? AND description = ?", req.user.id, `tg:${key}`) : null;
  if (!chat) {
    const cid = tx(() => {
      const r = q.run(
        "INSERT INTO chats (type, title, description, owner_id, imported_from, import_me, last_message_at, created_at) VALUES ('group', ?, ?, ?, 'telegram', ?, ?, ?)",
        `✈ ${title}`, key ? `tg:${key}` : '', req.user.id, meName, now(), now(),
      );
      const id = Number(r.lastInsertRowid);
      q.run("INSERT INTO members (chat_id, user_id, role, joined_at, hidden) VALUES (?, ?, 'owner', ?, 1)", id, req.user.id, now());
      return id;
    });
    chat = q.get('SELECT * FROM chats WHERE id = ?', cid);
  } else if (meName && chat.import_me !== meName) {
    q.run('UPDATE chats SET import_me = ? WHERE id = ?', meName, chat.id);
  }
  const have = q.get('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', chat.id).n;
  res.status(201).json({ chat_id: chat.id, existing: have });
});

/** Texts: [{ key, ts, author, text, reply_to }] in chronological order. Returns the local id for each key. */
importer.post('/import/telegram/:id/batch', (req, res) => {
  const chat = ownImport(req);
  if (!rateLimit(`importb:${req.user.id}`, 1500, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const list = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!list.length || list.length > 400) throw new HttpError(400, 'invalid_input');
  const ids = [];
  tx(() => {
    for (const x of list) {
      const key = clean(x?.key, 40);
      if (!key) { ids.push(null); continue; }
      const dup = q.get('SELECT id FROM messages WHERE chat_id = ? AND import_key = ?', chat.id, key);
      if (dup) { ids.push(dup.id); continue; }
      const text = clean(x.text, LIMITS.TEXT_MAX);
      if (!text) { ids.push(null); continue; }
      const reply = Number.isInteger(x.reply_to) && q.get('SELECT 1 AS n FROM messages WHERE id = ? AND chat_id = ?', x.reply_to, chat.id) ? x.reply_to : null;
      const r = q.run(
        "INSERT INTO messages (chat_id, sender_id, kind, text, reply_to, forward_from, import_author, import_key, created_at) VALUES (?,?, 'text', ?,?,?,?,?,?)",
        chat.id, req.user.id, text, reply, x.forwarded ? clean(x.forwarded, 64) : null, clean(x.author, 64) || '?', key, when(x.ts),
      );
      ids.push(Number(r.lastInsertRowid));
    }
  });
  res.json({ ids });
});

/** One media file with its caption: raw body, details in the query. */
importer.post('/import/telegram/:id/file', async (req, res) => {
  const chat = ownImport(req);
  if (!rateLimit(`importf:${req.user.id}`, 4000, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const key = clean(req.query.key, 40);
  if (!key) throw new HttpError(400, 'invalid_input');
  const dup = q.get('SELECT id FROM messages WHERE chat_id = ? AND import_key = ?', chat.id, key);
  if (dup) { req.resume(); return res.json({ id: dup.id, duplicate: true }); }
  const name = checkName(str(String(req.query.name ?? 'file'), 'name', { min: 1, max: 200 }));
  const caption = clean(req.query.caption, LIMITS.TEXT_MAX);
  const voice = req.query.voice === '1';
  const duration = seconds(req.query.duration) ?? null;
  const reply = int(req.query.reply_to, 'reply_to', { optional: true });
  const fid = rid(16);
  const dest = filePath(fid);
  const size = await receive(req, dest, config.maxUploadBytes);
  if (size === 0) { removeFile(fid); throw new HttpError(400, 'empty_file'); }
  try { assertQuota(req.user, size); } catch (e) { removeFile(fid); throw e; }
  const type = sniff(readHead(dest), voice);
  const mime = type?.mime ?? 'application/octet-stream';
  const kind = type?.kind ?? 'file';
  q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', fid, req.user.id, chat.id, name, mime, size, now());
  const replyTo = reply && q.get('SELECT 1 AS n FROM messages WHERE id = ? AND chat_id = ?', reply, chat.id) ? reply : null;
  const r = q.run(
    'INSERT INTO messages (chat_id, sender_id, kind, text, reply_to, file_id, duration, import_author, import_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    chat.id, req.user.id, kind, caption, replyTo, fid, ['voice', 'audio', 'video'].includes(kind) ? duration : null, clean(req.query.author, 64) || '?', key, when(req.query.ts),
  );
  res.status(201).json({ id: Number(r.lastInsertRowid) });
});

/** The chat shows up in the list once the import is done. */
importer.post('/import/telegram/:id/finish', (req, res) => {
  const chat = ownImport(req);
  const last = q.get('SELECT id, created_at FROM messages WHERE chat_id = ? ORDER BY created_at DESC, id DESC LIMIT 1', chat.id);
  if (!last) throw new HttpError(400, 'nothing_imported');
  const lastId = q.get('SELECT MAX(id) AS n FROM messages WHERE chat_id = ?', chat.id).n;
  q.run('UPDATE chats SET last_message_id = ?, last_message_at = ? WHERE id = ?', last.id, last.created_at, chat.id);
  q.run('UPDATE members SET hidden = 0, last_read_id = ?, last_delivered_id = ? WHERE chat_id = ? AND user_id = ?', lastId, lastId, chat.id, req.user.id);
  const out = chatOut(chat.id, req.user.id);
  emit([req.user.id], { type: 'chat.update', chat: out });
  res.json({ chat: out, count: q.get('SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?', chat.id).n });
});
