// "My data": what the server holds about me, my security log, and deleting my own account.
import express from 'express';
import { bridgeCleanup } from './bridge.js';
import { q, tx } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { HttpError, now, rateLimit } from './util.js';
import { dropSession, emit } from './realtime.js';
import { audit, getUser, memberIds } from './service.js';
import { removeFile } from './files.js';
import { verifyPassword } from './passwords.js';

export const mydata = express.Router();

mydata.get('/me/data', (req, res) => {
  const id = req.user.id;
  const n = (sql, ...a) => q.get(sql, ...a).n;
  res.json({
    messages: n('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?', id),
    chats: n('SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND banned = 0', id),
    files: n('SELECT COUNT(*) AS n FROM files WHERE owner_id = ?', id),
    files_bytes: n('SELECT COALESCE(SUM(size),0) AS n FROM files WHERE owner_id = ?', id),
    drive: n('SELECT COUNT(*) AS n FROM drive_items WHERE user_id = ?', id),
    links: n('SELECT COUNT(*) AS n FROM drive_shares WHERE user_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)', id, now()),
    sessions: n('SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?', id),
    push_devices: n('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?', id),
    created_at: getUser(id).created_at,
  });
});

const SECURITY = ['auth.login', 'auth.logout', 'auth.password_set', 'auth.password_reset', 'drive.share', 'session.revoke', 'session.revoke_all'];

mydata.get('/me/activity', (req, res) => {
  const u = getUser(req.user.id);
  const rows = q.all(
    `SELECT ts, action, ip, details FROM audit_log WHERE actor_id = ? AND action IN (${SECURITY.map(() => '?').join(',')}) ORDER BY id DESC LIMIT 60`,
    u.id, ...SECURITY,
  );
  // wrong passwords entered for this login (nobody is signed in then, so they have no actor)
  const failed = u.username
    ? q.all("SELECT ts, action, ip, details FROM audit_log WHERE action = 'auth.login_failed' AND details LIKE ? ESCAPE '!' ORDER BY id DESC LIMIT 20", `%"login":"${u.username.replace(/[%_!]/g, (c) => `!${c}`)}"%`)
    : [];
  const all = [...rows, ...failed].sort((a, b) => b.ts - a.ts).slice(0, 60);
  res.json({
    events: all.map((r) => {
      let d = {};
      try { d = JSON.parse(r.details || '{}'); } catch { /* none */ }
      return { ts: r.ts, action: r.action, ip: r.ip || '', device: d.device || '' };
    }),
  });
});

/**
 * Delete my account. Personal chats and the files in them go; my messages in groups and channels stay, shown as a
 * deleted user (as in the admin tool). The password (when set) and the word DELETE are required.
 */
mydata.delete('/me', (req, res) => {
  if (!rateLimit(`erase:${req.user.id}`, 5, 3600_000)) throw new HttpError(429, 'slow_down');
  const u = getUser(req.user.id);
  if (u.is_admin) throw new HttpError(400, 'cannot_ban_admin'); // the administrator account is removed from the admin panel
  if (req.body?.confirm !== 'DELETE') throw new HttpError(400, 'invalid_input');
  if (u.pw_hash && !verifyPassword(String(req.body?.password || ''), u.pw_hash)) throw new HttpError(403, 'wrong_password');
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
    bridgeCleanup(u.id);
    q.run('DELETE FROM users WHERE id = ?', u.id);
  });
  for (const f of fileIds) removeFile(f);
  for (const [id, uids] of watchers) emit(uids, { type: EVENTS.CHAT_REMOVE, chat_id: id });
  audit(null, 'user.self_delete', { target_type: 'user', target_id: String(u.id), details: { name: u.name, username: u.username } });
  res.setHeader('Set-Cookie', 'sid=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
  res.json({ ok: true });
});
