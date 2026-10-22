// Directory: public channels and groups (their owner chose to show them) and bots, searchable by everybody.
import express from 'express';
import { q } from './db.js';
import { HttpError, int, now, rateLimit } from './util.js';
import { LIMITS } from '../../shared/contracts.js';
import { audit, chatOut, memberIds, requireMember } from './service.js';

export const directory = express.Router();
let host = { pushChat: null };
export function wireDirectory(h) { host = h; }

/** The owner shows or hides a channel or group in the directory. */
directory.post('/chats/:id/public', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (c.type === 'direct' || me.role !== 'owner') throw new HttpError(403, 'forbidden');
  if (c.e2e || c.imported_from) throw new HttpError(400, 'not_for_encrypted');
  const on = req.body?.public === true;
  if (on && !c.title.trim()) throw new HttpError(400, 'invalid_input');
  q.run('UPDATE chats SET is_public = ? WHERE id = ?', on ? 1 : 0, id);
  audit(req.user.id, 'chat.public', { chat_id: id, target_type: 'chat', target_id: id, details: { public: on } });
  host.pushChat?.(id);
  res.json({ chat: chatOut(id, req.user.id) });
});

directory.get('/directory', (req, res) => {
  if (!rateLimit(`dir:${req.user.id}`, 120, 60_000)) throw new HttpError(429, 'slow_down');
  const kind = ['channel', 'group', 'bot'].includes(req.query.kind) ? req.query.kind : 'channel';
  const term = String(req.query.q ?? '').trim().slice(0, 60);
  // SQLite's LIKE ignores case only for Latin letters, so the text is compared here
  const norm = (v) => String(v || '').toLowerCase().replace(/ё/g, 'е');
  const needle = norm(term);
  const hit = (...fields) => !needle || fields.some((f) => norm(f).includes(needle));
  if (kind === 'bot') {
    const rows = q.all("SELECT id, name, username, bio, bot_commands FROM users WHERE is_bot = 1 AND phone NOT LIKE 'system:%' AND banned_at IS NULL ORDER BY name LIMIT 500")
      .filter((u) => hit(u.name, u.username, u.bio)).slice(0, 60);
    return res.json({ items: rows.map((u) => ({ id: u.id, name: u.name, username: u.username, description: u.bio, commands: JSON.parse(u.bot_commands || '[]').slice(0, 6) })) });
  }
  const rows = q.all(
    `SELECT c.id, c.type, c.title, c.description, (SELECT COUNT(*) FROM members m WHERE m.chat_id = c.id AND m.banned = 0) AS members,
       EXISTS (SELECT 1 FROM members m WHERE m.chat_id = c.id AND m.user_id = ? AND m.banned = 0) AS joined
     FROM chats c WHERE c.is_public = 1 AND c.type = ? AND c.e2e = 0 ORDER BY members DESC, c.id DESC LIMIT 500`, req.user.id, kind)
    .filter((r) => hit(r.title, r.description)).slice(0, 60);
  return res.json({ items: rows.map((r) => ({ id: r.id, type: r.type, title: r.title, description: r.description, members: r.members, joined: !!r.joined })) });
});

directory.post('/directory/:id/join', (req, res) => {
  if (!rateLimit(`dirjoin:${req.user.id}`, 30, 3600_000)) throw new HttpError(429, 'slow_down');
  const c = q.get("SELECT * FROM chats WHERE id = ? AND is_public = 1 AND type != 'direct' AND e2e = 0", int(req.params.id, 'id'));
  if (!c) throw new HttpError(404, 'not_found');
  const mine = q.get('SELECT banned FROM members WHERE chat_id = ? AND user_id = ?', c.id, req.user.id);
  if (mine?.banned) throw new HttpError(403, 'user_banned');
  if (!mine) {
    if (memberIds(c.id).length >= LIMITS.GROUP_MAX_MEMBERS) throw new HttpError(400, 'too_many_members');
    q.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", c.id, req.user.id, now());
    audit(req.user.id, 'chat.join_directory', { chat_id: c.id, target_type: 'chat', target_id: c.id });
    host.pushChat?.(c.id);
  }
  res.json({ chat: chatOut(c.id, req.user.id) });
});
