// Personal cloud drive: keep files from chats in folders, share them by link (optional password, expiry,
// download limit), and limit how long the recipients of a message may open its file.
import express from 'express';
import fs from 'node:fs';
import { q } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import {
  HttpError, int, log, now, rateLimit, rid, str,
} from './util.js';
import { emit } from './realtime.js';
import { getMessage, memberIds, messageOut } from './service.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { filePath } from './files.js';
import { audit } from './service.js';

let host = { canAccessFile: null, sendFile: null };
export function wireDrive(h) { host = h; }

export const drive = express.Router();        // needs a session
export const publicShare = express.Router();  // no session: /api/s/...

const fileOut = (f) => ({ id: f.id, name: f.name, size: f.size, mime: f.mime, url: `/api/files/${f.id}` });
const itemOut = (r) => {
  const f = q.get('SELECT * FROM files WHERE id = ?', r.file_id);
  const shares = q.get('SELECT COUNT(*) AS n FROM drive_shares WHERE user_id = ? AND file_id = ? AND revoked = 0 AND (expires_at IS NULL OR expires_at > ?)', r.user_id, r.file_id, now()).n;
  return { id: r.id, name: r.name, folder: r.folder, created_at: r.created_at, shares, file: f ? fileOut(f) : null };
};
const cleanFolder = (v) => String(v ?? '').trim().replace(/[\\/]+/g, ' ').slice(0, 48);

drive.get('/drive', (req, res) => {
  // files that people put into their own Saved messages chat belong to the drive too
  const own = q.get('SELECT id FROM chats WHERE direct_key = ?', `${req.user.id}:${req.user.id}`);
  if (own) {
    q.run(`INSERT OR IGNORE INTO drive_items (user_id, file_id, folder, name, created_at)
           SELECT ?, f.id, '', f.name, m.created_at FROM messages m JOIN files f ON f.id = m.file_id
           WHERE m.chat_id = ? AND m.file_id IS NOT NULL AND m.kind IN ('file','image','video','audio')`, req.user.id, own.id);
  }
  const rows = q.all('SELECT * FROM drive_items WHERE user_id = ? ORDER BY created_at DESC LIMIT 2000', req.user.id);
  const folders = [...new Set(rows.map((r) => r.folder).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const used = q.get('SELECT COALESCE(SUM(f.size),0) AS n FROM drive_items d JOIN files f ON f.id = d.file_id WHERE d.user_id = ?', req.user.id).n;
  res.json({ items: rows.map(itemOut).filter((i) => i.file), folders, used });
});

drive.post('/drive', (req, res) => {
  if (!rateLimit(`drive:${req.user.id}`, 120, 60_000)) throw new HttpError(429, 'slow_down');
  const fid = str(req.body?.file_id, 'file_id', { min: 8, max: 40 });
  const f = q.get('SELECT * FROM files WHERE id = ?', fid);
  if (!f || !host.canAccessFile(req.user.id, fid)) throw new HttpError(404, 'not_found');
  if (f.mime.startsWith('image/') && !f.chat_id) throw new HttpError(400, 'invalid_input'); // avatars are not documents
  const folder = cleanFolder(req.body?.folder);
  q.run(
    'INSERT INTO drive_items (user_id, file_id, folder, name, created_at) VALUES (?,?,?,?,?) ON CONFLICT(user_id, file_id) DO UPDATE SET folder = excluded.folder',
    req.user.id, fid, folder, f.name, now(),
  );
  res.status(201).json({ item: itemOut(q.get('SELECT * FROM drive_items WHERE user_id = ? AND file_id = ?', req.user.id, fid)) });
});

drive.patch('/drive/:id', (req, res) => {
  const r = q.get('SELECT * FROM drive_items WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!r) throw new HttpError(404, 'not_found');
  if (req.body?.name !== undefined) q.run('UPDATE drive_items SET name = ? WHERE id = ?', str(req.body.name, 'name', { min: 1, max: 120 }), r.id);
  if (req.body?.folder !== undefined) q.run('UPDATE drive_items SET folder = ? WHERE id = ?', cleanFolder(req.body.folder), r.id);
  res.json({ item: itemOut(q.get('SELECT * FROM drive_items WHERE id = ?', r.id)) });
});

// removes only the entry in the drive and its links: the file itself stays where it was sent
drive.delete('/drive/:id', (req, res) => {
  const r = q.get('SELECT * FROM drive_items WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!r) throw new HttpError(404, 'not_found');
  q.run('UPDATE drive_shares SET revoked = 1 WHERE user_id = ? AND file_id = ?', req.user.id, r.file_id);
  q.run('DELETE FROM drive_items WHERE id = ?', r.id);
  res.json({ ok: true });
});

// ---- share links
const shareOut = (s, origin = '') => ({
  token: s.token, url: `${origin}/s/${s.token}`, has_password: !!s.pw_hash, expires_at: s.expires_at, max_downloads: s.max_downloads,
  downloads: s.downloads, revoked: !!s.revoked, created_at: s.created_at,
  active: !s.revoked && (!s.expires_at || s.expires_at > now()) && (!s.max_downloads || s.downloads < s.max_downloads),
});

drive.get('/drive/:id/shares', (req, res) => {
  const r = q.get('SELECT * FROM drive_items WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!r) throw new HttpError(404, 'not_found');
  res.json({ shares: q.all('SELECT * FROM drive_shares WHERE user_id = ? AND file_id = ? ORDER BY created_at DESC LIMIT 50', req.user.id, r.file_id).map((s) => shareOut(s)) });
});

drive.post('/drive/:id/share', (req, res) => {
  if (!rateLimit(`share:${req.user.id}`, 30, 3600_000)) throw new HttpError(429, 'slow_down');
  const r = q.get('SELECT * FROM drive_items WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!r) throw new HttpError(404, 'not_found');
  const pw = typeof req.body?.password === 'string' ? req.body.password : '';
  if (pw && (pw.length < 4 || pw.length > 64)) throw new HttpError(400, 'invalid_input');
  const hours = req.body?.ttl_hours == null ? null : Number(req.body.ttl_hours);
  if (hours != null && (!Number.isFinite(hours) || hours < 0.25 || hours > 24 * 365)) throw new HttpError(400, 'invalid_input');
  const maxDl = req.body?.max_downloads == null ? null : Number(req.body.max_downloads);
  if (maxDl != null && (!Number.isInteger(maxDl) || maxDl < 1 || maxDl > 10000)) throw new HttpError(400, 'invalid_input');
  const token = rid(18);
  q.run(
    'INSERT INTO drive_shares (token, user_id, file_id, pw_hash, expires_at, max_downloads, created_at) VALUES (?,?,?,?,?,?,?)',
    token, req.user.id, r.file_id, pw ? hashPassword(pw) : null, hours ? now() + Math.round(hours * 3600_000) : null, maxDl, now(),
  );
  audit(req.user.id, 'drive.share', { target_type: 'file', target_id: r.file_id, details: { password: !!pw, hours, max_downloads: maxDl } });
  res.status(201).json({ share: shareOut(q.get('SELECT * FROM drive_shares WHERE token = ?', token)) });
});

drive.delete('/drive/shares/:token', (req, res) => {
  const t = str(req.params.token, 'token', { min: 8, max: 64 });
  q.run('UPDATE drive_shares SET revoked = 1 WHERE token = ? AND user_id = ?', t, req.user.id);
  res.json({ ok: true });
});

// ---- limited-time access to the file of a message (recipients only: the sender always keeps access)
drive.patch('/messages/:id/access', (req, res) => {
  const m = getMessage(int(req.params.id, 'id'));
  if (!m || m.sender_id !== req.user.id || !m.file_id) throw new HttpError(404, 'not_found');
  const sec = req.body?.seconds;
  let until = null;
  if (sec === 0) until = now() - 1000;                                // close access right now
  else if (sec != null) {
    const n = Number(sec);
    if (!Number.isFinite(n) || n < 60 || n > 365 * 86400) throw new HttpError(400, 'invalid_input');
    until = now() + Math.round(n * 1000);
  }
  q.run('UPDATE messages SET access_until = ? WHERE id = ?', until, m.id);
  const out = messageOut(getMessage(m.id));
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: out });
  res.json({ message: out });
});

// ================================================================== public side (no session)
const liveShare = (token) => {
  const s = q.get('SELECT * FROM drive_shares WHERE token = ?', String(token || '').slice(0, 64));
  if (!s || s.revoked) return null;
  if (s.expires_at && s.expires_at <= now()) return null;
  if (s.max_downloads && s.downloads >= s.max_downloads) return null;
  return s;
};
const ipOf = (req) => String(req.ip || '');

publicShare.get('/:token/meta', (req, res) => {
  if (!rateLimit(`sm:${ipOf(req)}`, 120, 60_000)) throw new HttpError(429, 'slow_down');
  const s = liveShare(req.params.token);
  const f = s ? q.get('SELECT * FROM files WHERE id = ?', s.file_id) : null;
  if (!s || !f || !fs.existsSync(filePath(f.id))) return res.status(404).json({ error: 'gone' });
  const owner = q.get('SELECT name FROM users WHERE id = ?', s.user_id);
  return res.json({ name: f.name, size: f.size, mime: f.mime, from: owner?.name || '', needs_password: !!s.pw_hash, expires_at: s.expires_at });
});

const keys = new Map(); // one-time download keys: key -> { token, until }
setInterval(() => { for (const [k, v] of keys) if (v.until < Date.now()) keys.delete(k); }, 60_000).unref();

publicShare.post('/:token/unlock', (req, res) => {
  const t = String(req.params.token || '').slice(0, 64);
  if (!rateLimit(`su:${ipOf(req)}:${t}`, 10, 10 * 60_000)) throw new HttpError(429, 'slow_down');
  const s = liveShare(t);
  if (!s) return res.status(404).json({ error: 'gone' });
  if (s.pw_hash && !verifyPassword(String(req.body?.password || ''), s.pw_hash)) return res.status(403).json({ error: 'wrong_password' });
  const key = rid(18);
  keys.set(key, { token: t, until: Date.now() + 5 * 60_000 });
  return res.json({ url: `/api/s/${t}/dl?k=${key}` });
});

publicShare.get('/:token/dl', (req, res) => {
  const k = keys.get(String(req.query.k || ''));
  // a browser may fetch one download in several range requests: the key stays valid, but counts once
  let s = null;
  if (k && k.token === req.params.token) {
    s = k.counted ? q.get('SELECT * FROM drive_shares WHERE token = ? AND revoked = 0', k.token) : liveShare(k.token);
  }
  if (!s) return res.status(404).json({ error: 'gone' });
  const f = q.get('SELECT * FROM files WHERE id = ?', s.file_id);
  if (!f || !fs.existsSync(filePath(f.id))) return res.status(404).json({ error: 'gone' });
  if (!k.counted) {
    k.counted = true;
    q.run('UPDATE drive_shares SET downloads = downloads + 1 WHERE token = ?', s.token);
    log('info', 'share download', { token: s.token.slice(0, 6) });
  }
  return host.sendFile(res, f, { download: true });
});
