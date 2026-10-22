import express from 'express';
import { q, tx } from './db.js';
import { HttpError, escapeLike, int, now, str } from './util.js';
import { dropSession, emit, isOnline } from './realtime.js';
import { audit, getUser, memberIds, messageOut } from './service.js';
import { filePath, removeFile } from './files.js';
import fs from 'node:fs';
import { EVENTS } from '../../shared/contracts.js';
import { ROOM_MAX_TOP, roomMax } from './groupcalls.js';
import { REGISTRATION_MODES, createInvite, getSetting, registrationMode, setSetting } from './access.js';
import { broadcast } from './notify.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { quotaFor, safetyAdmin, usedBytes } from './safety.js';
import { backupPath, createBackup, deleteBackup, filesMirror, listBackups, mirrorConfig, mirrorStatus, scheduleRestore, systemSnapshot } from './ops.js';

// Super-admin API. Every route requires users.is_admin = 1; reading private content is itself audited.
export const admin = express.Router();

admin.use((req, _res, next) => {
  if (!req.user?.is_admin) return next(new HttpError(403, 'forbidden'));
  next();
});

admin.use(safetyAdmin);

const pageSize = (v) => int(v, 'limit', { min: 1, max: 200, optional: true }) ?? 50;

const userRef = (u) => (u ? { id: u.id, name: u.name, username: u.username, phone: u.phone?.startsWith('email:') || u.phone?.startsWith('login:') ? '' : u.phone, email: u.email || null } : null);

function auditOut(r) {
  const actor = r.actor_id ? getUser(r.actor_id) : null;
  let details = null;
  try { details = r.details ? JSON.parse(r.details) : null; } catch { /* keep null */ }
  return {
    id: r.id, ts: r.ts, action: r.action, actor: userRef(actor), target_type: r.target_type, target_id: r.target_id,
    chat_id: r.chat_id, details, ip: r.ip,
  };
}

admin.get('/overview', (_req, res) => {
  const n = (sql) => q.get(sql).n;
  const day = Date.now() - 86400_000;
  res.json({
    users: n('SELECT COUNT(*) n FROM users'),
    admins: n('SELECT COUNT(*) n FROM users WHERE is_admin = 1'),
    chats: n('SELECT COUNT(*) n FROM chats'),
    messages: n('SELECT COUNT(*) n FROM messages'),
    files: n('SELECT COUNT(*) n FROM files'),
    storage_bytes: n('SELECT COALESCE(SUM(size),0) n FROM files'),
    active_sessions: n('SELECT COUNT(*) n FROM sessions WHERE revoked = 0'),
    messages_24h: q.get('SELECT COUNT(*) n FROM messages WHERE created_at > ?', day).n,
    events_24h: q.get('SELECT COUNT(*) n FROM audit_log WHERE ts > ?', day).n,
    new_users_7d: q.get('SELECT COUNT(*) n FROM users WHERE created_at > ?', Date.now() - 7 * 86400_000).n,
  });
});

// Aggregates for the dashboard charts (counts only, no content).
admin.get('/stats', (req, res) => {
  const DAY = 86400_000;
  const tz = int(req.query.tz ?? 0, 'tz', { min: -840, max: 840 }) * 60_000; // client UTC offset, minutes -> ms
  const n = int(req.query.days ?? 14, 'days', { min: 7, max: 30 });
  const now = Date.now();
  const todayStart = Math.floor((now + tz) / DAY) * DAY - tz;
  const first = todayStart - (n - 1) * DAY;
  const bucket = (sql, ...a) => {
    const m = new Map(q.all(sql, tz, DAY, ...a).map((r) => [r.d, r.n]));
    return Array.from({ length: n }, (_, i) => m.get(Math.floor((first + i * DAY + tz) / DAY)) || 0);
  };
  const messages = bucket('SELECT CAST((created_at + ?) / ? AS INTEGER) d, COUNT(*) n FROM messages WHERE created_at >= ? GROUP BY d', first);
  const users = bucket('SELECT CAST((created_at + ?) / ? AS INTEGER) d, COUNT(*) n FROM users WHERE created_at >= ? GROUP BY d', first);
  const events = bucket('SELECT CAST((ts + ?) / ? AS INTEGER) d, COUNT(*) n FROM audit_log WHERE ts >= ? GROUP BY d', first);
  const logins = bucket("SELECT CAST((ts + ?) / ? AS INTEGER) d, COUNT(*) n FROM audit_log WHERE ts >= ? AND action = 'auth.login' GROUP BY d", first);
  const calls = bucket("SELECT CAST((ts + ?) / ? AS INTEGER) d, COUNT(*) n FROM audit_log WHERE ts >= ? AND action = 'call.start' GROUP BY d", first);
  const week = now - 7 * DAY;
  const kinds = Object.fromEntries(q.all('SELECT kind, COUNT(*) n FROM messages WHERE created_at >= ? GROUP BY kind', week).map((r) => [r.kind, r.n]));
  const chatTypes = Object.fromEntries(q.all('SELECT type, COUNT(*) n FROM chats GROUP BY type').map((r) => [r.type, r.n]));
  const top = q.all(
    `SELECT u.id, u.name, u.username, u.avatar_file, COUNT(*) n FROM messages m JOIN users u ON u.id = m.sender_id
     WHERE m.created_at >= ? GROUP BY u.id ORDER BY n DESC LIMIT 5`, week).map((r) => ({ id: r.id, name: r.name, username: r.username, avatar: r.avatar_file ? `/api/admin/files/${r.avatar_file}` : null, n: r.n }));
  const onlineUsers = q.all('SELECT id FROM users').filter((r) => isOnline(r.id)).length;
  res.json({
    days: Array.from({ length: n }, (_, i) => first + i * DAY),
    series: { messages, users, events, logins, calls },
    kinds, chat_types: chatTypes, top_users: top, online: onlineUsers,
  });
});

admin.get('/users', (req, res) => {
  const term = req.query.q ? str(String(req.query.q), 'q', { max: 64 }) : '';
  const like = `%${escapeLike(term)}%`;
  const rows = q.all(
    `SELECT u.*,
       (SELECT COUNT(*) FROM messages m WHERE m.sender_id = u.id) AS msg_count,
       (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked = 0) AS sessions,
       (SELECT COUNT(*) FROM members mb WHERE mb.user_id = u.id AND mb.banned = 0) AS chats
     FROM users u
     WHERE ? = '' OR u.name LIKE ? ESCAPE '\\' OR u.username LIKE ? ESCAPE '\\' OR u.phone LIKE ? ESCAPE '\\'
     ORDER BY u.last_seen DESC LIMIT 500`,
    term, like, like, like,
  );
  res.json({
    users: rows.map((u) => ({
      ...userRef(u), is_admin: !!u.is_admin, created_at: u.created_at, last_seen: u.last_seen, online: isOnline(u.id), banned: !!u.banned_at, is_bot: !!u.is_bot, storage: usedBytes(u.id), quota: quotaFor(u),
      messages: u.msg_count, sessions: u.sessions, chats: u.chats,
    })),
  });
});

admin.get('/users/:id', (req, res) => {
  const u = getUser(int(req.params.id, 'id'));
  if (!u) throw new HttpError(404, 'not_found');
  audit(req.user.id, 'admin.view_user', { target_type: 'user', target_id: String(u.id), ip: req.ip });
  const chats = q.all(
    `SELECT c.id, c.type, c.title, c.direct_key, mb.role, mb.banned, mb.joined_at,
       (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id AND m.sender_id = ?) AS sent
     FROM members mb JOIN chats c ON c.id = mb.chat_id WHERE mb.user_id = ? ORDER BY c.last_message_at DESC`,
    u.id, u.id,
  ).map((c) => {
    let title = c.title;
    if (c.type === 'direct') {
      const peer = q.get('SELECT u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? AND m.user_id != ?', c.id, u.id);
      title = peer ? `${peer.name}${peer.username ? ` (@${peer.username})` : ''}` : '—';
    }
    return { id: c.id, type: c.type, title, role: c.role, banned: !!c.banned, joined_at: c.joined_at, sent: c.sent };
  });
  const sessions = q.all('SELECT id, device, ip, created_at, last_active, revoked FROM sessions WHERE user_id = ? ORDER BY last_active DESC LIMIT 50', u.id);
  const blocks = q.all('SELECT u.id, u.name, u.username FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?', u.id);
  res.json({
    user: {
      ...userRef(u), bio: u.bio, status: u.status, is_admin: !!u.is_admin, banned_at: u.banned_at, ban_reason: u.ban_reason, is_bot: !!u.is_bot, created_at: u.created_at, last_seen: u.last_seen,
      online: isOnline(u.id), privacy: { photo: u.privacy_photo, status: u.privacy_status, last_seen: u.privacy_last_seen },
      avatar: u.avatar_file ? `/api/admin/files/${u.avatar_file}` : null,
    },
    chats, sessions, blocks,
  });
});

admin.get('/chats', (req, res) => {
  const term = req.query.q ? str(String(req.query.q), 'q', { max: 64 }) : '';
  const like = `%${escapeLike(term)}%`;
  const rows = q.all(
    `SELECT c.*, (SELECT COUNT(*) FROM members WHERE chat_id = c.id AND banned = 0) AS members,
       (SELECT COUNT(*) FROM messages WHERE chat_id = c.id) AS messages
     FROM chats c WHERE ? = '' OR c.title LIKE ? ESCAPE '\\' ORDER BY c.last_message_at DESC LIMIT 500`,
    term, like,
  );
  res.json({
    chats: rows.map((c) => {
      let title = c.title;
      let people = [];
      if (c.type === 'direct') {
        people = q.all('SELECT u.id, u.name, u.username, u.phone FROM members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ?', c.id);
        title = people.map((p) => p.name).join(' ↔ ');
      }
      return {
        id: c.id, type: c.type, title, description: c.description, members: c.members, messages: c.messages,
        owner: userRef(c.owner_id ? getUser(c.owner_id) : null), people, last_message_at: c.last_message_at, created_at: c.created_at,
      };
    }),
  });
});

admin.get('/chats/:id', (req, res) => {
  const id = int(req.params.id, 'id');
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (!c) throw new HttpError(404, 'not_found');
  const members = q.all(
    `SELECT u.id, u.name, u.username, u.phone, m.role, m.banned, m.can_send, m.joined_at
     FROM members m JOIN users u ON u.id = m.user_id WHERE m.chat_id = ? ORDER BY m.joined_at`, id,
  );
  res.json({ chat: { id: c.id, type: c.type, title: c.title, description: c.description, created_at: c.created_at }, members });
});

// Full history of a chat, with who wrote each message and what happened to it afterwards.
admin.get('/chats/:id/messages', (req, res) => {
  const id = int(req.params.id, 'id');
  if (!q.get('SELECT 1 AS x FROM chats WHERE id = ?', id)) throw new HttpError(404, 'not_found');
  const before = int(req.query.before, 'before', { optional: true });
  const limit = pageSize(req.query.limit);
  if (before === undefined) audit(req.user.id, 'admin.view_chat', { target_type: 'chat', target_id: String(id), chat_id: id, ip: req.ip });
  const rows = q.all(
    'SELECT * FROM messages WHERE chat_id = ? AND id < ? ORDER BY id DESC LIMIT ?', id, before ?? Number.MAX_SAFE_INTEGER, limit + 1,
  );
  const more = rows.length > limit;
  const page = rows.slice(0, limit).reverse();
  const history = {};
  if (page.length) {
    const edits = q.all(
      `SELECT ts, target_id, details FROM audit_log WHERE action = 'message.edit' AND chat_id = ? ORDER BY id`, id,
    );
    for (const e of edits) (history[e.target_id] ||= []).push({ ts: e.ts, ...JSON.parse(e.details || '{}') });
  }
  const messages = page.map((m) => {
    const out = messageOut(m);
    const s = m.sender_id ? getUser(m.sender_id) : null;
    return { ...out, sender: userRef(s), edits: history[String(m.id)] || [] };
  });
  // messages that were deleted by their authors / admins are kept in the journal
  const deleted = q.all(
    `SELECT * FROM audit_log WHERE action = 'message.delete' AND chat_id = ? ORDER BY id DESC LIMIT 200`, id,
  ).map(auditOut);
  res.json({ messages, has_more: more, deleted });
});

admin.get('/audit', (req, res) => {
  const where = [];
  const params = [];
  if (req.query.actor) { where.push('actor_id = ?'); params.push(int(req.query.actor, 'actor')); }
  if (req.query.chat) { where.push('chat_id = ?'); params.push(int(req.query.chat, 'chat')); }
  if (req.query.action) { where.push('action LIKE ?'); params.push(`${str(String(req.query.action), 'action', { max: 40 })}%`); }
  if (req.query.since) { where.push('ts >= ?'); params.push(int(req.query.since, 'since', { min: 0 })); }
  if (req.query.until) { where.push('ts <= ?'); params.push(int(req.query.until, 'until', { min: 0 })); }
  if (req.query.before) { where.push('id < ?'); params.push(int(req.query.before, 'before')); }
  const limit = pageSize(req.query.limit);
  const rows = q.all(
    `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`, ...params, limit + 1,
  );
  res.json({ events: rows.slice(0, limit).map(auditOut), has_more: rows.length > limit });
});

// Any stored file (attachments, avatars) — for reviewing what was sent.
admin.get('/files/:id', (req, res) => {
  const f = q.get('SELECT * FROM files WHERE id = ?', str(req.params.id, 'id', { min: 8, max: 40 }));
  if (!f || !fs.existsSync(filePath(f.id))) throw new HttpError(404, 'not_found');
  audit(req.user.id, 'admin.view_file', { target_type: 'file', target_id: f.id, ip: req.ip, details: { name: f.name } });
  const inline = /^(image\/(jpeg|png|gif|webp)|audio\/|video\/)/.test(f.mime);
  res.setHeader('Content-Type', inline ? f.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.sendFile(filePath(f.id), { dotfiles: 'allow', cacheControl: false });
});

// ------------------------------------------------------------------ account control
const target = (req) => {
  const u = getUser(int(req.params.id, 'id'));
  if (!u) throw new HttpError(404, 'not_found');
  return u;
};

/** Block / unblock an account: all its sessions end at once and it cannot sign in. */
admin.post('/users/:id/ban', (req, res) => {
  const u = target(req);
  if (u.id === req.user.id) throw new HttpError(400, 'cannot_self');
  const banned = req.body?.banned !== false;
  if (banned && u.is_admin) throw new HttpError(400, 'cannot_ban_admin');
  const reason = banned ? str(String(req.body?.reason ?? ''), 'reason', { max: 200 }) : null;
  q.run('UPDATE users SET banned_at = ?, ban_reason = ? WHERE id = ?', banned ? now() : null, reason, u.id);
  if (banned) {
    for (const s of q.all('SELECT id FROM sessions WHERE user_id = ? AND revoked = 0', u.id)) dropSession(s.id);
    q.run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', u.id);
  }
  audit(req.user.id, banned ? 'admin.ban_user' : 'admin.unban_user', { target_type: 'user', target_id: String(u.id), ip: req.ip, details: { reason } });
  res.json({ ok: true, banned });
});

/** Sign the account out everywhere. */
admin.post('/users/:id/logout', (req, res) => {
  const u = target(req);
  for (const s of q.all('SELECT id FROM sessions WHERE user_id = ? AND revoked = 0', u.id)) dropSession(s.id);
  q.run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', u.id);
  audit(req.user.id, 'admin.logout_user', { target_type: 'user', target_id: String(u.id), ip: req.ip });
  res.json({ ok: true });
});

/** Promote / demote a super administrator. The last one cannot be removed. */
admin.post('/users/:id/admin', (req, res) => {
  const u = target(req);
  const on = req.body?.is_admin === true;
  if (u.is_bot) throw new HttpError(400, 'invalid_input');
  if (!on && u.is_admin && q.get('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1').n <= 1) throw new HttpError(400, 'last_admin');
  q.run('UPDATE users SET is_admin = ? WHERE id = ?', on ? 1 : 0, u.id);
  audit(req.user.id, on ? 'admin.grant_admin' : 'admin.revoke_admin', { target_type: 'user', target_id: String(u.id), ip: req.ip });
  res.json({ ok: true, is_admin: on });
});

/** Delete an account with its personal chats; messages it wrote in groups stay (shown as a deleted user). */
admin.delete('/users/:id', (req, res) => {
  const u = target(req);
  if (u.id === req.user.id) throw new HttpError(400, 'cannot_self');
  if (u.is_admin) throw new HttpError(400, 'cannot_ban_admin');
  const chats = q.all("SELECT c.id FROM chats c JOIN members m ON m.chat_id = c.id WHERE m.user_id = ? AND c.type = 'direct'", u.id).map((r) => r.id);
  const watchers = new Map(chats.map((id) => [id, memberIds(id).filter((x) => x !== u.id)]));
  const fileIds = [];
  tx(() => {
    for (const id of chats) {
      fileIds.push(...q.all('SELECT id FROM files WHERE chat_id = ?', id).map((r) => r.id));
      q.run('DELETE FROM chats WHERE id = ?', id);
    }
    fileIds.push(...q.all('SELECT id FROM files WHERE owner_id = ? AND chat_id IS NULL', u.id).map((r) => r.id));
    for (const s of q.all('SELECT id FROM sessions WHERE user_id = ?', u.id)) dropSession(s.id);
    q.run('DELETE FROM users WHERE id = ?', u.id);
  });
  for (const f of fileIds) removeFile(f);
  for (const [id, uids] of watchers) emit(uids, { type: EVENTS.CHAT_REMOVE, chat_id: id });
  audit(req.user.id, 'admin.delete_user', { target_type: 'user', target_id: String(u.id), ip: req.ip, details: { name: u.name, username: u.username } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ registration, invitations
admin.get('/settings', (_req, res) => {
  res.json({ registration: registrationMode(), modes: REGISTRATION_MODES, set: getSetting('registration') !== null, quota_default_mb: Number(getSetting('quota_default_mb', '0')), gcall_max: roomMax(), gcall_max_top: ROOM_MAX_TOP, stories_audience: getSetting('stories_audience', '0') === '1' });
});

admin.put('/settings', (req, res) => {
  if (req.body?.quota_default_mb !== undefined) {
    const mb = int(req.body.quota_default_mb, 'quota_default_mb', { min: 0, max: 1_000_000 });
    setSetting('quota_default_mb', mb);
    audit(req.user.id, 'admin.settings', { ip: req.ip, details: { quota_default_mb: mb } });
    if (req.body.registration === undefined && req.body.gcall_max === undefined && req.body.stories_audience === undefined) return res.json({ quota_default_mb: mb });
  }
  if (req.body?.gcall_max !== undefined) {
    const n = int(req.body.gcall_max, 'gcall_max', { min: 2, max: ROOM_MAX_TOP });
    setSetting('gcall_max', n);
    audit(req.user.id, 'admin.settings', { ip: req.ip, details: { gcall_max: n } });
    if (req.body.registration === undefined) return res.json({ gcall_max: n });
  }
  if (req.body?.stories_audience !== undefined) {
    setSetting('stories_audience', req.body.stories_audience ? '1' : '0');
    audit(req.user.id, 'admin.settings', { ip: req.ip, details: { stories_audience: !!req.body.stories_audience } });
    if (req.body.registration === undefined) return res.json({ stories_audience: !!req.body.stories_audience });
  }
  const mode = req.body?.registration;
  if (!REGISTRATION_MODES.includes(mode)) throw new HttpError(400, 'invalid_input');
  setSetting('registration', mode);
  audit(req.user.id, 'admin.settings', { ip: req.ip, details: { registration: mode } });
  return res.json({ registration: mode });
});

const inviteOut = (i) => ({
  id: i.id, code: i.code, note: i.note, created_at: i.created_at, expires_at: i.expires_at, max_uses: i.max_uses, uses: i.uses,
  active: i.uses < i.max_uses && (!i.expires_at || i.expires_at > now()),
});

admin.get('/invites', (_req, res) => {
  res.json({ invites: q.all('SELECT * FROM invites ORDER BY id DESC LIMIT 200').map(inviteOut) });
});

admin.post('/invites', (req, res) => {
  const b = req.body || {};
  const code = createInvite({
    by: req.user.id, note: str(String(b.note ?? ''), 'note', { max: 120 }),
    maxUses: int(b.max_uses ?? 1, 'max_uses', { min: 1, max: 1000 }), ttlDays: int(b.ttl_days ?? 0, 'ttl_days', { min: 0, max: 365 }),
  });
  audit(req.user.id, 'admin.invite_create', { ip: req.ip, details: { max_uses: b.max_uses ?? 1 } });
  res.status(201).json({ invite: inviteOut(q.get('SELECT * FROM invites WHERE code = ?', code)) });
});

admin.delete('/invites/:id', (req, res) => {
  q.run('DELETE FROM invites WHERE id = ?', int(req.params.id, 'id'));
  res.json({ ok: true });
});

// ------------------------------------------------------------------ broadcast from the service account
admin.post('/broadcast', (req, res) => {
  const text = str(req.body?.text, 'text', { min: 1, max: 2000 });
  const sent = broadcast(text);
  audit(req.user.id, 'admin.broadcast', { ip: req.ip, details: { recipients: sent, length: text.length, text: text.slice(0, 300) } });
  res.json({ sent });
});

// ------------------------------------------------------------------ server health & backups
admin.get('/system', (_req, res) => res.json(systemSnapshot()));

admin.get('/backups', (_req, res) => res.json({ backups: listBackups(), mirror: { ...mirrorConfig(), last: mirrorStatus.last }, files_mirror: filesMirror.last }));

admin.post('/backups', (req, res) => {
  const b = createBackup('manual');
  audit(req.user.id, 'admin.backup_create', { ip: req.ip, details: { name: b.name, size: b.size } });
  res.status(201).json({ backup: b });
});

admin.get('/backups/:name', (req, res) => {
  audit(req.user.id, 'admin.backup_download', { ip: req.ip, details: { name: req.params.name } });
  res.download(backupPath(req.params.name));
});

admin.delete('/backups/:name', (req, res) => {
  deleteBackup(req.params.name);
  audit(req.user.id, 'admin.backup_delete', { ip: req.ip, details: { name: req.params.name } });
  res.json({ ok: true });
});

admin.post('/backups/:name/restore', (req, res) => {
  if (req.body?.confirm !== true) throw new HttpError(400, 'confirm_required');
  createBackup('pre-restore');
  const name = scheduleRestore(req.params.name);
  audit(req.user.id, 'admin.backup_restore', { ip: req.ip, details: { name } });
  res.json({ ok: true, restarting: true });
});

// ------------------------------------------------------------------ call quality per user (figures only)
admin.get('/call-quality', (req, res) => {
  const days = int(req.query.days ?? 30, 'days', { min: 1, max: 90 });
  const since = now() - days * 86400_000;
  const rows = q.all("SELECT actor_id, details FROM audit_log WHERE action = 'call.quality' AND ts >= ? ORDER BY id DESC LIMIT 20000", since);
  const by = new Map();
  for (const r of rows) {
    let d;
    try { d = JSON.parse(r.details || '{}'); } catch { continue; }
    const a = by.get(r.actor_id) || { calls: 0, rtt: [], loss: [], jitter: [], reconnects: 0, relay: 0, kbps: [], duration: 0 };
    a.calls++;
    if (d.rtt_ms != null) a.rtt.push(d.rtt_ms);
    if (d.loss_pct != null) a.loss.push(d.loss_pct);
    if (d.jitter_ms != null) a.jitter.push(d.jitter_ms);
    if (d.kbps_in != null) a.kbps.push(d.kbps_in);
    a.reconnects += d.reconnects || 0;
    a.relay += d.relay ? 1 : 0;
    a.duration += d.duration || 0;
    by.set(r.actor_id, a);
  }
  const avg = (x) => (x.length ? Math.round((x.reduce((p, c) => p + c, 0) / x.length) * 10) / 10 : null);
  const users = [...by.entries()].map(([id, a]) => {
    const u = getUser(id);
    const loss = avg(a.loss);
    const rtt = avg(a.rtt);
    const grade = (loss ?? 0) > 5 || (rtt ?? 0) > 400 ? 'bad' : (loss ?? 0) > 2 || (rtt ?? 0) > 200 ? 'fair' : 'good';
    return {
      user: userRef(u), calls: a.calls, rtt_ms: rtt, loss_pct: loss, jitter_ms: avg(a.jitter), kbps_in: avg(a.kbps),
      reconnects: a.reconnects, relay_pct: Math.round((a.relay / a.calls) * 100), minutes: Math.round(a.duration / 60), grade,
    };
  }).sort((x, y) => y.calls - x.calls);
  res.json({ days, users });
});

// ------------------------------------------------------------------ the admin's own login + password
admin.get('/credentials', (req, res) => {
  const u = getUser(req.user.id);
  res.json({ login: u.admin_login || null, has_password: !!u.admin_pass });
});

admin.put('/credentials', (req, res) => {
  const me = getUser(req.user.id);
  const login = str(String(req.body?.login ?? ''), 'login', { min: 4, max: 64 }).toLowerCase();
  const password = str(String(req.body?.password ?? ''), 'password', { min: 10, max: 200 });
  if (!/^[a-z0-9._-]{4,64}$/.test(login)) throw new HttpError(400, 'invalid_login');
  if (me.admin_pass && !verifyPassword(String(req.body?.current_password ?? ''), me.admin_pass)) throw new HttpError(403, 'wrong_password');
  try {
    q.run('UPDATE users SET admin_login = ?, admin_pass = ? WHERE id = ?', login, hashPassword(password), me.id);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'login_taken');
    throw e;
  }
  audit(me.id, 'admin.credentials_set', { ip: req.ip });
  res.json({ ok: true, login });
});

// per-user storage quota (MB; null = server default; 0 = unlimited)
admin.put('/users/:id/quota', (req, res) => {
  const u = getUser(int(req.params.id, 'id'));
  if (!u) throw new HttpError(404, 'not_found');
  const raw = req.body?.mb;
  const bytes = raw === null || raw === undefined || raw === '' ? null : int(raw, 'mb', { min: 0, max: 1_000_000 }) * 1024 * 1024;
  q.run('UPDATE users SET quota_bytes = ? WHERE id = ?', bytes, u.id);
  audit(req.user.id, 'admin.quota_set', { target_type: 'user', target_id: String(u.id), ip: req.ip, details: { mb: raw ?? null } });
  res.json({ ok: true, quota: quotaFor(getUser(u.id)) });
});
