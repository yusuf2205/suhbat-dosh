// Safety & housekeeping: auto-delete timers, abuse reports, spam guard, storage quotas, stories.
import express from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';
import { EVENTS, LIMITS } from '../../shared/contracts.js';
import {
  HttpError, int, log, now, rateLimit, rid, str,
} from './util.js';
import { dropSession, emit } from './realtime.js';
import {
  audit, chatOut, getMessage, getUser, isContact, isBlockedEitherWay, memberIds, membership, publicUser, refreshLastMessage, requireMember,
} from './service.js';
import { getSetting } from './access.js';
import { notifyAdmins } from './notify.js';
import {
  filePath, readHead, receive, removeFile, sniff,
} from './files.js';

export const safety = express.Router();

// ------------------------------------------------------------------ storage quota
export function quotaFor(user) {
  if (user.quota_bytes !== null && user.quota_bytes !== undefined) return Number(user.quota_bytes);
  return Math.max(0, Number(getSetting('quota_default_mb', '0'))) * 1024 * 1024; // 0 = unlimited
}
export const usedBytes = (userId) => q.get('SELECT COALESCE(SUM(size), 0) AS n FROM files WHERE owner_id = ? AND chat_id IS NOT NULL', userId).n;

/** Throws when adding `size` bytes would exceed the user's quota. */
export function assertQuota(user, size) {
  const quota = quotaFor(user);
  if (quota > 0 && usedBytes(user.id) + size > quota) throw new HttpError(413, 'quota_exceeded');
}

safety.get('/me/usage', (req, res) => {
  res.json({ used: usedBytes(req.user.id), quota: quotaFor(getUser(req.user.id)) });
});

// ------------------------------------------------------------------ auto-delete timer
const TTLS = [0, 3600, 86400, 604800, 2592000];

safety.post('/chats/:id/ttl', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type !== 'direct' && me.role === 'member') throw new HttpError(403, 'forbidden');
  const sec = Number(req.body?.seconds);
  if (!TTLS.includes(sec)) throw new HttpError(400, 'invalid_input');
  q.run('UPDATE chats SET ttl_seconds = ? WHERE id = ?', sec, id);
  audit(req.user.id, 'chat.ttl', { chat_id: id, target_type: 'chat', target_id: id, details: { seconds: sec } });
  for (const uid of memberIds(id)) emit([uid], { type: EVENTS.CHAT_UPDATE, chat: chatOut(id, uid) });
  res.json({ chat: chatOut(id, req.user.id) });
});

export function purgeExpired() {
  // the timer hides expired messages for everyone (history watermark); the data itself stays on the server
  const chats = q.all('SELECT id, ttl_seconds FROM chats WHERE ttl_seconds > 0');
  for (const c of chats) {
    const floor = q.get('SELECT MIN(cleared_before) AS n FROM members WHERE chat_id = ?', c.id)?.n || 0;
    const rows = q.all(
      'SELECT id FROM messages WHERE chat_id = ? AND id > ? AND created_at < ? ORDER BY id LIMIT 500',
      c.id, floor, now() - c.ttl_seconds * 1000,
    );
    if (!rows.length) continue;
    const upTo = rows[rows.length - 1].id;
    q.run('UPDATE members SET cleared_before = MAX(cleared_before, ?), last_read_id = MAX(last_read_id, ?) WHERE chat_id = ?', upTo, upTo, c.id);
    refreshLastMessage(c.id);
    const ids = memberIds(c.id);
    for (const m of rows) emit(ids, { type: EVENTS.MESSAGE_DELETE, chat_id: c.id, message_id: m.id });
    for (const uid of ids) emit([uid], { type: EVENTS.CHAT_UPDATE, chat: chatOut(c.id, uid) });
  }
}

// ------------------------------------------------------------------ reports + spam guard
safety.post('/messages/:id/report', (req, res) => {
  if (!rateLimit(`report:${req.user.id}`, 10, 3600_000)) throw new HttpError(429, 'slow_down');
  const m = getMessage(int(req.params.id, 'id'));
  if (!m || !membership(m.chat_id, req.user.id)) throw new HttpError(404, 'not_found');
  if (m.sender_id === req.user.id) throw new HttpError(400, 'invalid_input');
  const reason = str(String(req.body?.reason ?? 'other'), 'reason', { max: 120 }) || 'other';
  if (q.get('SELECT 1 AS x FROM reports WHERE reporter_id = ? AND message_id = ?', req.user.id, m.id)) return res.json({ ok: true });
  q.run(
    'INSERT INTO reports (reporter_id, message_id, chat_id, sender_id, reason, snapshot, created_at) VALUES (?,?,?,?,?,?,?)',
    req.user.id, m.id, m.chat_id, m.sender_id, reason, (m.text || `[${m.kind}]`).slice(0, 500), now(),
  );
  audit(req.user.id, 'message.report', { chat_id: m.chat_id, target_type: 'message', target_id: m.id, details: { reason } });
  notifyAdmins(`🚩 Новая жалоба на сообщение: «${(m.text || m.kind).slice(0, 80)}» — причина: ${reason}. Откройте консоль → Жалобы.`);
  return res.json({ ok: true });
});

const recent = new Map(); // userId -> [{ h, chat, t }]

/** Same text pushed into many different chats in a few minutes = spam: the account is blocked and admins are told. */
export function checkSpam(user, chat, text) {
  if (!text || text.length < 8 || user.is_admin || user.is_bot) return;
  const h = crypto.createHash('sha1').update(text.trim().toLowerCase()).digest('hex');
  const t = now();
  const list = (recent.get(user.id) || []).filter((x) => t - x.t < 5 * 60_000);
  list.push({ h, chat: chat.id, t });
  recent.set(user.id, list);
  const chats = new Set(list.filter((x) => x.h === h).map((x) => x.chat));
  if (chats.size >= 5) {
    q.run("UPDATE users SET banned_at = ?, ban_reason = 'авто: рассылка одного текста в 5+ чатов' WHERE id = ?", t, user.id);
    for (const s of q.all('SELECT id FROM sessions WHERE user_id = ? AND revoked = 0', user.id)) dropSession(s.id);
    q.run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', user.id);
    audit(null, 'admin.auto_ban', { target_type: 'user', target_id: String(user.id), details: { reason: 'spam' } });
    notifyAdmins(`🛑 Автоблокировка за спам: ${user.name}${user.username ? ` (@${user.username})` : ''}. Один текст отправлен в ${chats.size} чатов за 5 минут. Разблокировать можно в консоли → Пользователи.`);
    recent.delete(user.id);
  }
}
setInterval(() => { const t = now(); for (const [k, v] of recent) if (!v.some((x) => t - x.t < 5 * 60_000)) recent.delete(k); }, 60_000).unref();

// admin side (mounted under /api/admin by admin.js)
export const safetyAdmin = express.Router();

safetyAdmin.get('/reports', (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  const rows = q.all('SELECT * FROM reports WHERE status = ? ORDER BY id DESC LIMIT 200', status);
  const who = (id) => { const u = id ? getUser(id) : null; return u ? { id: u.id, name: u.name, username: u.username } : null; };
  res.json({
    reports: rows.map((r) => ({
      id: r.id, reason: r.reason, snapshot: r.snapshot, status: r.status, resolution: r.resolution, created_at: r.created_at,
      chat_id: r.chat_id, message_id: r.message_id, reporter: who(r.reporter_id), sender: who(r.sender_id),
    })),
  });
});

safetyAdmin.post('/reports/:id/resolve', (req, res) => {
  const r = q.get('SELECT * FROM reports WHERE id = ?', int(req.params.id, 'id'));
  if (!r) throw new HttpError(404, 'not_found');
  const action = ['dismiss', 'delete', 'ban'].includes(req.body?.action) ? req.body.action : 'dismiss';
  if (action === 'delete' && r.message_id) {
    const m = getMessage(r.message_id);
    if (m) {
      q.run('DELETE FROM messages WHERE id = ?', m.id);
      refreshLastMessage(m.chat_id);
      emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_DELETE, chat_id: m.chat_id, message_id: m.id });
    }
  }
  if (action === 'ban' && r.sender_id) {
    const u = getUser(r.sender_id);
    if (u && !u.is_admin) {
      q.run("UPDATE users SET banned_at = ?, ban_reason = 'жалоба' WHERE id = ?", now(), u.id);
      for (const s of q.all('SELECT id FROM sessions WHERE user_id = ? AND revoked = 0', u.id)) dropSession(s.id);
      q.run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', u.id);
    }
  }
  q.run("UPDATE reports SET status = 'resolved', resolution = ?, resolved_at = ?, resolved_by = ? WHERE id = ?", action, now(), req.user.id, r.id);
  audit(req.user.id, 'admin.report_resolve', { target_type: 'report', target_id: String(r.id), ip: req.ip, details: { action } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ stories (24 h, then the author's archive)
const DAY = 86400_000;
const BG = new Set(['#fbc700', '#2563eb', '#16a34a', '#db2777', '#7c3aed', '#ea580c', '#0f172a']);

function storyOut(s, viewerId) {
  const views = q.get('SELECT COUNT(*) AS n FROM story_views WHERE story_id = ?', s.id).n;
  return {
    id: s.id, user_id: s.user_id, text: s.text, bg: s.bg, created_at: s.created_at, expires_at: s.expires_at,
    media: s.file_id ? `/api/stories/${s.id}/media` : null,
    seen: s.user_id === viewerId || !!q.get('SELECT 1 AS x FROM story_views WHERE story_id = ? AND user_id = ?', s.id, viewerId),
    views: s.user_id === viewerId ? views : undefined,
    active: s.expires_at > now(),
  };
}

const canSeeStories = (viewerId, ownerId) => viewerId === ownerId
  || (isContact(viewerId, ownerId) && !isBlockedEitherWay(viewerId, ownerId));

safety.get('/stories', (req, res) => {
  const t = now();
  // contacts = people I have a personal chat with
  const mates = q.all(
    `SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN chats c ON c.id = m1.chat_id AND c.type = 'direct'
     JOIN members m2 ON m2.chat_id = c.id AND m2.user_id != m1.user_id WHERE m1.user_id = ?`, req.user.id,
  ).map((r) => r.id).filter((id) => !isBlockedEitherWay(req.user.id, id));
  const ids = [req.user.id, ...mates];
  const out = [];
  for (const uid of ids) {
    const list = q.all('SELECT * FROM stories WHERE user_id = ? AND expires_at > ? ORDER BY id', uid, t).map((s) => storyOut(s, req.user.id));
    if (!list.length && uid !== req.user.id) continue;
    out.push({ user: publicUser(getUser(uid), req.user.id), stories: list, all_seen: list.every((s) => s.seen) });
  }
  res.json({ feed: out });
});

safety.get('/stories/archive', (req, res) => {
  res.json({ stories: q.all('SELECT * FROM stories WHERE user_id = ? ORDER BY id DESC LIMIT 200', req.user.id).map((s) => storyOut(s, req.user.id)) });
});

safety.post('/stories', async (req, res) => {
  if (!rateLimit(`story:${req.user.id}`, 20, 3600_000)) throw new HttpError(429, 'slow_down');
  const ctype = String(req.headers['content-type'] || '');
  let text = '';
  let bg = '';
  let fid = null;
  if (ctype.includes('application/json')) {
    text = str(req.body?.text, 'text', { min: 1, max: 280 });
    bg = BG.has(req.body?.bg) ? req.body.bg : '#fbc700';
  } else {
    text = str(String(req.query.caption ?? ''), 'caption', { max: 280 });
    fid = rid(16);
    const dest = filePath(fid);
    const size = await receive(req, dest, 10 * 1024 * 1024);
    const type = sniff(readHead(dest));
    if (!type || type.kind !== 'image') { removeFile(fid); throw new HttpError(415, 'image_required'); }
    q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?,?,NULL,?,?,?,?)', fid, req.user.id, 'story', type.mime, size, now());
  }
  const r = q.run('INSERT INTO stories (user_id, file_id, text, bg, created_at, expires_at) VALUES (?,?,?,?,?,?)', req.user.id, fid, text, bg, now(), now() + DAY);
  audit(req.user.id, 'story.post', { target_type: 'story', target_id: Number(r.lastInsertRowid) });
  res.status(201).json({ story: storyOut(q.get('SELECT * FROM stories WHERE id = ?', Number(r.lastInsertRowid)), req.user.id) });
});

safety.get('/stories/:id/media', (req, res) => {
  const s = q.get('SELECT * FROM stories WHERE id = ?', int(req.params.id, 'id'));
  if (!s || !s.file_id || !canSeeStories(req.user.id, s.user_id) || (s.user_id !== req.user.id && s.expires_at < now())) throw new HttpError(404, 'not_found');
  const f = q.get('SELECT * FROM files WHERE id = ?', s.file_id);
  if (!f) throw new HttpError(404, 'not_found');
  res.setHeader('Content-Type', f.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(filePath(f.id), { dotfiles: 'allow', cacheControl: false });
});

safety.post('/stories/:id/view', (req, res) => {
  const s = q.get('SELECT * FROM stories WHERE id = ?', int(req.params.id, 'id'));
  if (!s || !canSeeStories(req.user.id, s.user_id) || s.expires_at < now()) throw new HttpError(404, 'not_found');
  if (s.user_id !== req.user.id) q.run('INSERT OR IGNORE INTO story_views (story_id, user_id, at) VALUES (?,?,?)', s.id, req.user.id, now());
  res.json({ ok: true });
});

safety.get('/stories/:id/viewers', (req, res) => {
  const s = q.get('SELECT * FROM stories WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!s) throw new HttpError(404, 'not_found');
  const rows = q.all('SELECT user_id, at FROM story_views WHERE story_id = ? ORDER BY at DESC LIMIT 200', s.id);
  res.json({ viewers: rows.map((r) => ({ user: publicUser(getUser(r.user_id), req.user.id), at: r.at })) });
});

safety.delete('/stories/:id', (req, res) => {
  const s = q.get('SELECT * FROM stories WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!s) throw new HttpError(404, 'not_found');
  q.run('DELETE FROM stories WHERE id = ?', s.id);
  if (s.file_id) { q.run('DELETE FROM files WHERE id = ?', s.file_id); removeFile(s.file_id); }
  res.json({ ok: true });
});

export function startSafetyJobs() {
  setInterval(() => { try { purgeExpired(); } catch (e) { log('error', 'purge', { err: e.message }); } }, 60_000).unref();
}
void config;
void LIMITS;
