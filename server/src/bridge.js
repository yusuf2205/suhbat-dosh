// Bridge to Telegram accounts. The Telegram sessions live in a separate container (tgbridge); this file is the part inside the server:
// who may link (the administrator decides), which chats are mirrored, and where incoming messages land.
//  * every personal (one-to-one) chat is mirrored by default, quietly: the mirrored chats are muted and never push a notification;
//  * groups and channels only when the owner picks them;
//  * a chat is read-only here unless "answer from here" is on for it;
//  * copies are never deleted automatically;
//  * the administrator can read the mirrored chats like any other chat (the owner is told so before linking);
//  * disconnecting ends the session on Telegram's side and, on request, removes the copies.
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { q, tx } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { HttpError, int, log, now, rateLimit, str } from './util.js';
import { audit, chatOut, getMessage, getUser, memberIds, messageOut } from './service.js';
import { emit } from './realtime.js';

export const bridge = express.Router(); // signed-in routes
export const bridgeIn = express.Router(); // called by the bridge container only (shared secret)
export const bridgeAdmin = express.Router(); // mounted inside the administrator router

const BASE = () => (process.env.TGBRIDGE_URL || 'http://tgbridge:9200').replace(/\/+$/, '');
const TOKEN = () => process.env.BRIDGE_TOKEN || '';
export const bridgeConfigured = () => TOKEN().length >= 24;

let health = { at: 0, ok: false };
export async function bridgeAvailable() {
  if (!bridgeConfigured()) return false;
  if (Date.now() - health.at < 15_000) return health.ok;
  let ok = false;
  try { ok = (await fetch(`${BASE()}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { ok = false; }
  health = { at: Date.now(), ok };
  return ok;
}
export const bridgeReady = () => { bridgeAvailable(); return health.ok; };

async function call(method, path, uid, body) {
  const url = `${BASE()}${path}${path.includes('?') ? '&' : '?'}u=${uid}`;
  let r;
  try {
    r = await fetch(url, {
      method, headers: { Authorization: `Bearer ${TOKEN()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000),
    });
  } catch { throw new HttpError(503, 'bridge_unavailable'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 403 ? 502 : r.status, j.error || 'bridge_error');
  return j;
}

/** The administrator decides who may link an account. Administrators themselves may always. */
const allowedUser = (u) => !!u.is_admin || !!q.get('SELECT 1 AS x FROM tg_allowed WHERE user_id = ?', u.id);
const mayUse = (u) => bridgeConfigured() && allowedUser(u);
const link = (uid) => q.get('SELECT * FROM tg_bridge WHERE user_id = ?', uid);

function guard(req) {
  if (!bridgeConfigured()) throw new HttpError(404, 'bridge_off');
  if (!mayUse(req.user)) throw new HttpError(403, 'forbidden');
}
function mine(req) {
  const o = link(req.user.id);
  if (!o) throw new HttpError(404, 'not_linked');
  return o;
}

const chatsOf = (uid) => q.all('SELECT tg_chat, title, chat_id, two_way, kind FROM tg_chats WHERE user_id = ? ORDER BY kind, title', uid)
  .map((c) => ({ tg_chat: c.tg_chat, title: c.title, chat_id: c.chat_id, two_way: !!c.two_way, kind: c.kind }));

function stateOf(req) {
  const o = link(req.user.id);
  return {
    available: mayUse(req.user),
    linked: !!o,
    account: o ? { name: o.tg_name, username: o.tg_username } : null,
    auto_private: o ? !!o.auto_private : true,
    chats: o ? chatsOf(req.user.id) : [],
  };
}

/** Tell the bridge which chats it may forward and in which of them answering is allowed. */
async function pushRules(uid) {
  const o = link(uid);
  if (!o) return;
  const rows = q.all("SELECT tg_chat, two_way, kind FROM tg_chats WHERE user_id = ? ORDER BY (kind != 'user') DESC, two_way DESC LIMIT 600", uid);
  await call('POST', '/chats', uid, { auto_private: !!o.auto_private, chats: rows.map((r) => ({ id: r.tg_chat, two_way: !!r.two_way })) });
}

bridge.get('/bridge', async (req, res) => {
  let st = stateOf(req);
  st.running = st.available ? await bridgeAvailable() : false;
  // the session was ended from the phone (or the bridge was reset): forget the link here too; the copied chats stay
  if (st.linked && st.running) {
    try {
      const r = await call('GET', '/login/status', req.user.id);
      if (r.linked === false) {
        tx(() => { q.run('DELETE FROM tg_chats WHERE user_id = ?', req.user.id); q.run('DELETE FROM tg_bridge WHERE user_id = ?', req.user.id); });
        audit(req.user.id, 'bridge.ended_remotely');
        st = { ...stateOf(req), running: true };
      } else {
        const b = await call('GET', '/backfill/status', req.user.id).catch(() => null);
        if (b && b.state === 'running') st.backfill = b;
      }
    } catch { /* the bridge is busy: keep what we know */ }
  }
  res.json(st);
});

async function finishLink(req, account) {
  if (link(req.user.id)) return;
  q.run('INSERT INTO tg_bridge (user_id, tg_name, tg_username, created_at) VALUES (?,?,?,?)', req.user.id, String(account.name || '').slice(0, 80), String(account.username || '').slice(0, 40), now());
  audit(req.user.id, 'bridge.linked', { details: { username: account.username || null } });
  try { await pushRules(req.user.id); await call('POST', '/backfill', req.user.id); } catch (e) { log('warn', 'bridge first sync failed', { err: e.code || e.message }); }
}

bridge.post('/bridge/start', async (req, res) => {
  guard(req);
  if (link(req.user.id)) throw new HttpError(409, 'already_linked');
  if (!rateLimit(`brstart:${req.user.id}`, 10, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const r = await call('POST', '/login/start', req.user.id);
  audit(req.user.id, 'bridge.start');
  res.json({ url: r.url, expires_in: r.expires_in });
});

bridge.get('/bridge/poll', async (req, res) => {
  guard(req);
  if (!rateLimit(`brpoll:${req.user.id}`, 120, 60_000)) throw new HttpError(429, 'too_many_requests');
  const r = await call('GET', '/login/status', req.user.id);
  if (r.status === 'done' && r.account) await finishLink(req, r.account);
  res.json({ status: r.status, url: r.url || null, account: r.account || null });
});

/** The cloud password (2-step verification) goes straight to the bridge; it is neither stored nor logged. */
bridge.post('/bridge/password', async (req, res) => {
  guard(req);
  if (!rateLimit(`brpass:${req.user.id}`, 8, 600_000)) throw new HttpError(429, 'too_many_requests');
  const password = str(String(req.body?.password ?? ''), 'password', { min: 1, max: 256 });
  const r = await call('POST', '/login/password', req.user.id, { password });
  if (r.status === 'done' && r.account) await finishLink(req, r.account);
  res.json({ status: r.status, account: r.account || null });
});

bridge.get('/bridge/dialogs', async (req, res) => {
  guard(req); mine(req);
  const r = await call('GET', '/dialogs', req.user.id);
  const have = new Map(chatsOf(req.user.id).map((c) => [c.tg_chat, c]));
  const out = new Set(q.all('SELECT tg_chat FROM tg_excluded WHERE user_id = ?', req.user.id).map((x) => x.tg_chat));
  const auto = !!link(req.user.id).auto_private;
  res.json({
    dialogs: r.dialogs.map((d) => {
      const c = have.get(String(d.id));
      return { ...d, picked: !!c || (d.type === 'user' && auto && !out.has(String(d.id))), two_way: c?.two_way || false };
    }),
    auto_private: auto,
  });
});

/** A muted chat of its own for one Telegram chat. */
function createMirror(uid, meName, tgChat, title, kind, twoWay) {
  const r = q.run(
    "INSERT INTO chats (type, title, description, owner_id, imported_from, import_me, last_message_at, created_at) VALUES ('group', ?, ?, ?, 'tgbridge', ?, ?, ?)",
    `✈ ${title}`, `tgb:${tgChat}`, uid, meName || 'Я', now(), now(),
  );
  const cid = Number(r.lastInsertRowid);
  q.run("INSERT INTO members (chat_id, user_id, role, joined_at, muted) VALUES (?, ?, 'owner', ?, 1)", cid, uid, now());
  q.run('INSERT INTO tg_chats (user_id, tg_chat, title, chat_id, two_way, kind) VALUES (?,?,?,?,?,?)', uid, tgChat, title, cid, twoWay ? 1 : 0, kind);
  return cid;
}

/**
 * { auto_private?, chats: [{ id, title, kind, two_way, remove? }] }: changes to the list. A removed personal chat is remembered as
 * excluded so it is not created again; its copies stay where they are.
 */
bridge.put('/bridge/chats', async (req, res) => {
  guard(req);
  const o = mine(req);
  if (req.body?.auto_private !== undefined) {
    const on = req.body.auto_private ? 1 : 0;
    q.run('UPDATE tg_bridge SET auto_private = ? WHERE user_id = ?', on, req.user.id);
    if (on && !o.auto_private) call('POST', '/backfill', req.user.id).catch(() => {});
  }
  const list = Array.isArray(req.body?.chats) ? req.body.chats.slice(0, 400) : [];
  tx(() => {
    for (const c of list) {
      const id = String(c?.id ?? '');
      if (!/^-?\d{1,20}$/.test(id)) throw new HttpError(400, 'invalid_input');
      const kind = ['user', 'group', 'channel'].includes(c.kind) ? c.kind : 'user';
      const title = String(c.title || id).replace(/[\u0000-\u001f]/g, '').slice(0, 60);
      const have = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', req.user.id, id);
      if (c.remove) {
        q.run('DELETE FROM tg_chats WHERE user_id = ? AND tg_chat = ?', req.user.id, id);
        if (kind === 'user') q.run('INSERT OR IGNORE INTO tg_excluded (user_id, tg_chat) VALUES (?,?)', req.user.id, id);
        continue;
      }
      q.run('DELETE FROM tg_excluded WHERE user_id = ? AND tg_chat = ?', req.user.id, id);
      if (have) { q.run('UPDATE tg_chats SET two_way = ?, title = ? WHERE user_id = ? AND tg_chat = ?', c.two_way ? 1 : 0, title, req.user.id, id); continue; }
      createMirror(req.user.id, o.tg_name, id, title, kind, !!c.two_way);
    }
  });
  await pushRules(req.user.id);
  for (const c of chatsOf(req.user.id)) emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat: chatOut(c.chat_id, req.user.id) });
  audit(req.user.id, 'bridge.chats', { details: { changed: list.length, auto_private: !!link(req.user.id).auto_private } });
  res.json(stateOf(req));
});

/** Disconnect: the session ends on Telegram's side as well. delete_messages also removes the mirrored chats from here. */
async function disconnectUser(uid, deleteCopies, actor) {
  try { await call('POST', '/logout', uid); } catch (e) { if (e.code !== 'bridge_unavailable') throw e; }
  const chats = q.all('SELECT chat_id FROM tg_chats WHERE user_id = ?', uid).map((c) => c.chat_id);
  tx(() => {
    q.run('DELETE FROM tg_chats WHERE user_id = ?', uid);
    q.run('DELETE FROM tg_excluded WHERE user_id = ?', uid);
    q.run('DELETE FROM tg_bridge WHERE user_id = ?', uid);
    if (deleteCopies) for (const id of chats) q.run('DELETE FROM chats WHERE id = ?', id);
  });
  for (const id of chats) emit([uid], deleteCopies ? { type: EVENTS.CHAT_REMOVE, chat_id: id } : { type: EVENTS.CHAT_UPDATE, chat: chatOut(id, uid) });
  audit(actor, 'bridge.disconnect', { target_type: 'user', target_id: uid, details: { deleted: deleteCopies } });
}

bridge.post('/bridge/disconnect', async (req, res) => {
  guard(req); mine(req);
  await disconnectUser(req.user.id, !!req.body?.delete_messages, req.user.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ the administrator decides who may link
bridgeAdmin.get('/', (req, res) => {
  const rows = q.all(
    `SELECT u.id, u.name, u.username, u.is_admin, a.at AS allowed_at, b.user_id AS linked_id, b.tg_name, b.tg_username,
            (SELECT COUNT(*) FROM tg_chats c WHERE c.user_id = u.id) AS chats,
            (SELECT COUNT(*) FROM messages m JOIN tg_chats c ON c.chat_id = m.chat_id WHERE c.user_id = u.id) AS messages
     FROM users u LEFT JOIN tg_allowed a ON a.user_id = u.id LEFT JOIN tg_bridge b ON b.user_id = u.id
     WHERE u.is_bot = 0 AND u.banned_at IS NULL ORDER BY (b.user_id IS NULL), (a.user_id IS NULL), u.name LIMIT 500`,
  );
  res.json({
    configured: bridgeConfigured(),
    users: rows.map((r) => ({
      id: r.id, name: r.name, username: r.username, is_admin: !!r.is_admin, allowed: !!r.is_admin || !!r.allowed_at,
      linked: !!r.linked_id, tg_name: r.tg_name || '', tg_username: r.tg_username || '', chats: r.chats, messages: r.messages,
    })),
  });
});

bridgeAdmin.put('/:uid', async (req, res) => {
  const uid = int(req.params.uid, 'uid');
  const u = getUser(uid);
  if (!u) throw new HttpError(404, 'not_found');
  if (u.is_admin) throw new HttpError(400, 'invalid_input'); // administrators always may
  if (req.body?.allowed) {
    q.run('INSERT INTO tg_allowed (user_id, by_id, at) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING', uid, req.user.id, now());
  } else {
    q.run('DELETE FROM tg_allowed WHERE user_id = ?', uid);
    if (link(uid)) await disconnectUser(uid, false, req.user.id); // no permission, no live session; the copies stay
  }
  audit(req.user.id, 'bridge.permission', { target_type: 'user', target_id: uid, details: { allowed: !!req.body?.allowed } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ from the bridge container
const same = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const syncTimers = new Map();

/** One Telegram message. Dedupes by (chat, key); quiet: nothing is pushed, the chats are muted. */
bridgeIn.post('/bridge/in', (req, res) => {
  const given = String(req.headers.authorization || '');
  if (!bridgeConfigured() || !same(given, `Bearer ${TOKEN()}`)) throw new HttpError(403, 'forbidden');
  const b = req.body || {};
  const uid = Number(b.owner);
  const o = Number.isInteger(uid) ? link(uid) : null;
  if (!o) return res.json({ ok: true, skipped: true });
  if (b.sync_done) {
    for (const c of chatsOf(uid)) emit([uid], { type: EVENTS.CHAT_UPDATE, chat: chatOut(c.chat_id, uid) });
    return res.json({ ok: true });
  }
  const tgChat = String(b.tg_chat ?? '');
  if (!/^-?\d{1,20}$/.test(tgChat)) return res.json({ ok: true, skipped: true });
  const text = String(b.text ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 4000);
  if (!text.trim()) return res.json({ ok: true, skipped: true });
  let row = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, tgChat);
  if (!row) {
    // a personal chat that is not mirrored yet: created now, unless the owner removed it or switched the default off
    if (b.kind !== 'user' || !o.auto_private || q.get('SELECT 1 AS x FROM tg_excluded WHERE user_id = ? AND tg_chat = ?', uid, tgChat)) return res.json({ ok: true, skipped: true });
    const title = String(b.title || b.author || tgChat).replace(/[\u0000-\u001f]/g, '').slice(0, 60);
    createMirror(uid, o.tg_name, tgChat, title, 'user', false);
    row = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, tgChat);
  }
  const key = `tg:${row.tg_chat}:${int(b.tg_msg, 'tg_msg')}`;
  if (q.get('SELECT 1 AS x FROM messages WHERE chat_id = ? AND import_key = ?', row.chat_id, key)) return res.json({ ok: true, duplicate: true });
  const author = b.out ? (o.tg_name || 'Я') : String(b.author || '?').replace(/[\u0000-\u001f]/g, '').slice(0, 64);
  const reply = Number.isInteger(b.reply_to)
    ? q.get('SELECT id FROM messages WHERE chat_id = ? AND import_key = ?', row.chat_id, `tg:${row.tg_chat}:${b.reply_to}`)?.id ?? null : null;
  const ts = Number.isFinite(Number(b.ts)) && Number(b.ts) > 0 ? Math.min(Math.round(Number(b.ts)), now()) : now();
  const r = q.run(
    "INSERT INTO messages (chat_id, sender_id, kind, text, reply_to, import_author, import_key, created_at) VALUES (?,?, 'text', ?,?,?,?,?)",
    row.chat_id, b.out ? uid : null, text, reply, author, key, ts, // others' messages have no account here: they count as unread
  );
  const id = Number(r.lastInsertRowid);
  q.run('UPDATE chats SET last_message_id = MAX(COALESCE(last_message_id, 0), ?), last_message_at = MAX(last_message_at, ?) WHERE id = ?', id, ts, row.chat_id);
  q.run('UPDATE members SET hidden = 0 WHERE chat_id = ?', row.chat_id);
  if (b.out || b.backfill) q.run('UPDATE members SET last_read_id = MAX(last_read_id, ?), last_delivered_id = MAX(last_delivered_id, ?) WHERE chat_id = ? AND user_id = ?', id, id, row.chat_id, uid);
  if (b.backfill) {
    // history: no live event for every message, one refresh of the chat once the batch calms down
    if (!syncTimers.has(row.chat_id)) syncTimers.set(row.chat_id, setTimeout(() => { syncTimers.delete(row.chat_id); try { emit([uid], { type: EVENTS.CHAT_UPDATE, chat: chatOut(row.chat_id, uid) }); } catch { /* chat gone */ } }, 2500).unref());
    return res.json({ ok: true, id });
  }
  emit(memberIds(row.chat_id), { type: EVENTS.MESSAGE_NEW, message: messageOut(getMessage(id)) }); // deliberately no push: the mirrored chats are quiet
  res.json({ ok: true, id });
});

// ------------------------------------------------------------------ answering from here (two-way chats only)
export const bridgeTwoWay = (chatId) => !!q.get('SELECT 1 AS x FROM tg_chats WHERE chat_id = ? AND two_way = 1', chatId);

/** Called for every message written in a mirrored chat. The row gets the Telegram id so the echo is not copied twice. */
export function bridgeOut(chat, messageId, text, replyKey) {
  const row = q.get('SELECT * FROM tg_chats WHERE chat_id = ?', chat.id);
  if (!row) return;
  const me = link(row.user_id);
  q.run('UPDATE messages SET import_author = ? WHERE id = ?', me?.tg_name || 'Я', messageId);
  const reply = replyKey ? Number(String(replyKey).split(':').pop()) : null;
  call('POST', '/send', row.user_id, { chat: row.tg_chat, text, reply_to: Number.isInteger(reply) ? reply : null }).then((r) => {
    q.run('UPDATE messages SET import_key = ? WHERE id = ?', `tg:${row.tg_chat}:${r.tg_msg}`, messageId);
  }).catch((e) => {
    log('warn', 'bridge send failed', { err: e.code || e.message });
    const m = getMessage(messageId);
    if (m) emit(memberIds(chat.id), { type: EVENTS.MESSAGE_UPDATE, message: { ...messageOut(m), bridge_failed: true } });
  });
}

/** An account that is being deleted must not leave a live Telegram session behind. */
export function bridgeCleanup(userId) {
  if (link(userId)) call('POST', '/logout', userId).catch((e) => log('warn', 'bridge cleanup failed', { err: e.code || e.message }));
}
