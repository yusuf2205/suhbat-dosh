// Chat extras: several pinned messages, reading marks with times, live location, chat appearance, invite links with limits,
// requests to join, and the public address of a channel.
import express from 'express';
import { q, tx } from './db.js';
import { EVENTS, LIMITS } from '../../shared/contracts.js';
import { HttpError, int, now, rateLimit, rid, str } from './util.js';
import { emit } from './realtime.js';
import { bridgeRead } from './bridge.js';
import {
  audit, chatOut, getMessage, getUser, isAdmin, memberIds, membership, messageOut, publicUser, requireMember,
} from './service.js';

export const extras = express.Router();
let host = { pushChat: null, e2eNeed: null };
export function wireExtras(h) { host = h; }

const pushChat = (id, ids) => host.pushChat?.(id, ids);

// ------------------------------------------------------------------ several pinned messages
/** { message_id } pins it (up to 20), { message_id, unpin: true } removes one, { message_id: null } removes all. */
extras.post('/chats/:id/pin', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type !== 'direct' && !isAdmin(me)) throw new HttpError(403, 'forbidden');
  const mid = req.body?.message_id === null ? null : int(req.body?.message_id, 'message_id');
  if (mid === null) q.run('DELETE FROM pins WHERE chat_id = ?', id);
  else {
    if (!q.get('SELECT 1 AS x FROM messages WHERE id = ? AND chat_id = ?', mid, id)) throw new HttpError(404, 'not_found');
    if (req.body?.unpin === true) q.run('DELETE FROM pins WHERE chat_id = ? AND message_id = ?', id, mid);
    else {
      if (q.get('SELECT COUNT(*) AS n FROM pins WHERE chat_id = ?', id).n >= 20 && !q.get('SELECT 1 AS x FROM pins WHERE chat_id = ? AND message_id = ?', id, mid)) throw new HttpError(400, 'too_many_pins');
      q.run('INSERT INTO pins (chat_id, message_id, pinned_by, pinned_at) VALUES (?,?,?,?) ON CONFLICT(chat_id, message_id) DO UPDATE SET pinned_at = excluded.pinned_at', id, mid, req.user.id, now());
    }
  }
  const last = q.get('SELECT message_id FROM pins WHERE chat_id = ? ORDER BY pinned_at DESC, message_id DESC LIMIT 1', id);
  q.run('UPDATE chats SET pinned_message_id = ? WHERE id = ?', last?.message_id ?? null, id);
  audit(req.user.id, mid === null || req.body?.unpin ? 'chat.unpin' : 'chat.pin', { chat_id: id, target_type: 'message', target_id: mid });
  pushChat(id);
  res.json({ chat: chatOut(id, req.user.id) });
});

// ------------------------------------------------------------------ reading marks with times
extras.post('/chats/:id/read', (req, res) => {
  const id = int(req.params.id, 'id');
  const before = requireMember(id, req.user.id);
  const chat = q.get('SELECT last_message_id FROM chats WHERE id = ?', id);
  const upTo = Math.min(int(req.body?.message_id, 'message_id', { min: 0 }), chat.last_message_id ?? 0);
  q.run(
    `UPDATE members SET last_read_id = MAX(last_read_id, ?), last_delivered_id = MAX(last_delivered_id, ?)
     WHERE chat_id = ? AND user_id = ?`, upTo, upTo, id, req.user.id,
  );
  const m = membership(id, req.user.id);
  if (m.last_read_id > before.last_read_id) {
    q.run('INSERT INTO read_log (chat_id, user_id, upto_id, at) VALUES (?,?,?,?)', id, req.user.id, m.last_read_id, now());
    if (Math.random() < 0.02) q.run('DELETE FROM read_log WHERE at < ?', now() - 90 * 86400_000);
  }
  emit(memberIds(id), { type: EVENTS.READ, chat_id: id, user_id: req.user.id, message_id: m.last_read_id, at: now() });
  if (m.last_read_id > before.last_read_id) bridgeRead(id, m.last_read_id);
  res.json({ ok: true, last_read_id: m.last_read_id });
});

/** Who has read a message and when (the first time their marker passed it). People who switched read times off are only counted. */
extras.get('/messages/:id/readers', (req, res) => {
  const m = getMessage(int(req.params.id, 'id'));
  if (!m) throw new HttpError(404, 'not_found');
  requireMember(m.chat_id, req.user.id);
  const members = q.all(
    `SELECT mb.user_id, u.read_receipts FROM members mb JOIN users u ON u.id = mb.user_id
     WHERE mb.chat_id = ? AND mb.banned = 0 AND mb.user_id != ? AND mb.last_read_id >= ?`, m.chat_id, m.sender_id ?? 0, m.id,
  );
  const total = q.get('SELECT COUNT(*) AS n FROM members WHERE chat_id = ? AND banned = 0 AND user_id != ?', m.chat_id, m.sender_id ?? 0).n;
  const readers = [];
  let hidden = 0;
  for (const r of members.slice(0, 200)) {
    if (!r.read_receipts && r.user_id !== req.user.id) { hidden += 1; continue; }
    const first = q.get('SELECT MIN(at) AS at FROM read_log WHERE chat_id = ? AND user_id = ? AND upto_id >= ?', m.chat_id, r.user_id, m.id);
    readers.push({ user: publicUser(getUser(r.user_id), req.user.id), at: first?.at || null });
  }
  readers.sort((a, b) => (a.at || 0) - (b.at || 0));
  res.json({ readers, hidden, total });
});

// ------------------------------------------------------------------ live location
const lastLive = new Map();
extras.put('/messages/:id/live', (req, res) => {
  const m = getMessage(int(req.params.id, 'id'));
  if (!m || m.kind !== 'location' || m.sender_id !== req.user.id) throw new HttpError(404, 'not_found');
  if (!m.live_until || m.live_until < now()) throw new HttpError(409, 'live_ended');
  const lat = Number(req.body?.lat);
  const lon = Number(req.body?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new HttpError(400, 'invalid_input');
  if (now() - (lastLive.get(m.id) || 0) < 4000) return res.json({ ok: true, skipped: true });
  lastLive.set(m.id, now());
  q.run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', `geo:${lat.toFixed(6)},${lon.toFixed(6)}`, now(), m.id);
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(getMessage(m.id)) });
  return res.json({ ok: true });
});

extras.post('/messages/:id/live/stop', (req, res) => {
  const m = getMessage(int(req.params.id, 'id'));
  if (!m || m.kind !== 'location' || m.sender_id !== req.user.id) throw new HttpError(404, 'not_found');
  q.run('UPDATE messages SET live_until = ? WHERE id = ?', now(), m.id);
  const message = messageOut(getMessage(m.id));
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message });
  res.json({ message });
});

// ------------------------------------------------------------------ appearance of a chat
const HEX = /^#[0-9a-f]{6}$/i;
function cleanTheme(t) {
  if (t === null) return null;
  if (!t || typeof t !== 'object') throw new HttpError(400, 'invalid_input');
  const out = {};
  if (typeof t.preset === 'string' && /^[a-z0-9_-]{1,24}$/.test(t.preset)) out.preset = t.preset;
  for (const k of ['c1', 'c2', 'accent', 'text']) if (t[k] !== undefined) { if (!HEX.test(t[k])) throw new HttpError(400, 'invalid_input'); out[k] = t[k].toLowerCase(); }
  if (t.pattern !== undefined) { const p = Number(t.pattern); if (!Number.isInteger(p) || p < 0 || p > 4) throw new HttpError(400, 'invalid_input'); out.pattern = p; }
  if (!Object.keys(out).length) throw new HttpError(400, 'invalid_input');
  return out;
}

/** { theme, shared }: only for me, or (a one-to-one chat / an admin of a group) for everybody who has no theme of their own. */
extras.post('/chats/:id/theme', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  const theme = cleanTheme(req.body?.theme ?? null);
  const json = theme ? JSON.stringify(theme) : null;
  if (req.body?.shared === true) {
    if (chat.type !== 'direct' && !isAdmin(me)) throw new HttpError(403, 'forbidden');
    q.run('UPDATE chats SET theme = ? WHERE id = ?', json, id);
    q.run('UPDATE members SET theme = NULL WHERE chat_id = ?', id);
    pushChat(id);
  } else {
    q.run('UPDATE members SET theme = ? WHERE chat_id = ? AND user_id = ?', json, id, req.user.id);
    pushChat(id, [req.user.id]);
  }
  res.json({ chat: chatOut(id, req.user.id) });
});

// ------------------------------------------------------------------ invite links with limits and requests to join
const linkOut = (l) => ({ id: l.id, code: l.code, name: l.name, expires_at: l.expires_at, max_uses: l.max_uses, uses: l.uses, approval: !!l.approval, revoked: !!l.revoked, created_at: l.created_at });

function adminOf(req) {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type === 'direct' || !isAdmin(me)) throw new HttpError(403, 'forbidden');
  return chat;
}

extras.get('/chats/:id/links', (req, res) => {
  const chat = adminOf(req);
  res.json({
    main: chat.invite_code, approval: !!chat.join_approval,
    links: q.all('SELECT * FROM invite_links WHERE chat_id = ? ORDER BY id DESC', chat.id).map(linkOut),
    requests: q.get('SELECT COUNT(*) AS n FROM join_requests WHERE chat_id = ?', chat.id).n,
  });
});

extras.post('/chats/:id/links', (req, res) => {
  const chat = adminOf(req);
  if (!rateLimit(`mklink:${req.user.id}`, 40, 3600_000)) throw new HttpError(429, 'slow_down');
  if (q.get('SELECT COUNT(*) AS n FROM invite_links WHERE chat_id = ? AND revoked = 0', chat.id).n >= 30) throw new HttpError(400, 'too_many_items');
  const name = str(String(req.body?.name ?? ''), 'name', { max: 40 });
  const hours = req.body?.expires_hours === undefined || req.body.expires_hours === null ? null : int(req.body.expires_hours, 'expires_hours', { min: 1, max: 24 * 365 });
  const maxUses = req.body?.max_uses === undefined || req.body.max_uses === null ? null : int(req.body.max_uses, 'max_uses', { min: 1, max: 100000 });
  const code = rid(9);
  q.run('INSERT INTO invite_links (chat_id, code, name, expires_at, max_uses, approval, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
    chat.id, code, name, hours ? now() + hours * 3600_000 : null, maxUses, req.body?.approval ? 1 : 0, req.user.id, now());
  audit(req.user.id, 'chat.link_create', { chat_id: chat.id, target_type: 'chat', target_id: chat.id, details: { name, hours, maxUses } });
  res.status(201).json({ link: linkOut(q.get('SELECT * FROM invite_links WHERE code = ?', code)) });
});

extras.delete('/chats/:id/links/:lid', (req, res) => {
  const chat = adminOf(req);
  q.run('UPDATE invite_links SET revoked = 1 WHERE id = ? AND chat_id = ?', int(req.params.lid, 'lid'), chat.id);
  res.json({ ok: true });
});

/** Whether joining through the main link / the directory needs an administrator's approval. */
extras.post('/chats/:id/approval', (req, res) => {
  const chat = adminOf(req);
  q.run('UPDATE chats SET join_approval = ? WHERE id = ?', req.body?.on === true ? 1 : 0, chat.id);
  pushChat(chat.id);
  res.json({ chat: chatOut(chat.id, req.user.id) });
});

/** The chat and the link a code belongs to: the main link of a chat, or one of its extra links (valid ones only). */
function byCode(code) {
  const c = q.get("SELECT * FROM chats WHERE invite_code = ? AND type != 'direct'", code);
  if (c) return { chat: c, link: null };
  const l = q.get('SELECT * FROM invite_links WHERE code = ? AND revoked = 0', code);
  if (!l || (l.expires_at && l.expires_at < now()) || (l.max_uses && l.uses >= l.max_uses)) return null;
  const chat = q.get("SELECT * FROM chats WHERE id = ? AND type != 'direct'", l.chat_id);
  return chat ? { chat, link: l } : null;
}

extras.get('/invite/:code', (req, res) => {
  const f = byCode(str(req.params.code, 'code', { min: 4, max: 40 }));
  if (!f) throw new HttpError(404, 'not_found');
  const c = f.chat;
  const mine = q.get('SELECT banned FROM members WHERE chat_id = ? AND user_id = ?', c.id, req.user.id);
  res.json({
    chat: { id: c.id, type: c.type, title: c.title, description: c.description, members_count: memberIds(c.id).length },
    already_member: !!mine && !mine.banned,
    banned: !!mine?.banned,
    approval: !!(c.join_approval || f.link?.approval),
    requested: !!q.get('SELECT 1 AS x FROM join_requests WHERE chat_id = ? AND user_id = ?', c.id, req.user.id),
  });
});

/** Adds a member; used when somebody joins or when a request is approved. */
function addMember(chat, uid) {
  if (memberIds(chat.id).length >= LIMITS.GROUP_MAX_MEMBERS) throw new HttpError(400, 'too_many_members');
  q.run("INSERT OR IGNORE INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", chat.id, uid, now());
  pushChat(chat.id);
  host.e2eNeed?.(chat.id);
}

/** Joining with an approval: a request is made and the administrators are told. */
export function requestJoin(chat, userId) {
  q.run('INSERT OR IGNORE INTO join_requests (chat_id, user_id, created_at) VALUES (?,?,?)', chat.id, userId, now());
  const admins = q.all("SELECT user_id FROM members WHERE chat_id = ? AND banned = 0 AND role IN ('owner','admin')", chat.id).map((r) => r.user_id);
  emit(admins, { type: 'join.request', chat_id: chat.id, count: q.get('SELECT COUNT(*) AS n FROM join_requests WHERE chat_id = ?', chat.id).n });
}

extras.post('/invite/:code/join', (req, res) => {
  const f = byCode(str(req.params.code, 'code', { min: 4, max: 40 }));
  if (!f) throw new HttpError(404, 'not_found');
  const c = f.chat;
  const mine = q.get('SELECT banned FROM members WHERE chat_id = ? AND user_id = ?', c.id, req.user.id);
  if (mine?.banned) throw new HttpError(403, 'user_banned');
  if (mine) return res.json({ chat: chatOut(c.id, req.user.id) });
  if (!rateLimit(`joinlink:${req.user.id}`, 60, 3600_000)) throw new HttpError(429, 'slow_down');
  if (c.join_approval || f.link?.approval) {
    requestJoin(c, req.user.id);
    audit(req.user.id, 'chat.join_request', { chat_id: c.id, target_type: 'chat', target_id: c.id });
    return res.status(202).json({ pending: true, chat: { id: c.id, title: c.title } });
  }
  tx(() => {
    addMember(c, req.user.id);
    if (f.link) q.run('UPDATE invite_links SET uses = uses + 1 WHERE id = ?', f.link.id);
  });
  audit(req.user.id, 'chat.join_by_link', { chat_id: c.id, target_type: 'chat', target_id: c.id });
  return res.json({ chat: chatOut(c.id, req.user.id) });
});

extras.get('/chats/:id/requests', (req, res) => {
  const chat = adminOf(req);
  const rows = q.all('SELECT user_id, created_at FROM join_requests WHERE chat_id = ? ORDER BY created_at', chat.id);
  res.json({ requests: rows.map((r) => ({ user: publicUser(getUser(r.user_id), req.user.id), at: r.created_at })).filter((r) => r.user) });
});

/** { approve: true | false } */
extras.post('/chats/:id/requests/:uid', (req, res) => {
  const chat = adminOf(req);
  const uid = int(req.params.uid, 'uid');
  if (!q.get('SELECT 1 AS x FROM join_requests WHERE chat_id = ? AND user_id = ?', chat.id, uid)) throw new HttpError(404, 'not_found');
  q.run('DELETE FROM join_requests WHERE chat_id = ? AND user_id = ?', chat.id, uid);
  if (req.body?.approve === true) {
    const banned = q.get('SELECT banned FROM members WHERE chat_id = ? AND user_id = ?', chat.id, uid)?.banned;
    if (!banned) addMember(chat, uid);
    audit(req.user.id, 'chat.join_approve', { chat_id: chat.id, target_type: 'user', target_id: uid });
  } else {
    emit([uid], { type: 'join.declined', chat_id: chat.id, title: chat.title });
    audit(req.user.id, 'chat.join_decline', { chat_id: chat.id, target_type: 'user', target_id: uid });
  }
  res.json({ ok: true, requests: q.get('SELECT COUNT(*) AS n FROM join_requests WHERE chat_id = ?', chat.id).n });
});

// ------------------------------------------------------------------ public address of a channel
extras.post('/chats/:id/slug', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type !== 'channel' || me.role !== 'owner') throw new HttpError(403, 'forbidden');
  if (chat.e2e || chat.imported_from) throw new HttpError(400, 'not_for_encrypted');
  const raw = req.body?.slug;
  if (raw === null || raw === '') q.run('UPDATE chats SET slug = NULL WHERE id = ?', id);
  else {
    const slug = String(raw).trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{4,31}$/.test(slug)) throw new HttpError(400, 'invalid_slug');
    if (q.get('SELECT 1 AS x FROM chats WHERE slug = ? AND id != ?', slug, id)) throw new HttpError(409, 'slug_taken');
    q.run('UPDATE chats SET slug = ?, is_public = 1 WHERE id = ?', slug, id);
  }
  audit(req.user.id, 'chat.slug', { chat_id: id, target_type: 'chat', target_id: id, details: { slug: raw } });
  pushChat(id);
  res.json({ chat: chatOut(id, req.user.id) });
});
