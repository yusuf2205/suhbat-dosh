// User-facing extras: chat folders, scheduled messages & reminders, polls, global search, data export.
import express from 'express';
import { config } from './config.js';
import { db, q, tx } from './db.js';
import { EVENTS, LIMITS } from '../../shared/contracts.js';
import {
  HttpError, escapeLike, int, log, now, rateLimit, str,
} from './util.js';
import { emit } from './realtime.js';
import {
  chatOut, getMessage, getUser, memberIds, membership, messageOut, publicUser, requireMember,
} from './service.js';
import { serviceMessage } from './notify.js';

let host = { postMessage: null };
export function wireFeatures(h) { host = h; }

export const features = express.Router();

// ------------------------------------------------------------------ folders
const folderOut = (f) => ({
  id: f.id, name: f.name, emoji: f.emoji, position: f.position,
  chat_ids: q.all('SELECT chat_id FROM folder_chats WHERE folder_id = ?', f.id).map((r) => r.chat_id),
});
const foldersOf = (uid) => q.all('SELECT * FROM folders WHERE user_id = ? ORDER BY position, id', uid).map(folderOut);
const pushFolders = (uid) => emit([uid], { type: 'folders.update', folders: foldersOf(uid) });

function cleanChatIds(uid, ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const raw of ids.slice(0, 500)) {
    const id = Number(raw);
    if (Number.isInteger(id) && membership(id, uid)) out.push(id);
  }
  return [...new Set(out)];
}

features.get('/folders', (req, res) => res.json({ folders: foldersOf(req.user.id) }));

features.post('/folders', (req, res) => {
  if (q.get('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?', req.user.id).n >= 20) throw new HttpError(400, 'too_many_folders');
  const name = str(req.body?.name, 'name', { min: 1, max: 24 });
  const emoji = str(String(req.body?.emoji ?? ''), 'emoji', { max: 8 });
  const ids = cleanChatIds(req.user.id, req.body?.chat_ids);
  const pos = q.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM folders WHERE user_id = ?', req.user.id).n;
  const r = q.run('INSERT INTO folders (user_id, name, emoji, position, created_at) VALUES (?,?,?,?,?)', req.user.id, name, emoji, pos, now());
  const fid = Number(r.lastInsertRowid);
  for (const c of ids) q.run('INSERT OR IGNORE INTO folder_chats (folder_id, chat_id) VALUES (?,?)', fid, c);
  pushFolders(req.user.id);
  res.status(201).json({ folders: foldersOf(req.user.id) });
});

features.patch('/folders/:id', (req, res) => {
  const f = q.get('SELECT * FROM folders WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!f) throw new HttpError(404, 'not_found');
  const b = req.body || {};
  if (b.name !== undefined) q.run('UPDATE folders SET name = ? WHERE id = ?', str(b.name, 'name', { min: 1, max: 24 }), f.id);
  if (b.emoji !== undefined) q.run('UPDATE folders SET emoji = ? WHERE id = ?', str(String(b.emoji), 'emoji', { max: 8 }), f.id);
  if (b.chat_ids !== undefined) {
    const ids = cleanChatIds(req.user.id, b.chat_ids);
    tx(() => {
      q.run('DELETE FROM folder_chats WHERE folder_id = ?', f.id);
      for (const c of ids) q.run('INSERT OR IGNORE INTO folder_chats (folder_id, chat_id) VALUES (?,?)', f.id, c);
    });
  }
  pushFolders(req.user.id);
  res.json({ folders: foldersOf(req.user.id) });
});

features.delete('/folders/:id', (req, res) => {
  q.run('DELETE FROM folders WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  pushFolders(req.user.id);
  res.json({ folders: foldersOf(req.user.id) });
});

// ------------------------------------------------------------------ pinned chats
features.post('/chats/:id/pin-chat', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const on = req.body?.pinned !== false;
  if (on && q.get('SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND pinned_at IS NOT NULL', req.user.id).n >= 10) {
    throw new HttpError(400, 'too_many_pins');
  }
  q.run('UPDATE members SET pinned_at = ? WHERE chat_id = ? AND user_id = ?', on ? now() : null, id, req.user.id);
  const chat = chatOut(id, req.user.id);
  emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat });
  res.json({ chat });
});

features.post('/chats/:id/sound', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const v = req.body?.sound;
  const sound = v === null || v === 'default' ? null : ['none', 'chime', 'pop', 'bell'].includes(v) ? v : undefined;
  if (sound === undefined) throw new HttpError(400, 'invalid_input');
  q.run('UPDATE members SET sound = ? WHERE chat_id = ? AND user_id = ?', sound, id, req.user.id);
  const chat = chatOut(id, req.user.id);
  emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat });
  res.json({ chat });
});

// ------------------------------------------------------------------ scheduled messages and reminders
const schedOut = (s) => ({ id: s.id, kind: s.kind, chat_id: s.chat_id, text: s.text, reply_to: s.reply_to, send_at: s.send_at, created_at: s.created_at });
const MAX_AHEAD = 366 * 86400_000;

function parseWhen(v) {
  const at = Number(v);
  if (!Number.isFinite(at) || at < now() + 5_000 || at > now() + MAX_AHEAD) throw new HttpError(400, 'invalid_time');
  return Math.round(at);
}

features.get('/scheduled', (req, res) => {
  res.json({ scheduled: q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at LIMIT 200', req.user.id).map(schedOut) });
});

features.post('/chats/:id/schedule', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  if (q.get('SELECT COUNT(*) AS n FROM scheduled WHERE user_id = ?', req.user.id).n >= 100) throw new HttpError(400, 'too_many_scheduled');
  const text = str(req.body?.text, 'text', { min: 1, max: LIMITS.TEXT_MAX });
  const at = parseWhen(req.body?.send_at);
  const reply = int(req.body?.reply_to, 'reply_to', { optional: true }) ?? null;
  q.run("INSERT INTO scheduled (user_id, chat_id, kind, text, reply_to, send_at, created_at) VALUES (?,?,'message',?,?,?,?)", req.user.id, id, text, reply, at, now());
  res.status(201).json({ scheduled: q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at', req.user.id).map(schedOut) });
});

features.post('/reminders', (req, res) => {
  if (q.get('SELECT COUNT(*) AS n FROM scheduled WHERE user_id = ?', req.user.id).n >= 100) throw new HttpError(400, 'too_many_scheduled');
  const text = str(req.body?.text, 'text', { min: 1, max: 500 });
  const at = parseWhen(req.body?.send_at);
  const chat = int(req.body?.chat_id, 'chat_id', { optional: true });
  if (chat !== undefined) requireMember(chat, req.user.id);
  q.run("INSERT INTO scheduled (user_id, chat_id, kind, text, send_at, created_at) VALUES (?,?,'reminder',?,?,?)", req.user.id, chat ?? null, text, at, now());
  res.status(201).json({ scheduled: q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at', req.user.id).map(schedOut) });
});

features.delete('/scheduled/:id', (req, res) => {
  q.run('DELETE FROM scheduled WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  res.json({ scheduled: q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at', req.user.id).map(schedOut) });
});

function runDue() {
  const due = q.all('SELECT * FROM scheduled WHERE send_at <= ? ORDER BY send_at LIMIT 50', now());
  for (const s of due) {
    q.run('DELETE FROM scheduled WHERE id = ?', s.id);
    try {
      const user = getUser(s.user_id);
      if (!user || user.banned_at) continue;
      if (s.kind === 'reminder') {
        serviceMessage(s.user_id, `⏰ Напоминание: ${s.text}`);
      } else if (membership(s.chat_id, s.user_id)) {
        const chat = q.get('SELECT * FROM chats WHERE id = ?', s.chat_id);
        const replyTo = s.reply_to && q.get('SELECT 1 AS x FROM messages WHERE id = ? AND chat_id = ?', s.reply_to, s.chat_id) ? s.reply_to : null;
        host.postMessage({ chat, user, text: s.text, replyTo });
      }
    } catch (e) { log('error', 'scheduled send failed', { id: s.id, err: e.message }); }
  }
}
export function startScheduler() {
  setInterval(runDue, 10_000).unref();
}

// ------------------------------------------------------------------ polls
const pollMessageUpdate = (messageId) => {
  const m = getMessage(messageId);
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(m) });
  return messageOut(m);
};

features.post('/chats/:id/polls', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type === 'channel' && me.role === 'member') throw new HttpError(403, 'channel_readonly');
  if (!rateLimit(`poll:${req.user.id}`, 10, 60_000)) throw new HttpError(429, 'slow_down');
  const question = str(req.body?.question, 'question', { min: 1, max: 255 });
  const raw = Array.isArray(req.body?.options) ? req.body.options : [];
  const options = raw.map((o) => (typeof o === 'string' ? str(o, 'option', { max: 100 }) : '')).filter(Boolean);
  if (options.length < 2 || options.length > 10) throw new HttpError(400, 'invalid_input', 'options 2..10');
  const out = host.postMessage({ chat, user: req.user, text: question, kind: 'poll' });
  q.run('INSERT INTO polls (message_id, question, options, multiple) VALUES (?,?,?,?)', out.message.id, question, JSON.stringify(options), req.body?.multiple ? 1 : 0);
  res.status(201).json({ message: pollMessageUpdate(out.message.id) });
});

features.post('/polls/:id/vote', (req, res) => {
  const p = q.get('SELECT * FROM polls WHERE id = ?', int(req.params.id, 'id'));
  if (!p) throw new HttpError(404, 'not_found');
  const m = getMessage(p.message_id);
  requireMember(m.chat_id, req.user.id);
  if (p.closed) throw new HttpError(400, 'poll_closed');
  const n = JSON.parse(p.options).length;
  const picks = [...new Set((Array.isArray(req.body?.options) ? req.body.options : []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  if (!p.multiple && picks.length > 1) throw new HttpError(400, 'invalid_input');
  tx(() => {
    q.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', p.id, req.user.id);
    for (const i of picks) q.run('INSERT INTO poll_votes (poll_id, user_id, option) VALUES (?,?,?)', p.id, req.user.id, i);
  });
  res.json({ message: pollMessageUpdate(p.message_id) });
});

features.post('/polls/:id/close', (req, res) => {
  const p = q.get('SELECT * FROM polls WHERE id = ?', int(req.params.id, 'id'));
  if (!p) throw new HttpError(404, 'not_found');
  const m = getMessage(p.message_id);
  requireMember(m.chat_id, req.user.id);
  if (m.sender_id !== req.user.id) throw new HttpError(403, 'forbidden');
  q.run('UPDATE polls SET closed = 1 WHERE id = ?', p.id);
  res.json({ message: pollMessageUpdate(p.message_id) });
});

// ------------------------------------------------------------------ search across every chat, with filters
features.get('/search/global', (req, res) => {
  if (!rateLimit(`gsearch:${req.user.id}`, 30, 60_000)) throw new HttpError(429, 'too_many_requests');
  const term = str(String(req.query.q ?? ''), 'q', { max: 100 });
  const from = int(req.query.from_user, 'from_user', { optional: true });
  const type = ['text', 'image', 'video', 'voice', 'audio', 'file', 'link', 'poll'].includes(req.query.type) ? req.query.type : null;
  const since = int(req.query.since, 'since', { min: 0, optional: true });
  const until = int(req.query.until, 'until', { min: 0, optional: true });
  const chatType = ['direct', 'group', 'channel'].includes(req.query.chat_type) ? req.query.chat_type : null;
  if (term.length < 2 && !from && !type && !since && !until) throw new HttpError(400, 'invalid_input', 'query too short');
  const where = ['m.id > MAX(mb.cleared_before, 0)'];
  const params = [req.user.id];
  if (term.length >= 2) { where.push("m.text LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(term)}%`); }
  if (from) { where.push('m.sender_id = ?'); params.push(from); }
  if (since !== undefined) { where.push('m.created_at >= ?'); params.push(since); }
  if (until !== undefined) { where.push('m.created_at <= ?'); params.push(until); }
  if (chatType) { where.push('c.type = ?'); params.push(chatType); }
  if (type === 'link') where.push("m.kind = 'text' AND (m.text LIKE '%http://%' OR m.text LIKE '%https://%')");
  else if (type === 'text') where.push("m.kind = 'text'");
  else if (type) { where.push('m.kind = ?'); params.push(type); }
  const rows = db.prepare(
    `SELECT m.*, c.type AS chat_type, c.title AS chat_title FROM messages m
     JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0
     JOIN chats c ON c.id = m.chat_id
     WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT 60`,
  ).all(...params);
  res.json({
    results: rows.map((r) => {
      let chatTitle = r.chat_title;
      if (r.chat_type === 'direct') {
        const peer = q.get('SELECT u.* FROM members mm JOIN users u ON u.id = mm.user_id WHERE mm.chat_id = ? AND mm.user_id != ?', r.chat_id, req.user.id)
          || getUser(req.user.id);
        chatTitle = peer?.name || '';
      }
      const sender = r.sender_id ? publicUser(getUser(r.sender_id), req.user.id) : null;
      return { message: messageOut(r), chat_type: r.chat_type, chat_title: chatTitle, sender_name: sender?.name || '' };
    }),
  });
});

// ------------------------------------------------------------------ export all personal data (JSON)
features.get('/export', (req, res) => {
  if (!rateLimit(`export:${req.user.id}`, 3, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const me = getUser(req.user.id);
  const chats = q.all(
    `SELECT c.*, mb.cleared_before FROM chats c JOIN members mb ON mb.chat_id = c.id
     WHERE mb.user_id = ? AND mb.banned = 0 ORDER BY c.id`, me.id,
  );
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="suhbat-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.write(`{"exported_at":${now()},"user":${JSON.stringify({ id: me.id, name: me.name, username: me.username, phone: me.phone?.startsWith('email:') ? null : me.phone, email: me.email, bio: me.bio })},"chats":[`);
  chats.forEach((c, i) => {
    let title = c.title;
    if (c.type === 'direct') {
      const peer = q.get('SELECT u.name FROM members mm JOIN users u ON u.id = mm.user_id WHERE mm.chat_id = ? AND mm.user_id != ?', c.id, me.id);
      title = peer?.name || me.name;
    }
    const messages = q.all(
      `SELECT m.id, m.sender_id, u.name AS sender, m.kind, m.text, m.created_at, m.edited_at, f.name AS file_name, f.size AS file_size
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id LEFT JOIN files f ON f.id = m.file_id
       WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id`, c.id, c.cleared_before || 0,
    );
    res.write(`${i ? ',' : ''}${JSON.stringify({ id: c.id, type: c.type, title, messages })}`);
  });
  res.end(']}');
});
