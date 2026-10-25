// Bridge to Telegram accounts. The Telegram sessions live in a separate container (tgbridge); this file is the part inside the server:
// who may link (everybody, unless the administrator forbids it for a person), which chats are mirrored, and where incoming messages land.
//  * every personal (one-to-one) chat is mirrored by default, quietly: the mirrored chats are muted and never push a notification;
//  * groups and channels only when the owner picks them;
//  * a chat is read-only here unless "answer from here" is on for it;
//  * copies are never deleted automatically;
//  * the administrator can read the mirrored chats like any other chat (the owner is told so before linking);
//  * the personal chats are shown to their owner and may be answered from here (written to Telegram); an ordinary person cannot delete them,
//    stop copying them or clear them: only the administrator can change that part;
//  * everything is kept in sync: new messages, edits, what was deleted in Telegram (marked, never removed), what was read, and read marks go back;
//  * disconnecting ends the session on Telegram's side and, on request, removes the copies.
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { q, tx } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { HttpError, int, log, now, rateLimit, rid, str } from './util.js';
import { config } from './config.js';
import { filePath, readHead, receive, removeFile, sniff } from './files.js';
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

/** Everybody may link their own Telegram; the administrator can forbid it for a person. Administrators themselves always may. */
const allowedUser = (u) => !!u.is_admin || !q.get('SELECT 1 AS x FROM tg_denied WHERE user_id = ?', u.id);
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

const isAdminUser = (uid) => !!getUser(uid)?.is_admin;
/** Send the owner the fresh state of one mirrored chat (a hidden personal chat has no member row: nothing to send). */
function refreshChat(uid, chatId) {
  const c = chatOut(chatId, uid);
  if (c) emit([uid], { type: EVENTS.CHAT_UPDATE, chat: c });
}

const chatsOf = (uid) => q.all('SELECT tg_chat, title, chat_id, two_way, kind FROM tg_chats WHERE user_id = ? ORDER BY kind, title', uid)
  .map((c) => ({ tg_chat: c.tg_chat, title: c.title, chat_id: c.chat_id, two_way: !!c.two_way, kind: c.kind }));

function stateOf(req) {
  const o = link(req.user.id);
  const all = o ? chatsOf(req.user.id) : [];
  return {
    available: mayUse(req.user),
    linked: !!o,
    account: o ? { name: o.tg_name, username: o.tg_username } : null,
    auto_private: o ? !!o.auto_private : true,
    personal_locked: !req.user.is_admin, // an ordinary person cannot stop copying the personal chats or remove them
    groups_allowed: true, // groups and channels: everybody picks their own, selectively
    chats: all,
  };
}

/** Tell the bridge which chats it may forward and in which of them answering is allowed. */
async function pushRules(uid) {
  const o = link(uid);
  if (!o) return;
  const rows = q.all("SELECT tg_chat, two_way, kind, tg_photo FROM tg_chats WHERE user_id = ? ORDER BY (kind != 'user') DESC, two_way DESC LIMIT 600", uid);
  await call('POST', '/chats', uid, { auto_private: !!o.auto_private, chats: rows.map((r) => ({ id: r.tg_chat, two_way: !!r.two_way, photo: r.tg_photo || '' })) });
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
  // an ordinary person may switch "answer from here" for a personal chat, but cannot stop copying it or switch the default off
  if (!req.user.is_admin && (req.body?.auto_private !== undefined || (Array.isArray(req.body?.chats) && req.body.chats.some((c) => c?.kind === 'user' && c.remove)))) throw new HttpError(403, 'admin_only');
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
  for (const c of chatsOf(req.user.id)) refreshChat(req.user.id, c.chat_id);
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
  for (const id of chats) { if (deleteCopies) emit([uid], { type: EVENTS.CHAT_REMOVE, chat_id: id }); else refreshChat(uid, id); }
  audit(actor, 'bridge.disconnect', { target_type: 'user', target_id: uid, details: { deleted: deleteCopies } });
}

/** "Copy again now": the bridge goes through all personal chats once more (what is already here is skipped). */
bridge.post('/bridge/sync', async (req, res) => {
  guard(req); mine(req);
  if (!rateLimit(`brsync:${req.user.id}`, 6, 3600_000)) throw new HttpError(429, 'too_many_requests');
  await call('POST', '/backfill', req.user.id);
  res.json({ ok: true });
});

bridge.post('/bridge/disconnect', async (req, res) => {
  guard(req); mine(req);
  await disconnectUser(req.user.id, !!req.body?.delete_messages, req.user.id);
  res.json({ ok: true });
});

// ------------------------------------------------------------------ the administrator decides who may link
bridgeAdmin.get('/', async (req, res) => {
  let live = {};
  if (bridgeConfigured()) { try { live = (await call('GET', '/accounts', 0)).accounts || {}; } catch { /* the bridge is not up */ } }
  const rows = q.all(
    `SELECT u.id, u.name, u.username, u.is_admin, a.at AS denied_at, b.user_id AS linked_id, b.tg_name, b.tg_username, b.auto_private,
            (SELECT COUNT(*) FROM tg_chats c WHERE c.user_id = u.id) AS chats,
            (SELECT COUNT(*) FROM messages m JOIN tg_chats c ON c.chat_id = m.chat_id WHERE c.user_id = u.id) AS messages
     FROM users u LEFT JOIN tg_denied a ON a.user_id = u.id LEFT JOIN tg_bridge b ON b.user_id = u.id
     WHERE u.is_bot = 0 AND u.banned_at IS NULL ORDER BY (b.user_id IS NULL), (a.user_id IS NOT NULL) DESC, u.name LIMIT 500`,
  );
  res.json({
    configured: bridgeConfigured(),
    users: rows.map((r) => ({
      id: r.id, name: r.name, username: r.username, is_admin: !!r.is_admin, allowed: !!r.is_admin || !r.denied_at,
      linked: !!r.linked_id, live: live[String(r.id)] || null, tg_name: r.tg_name || '', tg_username: r.tg_username || '', auto_private: !!r.auto_private, chats: r.chats, messages: r.messages,
    })),
  });
});

bridgeAdmin.put('/:uid', async (req, res) => {
  const uid = int(req.params.uid, 'uid');
  const u = getUser(uid);
  if (!u) throw new HttpError(404, 'not_found');
  if (u.is_admin) throw new HttpError(400, 'invalid_input'); // administrators always may
  if (req.body?.allowed) {
    q.run('DELETE FROM tg_denied WHERE user_id = ?', uid);
  } else {
    q.run('INSERT INTO tg_denied (user_id, by_id, at) VALUES (?,?,?) ON CONFLICT(user_id) DO NOTHING', uid, req.user.id, now());
    if (link(uid)) await disconnectUser(uid, false, req.user.id); // forbidden: no live session; the copies stay
  }
  audit(req.user.id, 'bridge.permission', { target_type: 'user', target_id: uid, details: { allowed: !!req.body?.allowed } });
  res.json({ ok: true });
});

/** Remove what a person linked: the Telegram session ends and the mirrored chats are deleted (the permission itself is not changed). */
bridgeAdmin.delete('/:uid', async (req, res) => {
  const uid = int(req.params.uid, 'uid');
  if (!getUser(uid)) throw new HttpError(404, 'not_found');
  if (!link(uid) && !q.get('SELECT 1 AS x FROM tg_chats WHERE user_id = ?', uid)) throw new HttpError(404, 'not_linked');
  await disconnectUser(uid, true, req.user.id);
  // also the copies that stayed from an earlier link (after "Запретить" the chats are kept, without a link)
  for (const c of q.all("SELECT id FROM chats WHERE imported_from = 'tgbridge' AND owner_id = ?", uid)) { q.run('DELETE FROM chats WHERE id = ?', c.id); emit([uid], { type: EVENTS.CHAT_REMOVE, chat_id: c.id }); }
  res.json({ ok: true });
});

/** The personal part is the administrator's to change: { auto_private } for everybody's account, and { remove: tg_chat } to stop copying one chat. */
bridgeAdmin.put('/:uid/personal', async (req, res) => {
  const uid = int(req.params.uid, 'uid');
  const o = link(uid);
  if (!o) throw new HttpError(404, 'not_linked');
  if (req.body?.auto_private !== undefined) {
    const on = req.body.auto_private ? 1 : 0;
    q.run('UPDATE tg_bridge SET auto_private = ? WHERE user_id = ?', on, uid);
    if (on && !o.auto_private) call('POST', '/backfill', uid).catch(() => {});
  }
  if (req.body?.remove !== undefined) {
    const id = String(req.body.remove);
    if (!/^-?\d{1,20}$/.test(id)) throw new HttpError(400, 'invalid_input');
    q.run('DELETE FROM tg_chats WHERE user_id = ? AND tg_chat = ? AND kind = \'user\'', uid, id);
    q.run('INSERT OR IGNORE INTO tg_excluded (user_id, tg_chat) VALUES (?,?)', uid, id);
  }
  await pushRules(uid);
  audit(req.user.id, 'bridge.personal', { target_type: 'user', target_id: uid, details: { auto_private: req.body?.auto_private ?? null, removed: req.body?.remove ?? null } });
  res.json({ ok: true });
});

/** What is mirrored for one person: every chat with its size, and how many were taken off the list. */
bridgeAdmin.get('/:uid/chats', (req, res) => {
  const uid = int(req.params.uid, 'uid');
  if (!getUser(uid)) throw new HttpError(404, 'not_found');
  const chats = q.all(
    `SELECT c.tg_chat, c.title, c.kind, c.two_way, c.chat_id,
            (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.chat_id) AS messages,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.chat_id = c.chat_id) AS last_at
     FROM tg_chats c WHERE c.user_id = ? ORDER BY last_at DESC LIMIT 600`, uid);
  res.json({
    chats: chats.map((c) => ({ tg_chat: c.tg_chat, chat_id: c.chat_id, title: c.title, kind: c.kind, two_way: !!c.two_way, messages: c.messages, last_at: c.last_at })),
    excluded: q.get('SELECT COUNT(*) AS n FROM tg_excluded WHERE user_id = ?', uid).n,
  });
});

/** One mirrored chat: { two_way } lets the person answer from here (or not), { copy: false } stops copying it (what was copied stays). */
bridgeAdmin.put('/:uid/chats/:tg', async (req, res) => {
  const uid = int(req.params.uid, 'uid');
  const tg = String(req.params.tg);
  const row = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, tg);
  if (!row) throw new HttpError(404, 'not_found');
  if (req.body?.copy === false) {
    q.run('DELETE FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, tg);
    if (row.kind === 'user') q.run('INSERT OR IGNORE INTO tg_excluded (user_id, tg_chat) VALUES (?,?)', uid, tg);
  } else if (req.body?.two_way !== undefined) {
    q.run('UPDATE tg_chats SET two_way = ? WHERE user_id = ? AND tg_chat = ?', req.body.two_way ? 1 : 0, uid, tg);
    emit([uid], { type: EVENTS.CHAT_UPDATE, chat: chatOut(row.chat_id, uid) });
  }
  await pushRules(uid);
  audit(req.user.id, 'bridge.chat', { target_type: 'user', target_id: uid, chat_id: row.chat_id, details: { copy: req.body?.copy ?? null, two_way: req.body?.two_way ?? null } });
  res.json({ ok: true });
});

/** Put the personal chats that were taken off the list back (they are copied again from now on). */
bridgeAdmin.post('/:uid/restore', async (req, res) => {
  const uid = int(req.params.uid, 'uid');
  const o = link(uid);
  if (!o) throw new HttpError(404, 'not_linked');
  q.run('DELETE FROM tg_excluded WHERE user_id = ?', uid);
  await pushRules(uid);
  call('POST', '/backfill', uid).catch(() => {});
  audit(req.user.id, 'bridge.restore', { target_type: 'user', target_id: uid });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ from the bridge container
const same = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const syncTimers = new Map();

const tgNum = (key) => Number(String(key || '').split(':').pop());

/** The message was edited in Telegram. */
function applyEdit(uid, b) {
  const row = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, String(b.tg_chat ?? ''));
  if (!row) return { ok: true, skipped: true };
  const m = q.get('SELECT * FROM messages WHERE chat_id = ? AND import_key = ?', row.chat_id, `tg:${row.tg_chat}:${Number(b.tg_msg)}`);
  const text = String(b.text ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 4000);
  if (!m || !text.trim() || m.text === text) return { ok: true, skipped: true };
  q.run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', text, Math.min(Number(b.ts) || now(), now()), m.id);
  emit(memberIds(row.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(getMessage(m.id)) });
  return { ok: true, id: m.id };
}

/** Messages deleted in Telegram: kept here (nothing is ever removed by itself) but marked. For personal chats Telegram does not say which chat. */
function applyDeleted(uid, b) {
  const ids = (Array.isArray(b.ids) ? b.ids : []).map(Number).filter((n) => Number.isInteger(n) && n > 0).slice(0, 500);
  let n = 0;
  for (const id of ids) {
    const rows = b.tg_chat
      ? q.all('SELECT m.* FROM messages m JOIN tg_chats c ON c.chat_id = m.chat_id WHERE c.user_id = ? AND m.import_key = ?', uid, `tg:${b.tg_chat}:${id}`)
      : q.all("SELECT m.* FROM messages m JOIN tg_chats c ON c.chat_id = m.chat_id WHERE c.user_id = ? AND c.kind != 'channel' AND m.import_key LIKE ?", uid, `tg:%:${id}`);
    for (const m of rows) {
      if (m.tg_deleted) continue;
      q.run('UPDATE messages SET tg_deleted = 1 WHERE id = ?', m.id);
      emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(getMessage(m.id)) });
      n += 1;
    }
  }
  return { ok: true, marked: n };
}

/** The owner read the chat in Telegram: it is read here too. */
function applyRead(uid, b) {
  const row = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, String(b.tg_chat ?? ''));
  const max = Number(b.max_id);
  if (!row || !Number.isInteger(max)) return { ok: true, skipped: true };
  const prefix = `tg:${row.tg_chat}:`;
  const last = q.get('SELECT MAX(id) AS id FROM messages WHERE chat_id = ? AND import_key LIKE ? AND CAST(substr(import_key, ?) AS INTEGER) <= ?', row.chat_id, `${prefix}%`, prefix.length + 1, max)?.id;
  if (!last) return { ok: true, skipped: true };
  const before = q.get('SELECT last_read_id AS r FROM members WHERE chat_id = ? AND user_id = ?', row.chat_id, uid)?.r ?? 0;
  if (last <= before) return { ok: true };
  q.run('UPDATE members SET last_read_id = MAX(last_read_id, ?), last_delivered_id = MAX(last_delivered_id, ?) WHERE chat_id = ? AND user_id = ?', last, last, row.chat_id, uid);
  emit([uid], { type: EVENTS.READ, chat_id: row.chat_id, user_id: uid, message_id: last, at: now() });
  refreshChat(uid, row.chat_id);
  return { ok: true };
}

/** The other side's name, @username and phone as Telegram shows them: the mirrored chat follows (the photo comes separately). */
function applyProfile(uid, b) {
  const row = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, String(b.tg_chat ?? ''));
  if (!row) return { ok: true, skipped: true };
  const clean = (v, n) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
  const username = clean(b.username, 40).replace(/^@/, '');
  const phone = clean(b.phone, 20).replace(/[^\d]/g, '');
  const title = clean(b.title, 60);
  q.run('UPDATE tg_chats SET tg_username = ?, tg_phone = ? WHERE user_id = ? AND tg_chat = ?', username, phone, uid, row.tg_chat);
  let changed = row.tg_username !== username || row.tg_phone !== phone;
  if (title && title !== row.title) {
    q.run('UPDATE tg_chats SET title = ? WHERE user_id = ? AND tg_chat = ?', title, uid, row.tg_chat);
    q.run('UPDATE chats SET title = ? WHERE id = ?', `✈ ${title}`, row.chat_id);
    changed = true;
  }
  // no photo in Telegram any more: the picture goes too
  if (!b.photo_id && row.tg_photo) {
    const old = q.get('SELECT avatar_file FROM chats WHERE id = ?', row.chat_id)?.avatar_file;
    q.run("UPDATE chats SET avatar_file = NULL WHERE id = ?", row.chat_id);
    q.run("UPDATE tg_chats SET tg_photo = '' WHERE user_id = ? AND tg_chat = ?", uid, row.tg_chat);
    if (old) { q.run('DELETE FROM files WHERE id = ?', old); removeFile(old); }
    changed = true;
  }
  if (changed) refreshChat(uid, row.chat_id);
  return { ok: true, changed };
}

/** One Telegram message (text, or a file with its caption). Dedupes by (chat, key); quiet: nothing is pushed, the chats are muted. */
function deliver(b, file = null) {
  const uid = Number(b.owner);
  const o = Number.isInteger(uid) ? link(uid) : null;
  if (!o) return { ok: true, skipped: true };
  if (b.sync_done) {
    for (const c of chatsOf(uid)) refreshChat(uid, c.chat_id);
    return { ok: true };
  }
  if (b.edit) return applyEdit(uid, b);
  if (b.deleted) return applyDeleted(uid, b);
  if (b.read) return applyRead(uid, b);
  if (b.profile) return applyProfile(uid, b);
  const tgChat = String(b.tg_chat ?? '');
  if (!/^-?\d{1,20}$/.test(tgChat)) return { ok: true, skipped: true };
  const text = String(b.text ?? b.caption ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 4000);
  if (!text.trim() && !file) return { ok: true, skipped: true };
  let row = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, tgChat);
  if (!row) {
    // a personal chat that is not mirrored yet: created now, unless the owner removed it or switched the default off
    if (b.kind !== 'user' || !o.auto_private || q.get('SELECT 1 AS x FROM tg_excluded WHERE user_id = ? AND tg_chat = ?', uid, tgChat)) return { ok: true, skipped: true };
    const title = String(b.title || b.author || tgChat).replace(/[\u0000-\u001f]/g, '').slice(0, 60);
    createMirror(uid, o.tg_name, tgChat, title, 'user', true);
    pushRules(uid).catch(() => { /* the bridge applies the default for a new personal chat anyway */ });
    row = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, tgChat);
  }
  const key = `tg:${row.tg_chat}:${int(b.tg_msg, 'tg_msg')}`;
  if (q.get('SELECT 1 AS x FROM messages WHERE chat_id = ? AND import_key = ?', row.chat_id, key)) return { ok: true, duplicate: true };
  const author = b.out ? (o.tg_name || 'Я') : String(b.author || '?').replace(/[\u0000-\u001f]/g, '').slice(0, 64);
  const reply = Number.isInteger(b.reply_to)
    ? q.get('SELECT id FROM messages WHERE chat_id = ? AND import_key = ?', row.chat_id, `tg:${row.tg_chat}:${b.reply_to}`)?.id ?? null : null;
  const ts = Number.isFinite(Number(b.ts)) && Number(b.ts) > 0 ? Math.min(Math.round(Number(b.ts)), now()) : now();
  const r = q.run(
    'INSERT INTO messages (chat_id, sender_id, kind, text, reply_to, file_id, duration, import_author, import_key, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    row.chat_id, b.out ? uid : null, file ? file.kind : 'text', text, reply, file ? file.id : null, file?.duration ?? null, author, key, ts, // others' messages have no account here: they count as unread
  );
  const id = Number(r.lastInsertRowid);
  q.run('UPDATE chats SET last_message_id = MAX(COALESCE(last_message_id, 0), ?), last_message_at = MAX(last_message_at, ?) WHERE id = ?', id, ts, row.chat_id);
  q.run('UPDATE members SET hidden = 0 WHERE chat_id = ?', row.chat_id);
  if (b.out || b.backfill) q.run('UPDATE members SET last_read_id = MAX(last_read_id, ?), last_delivered_id = MAX(last_delivered_id, ?) WHERE chat_id = ? AND user_id = ?', id, id, row.chat_id, uid);
  if (b.backfill) {
    // history: no live event for every message, one refresh of the chat once the batch calms down
    if (!syncTimers.has(row.chat_id)) syncTimers.set(row.chat_id, setTimeout(() => { syncTimers.delete(row.chat_id); try { refreshChat(uid, row.chat_id); } catch { /* chat gone */ } }, 2500).unref());
    return { ok: true, id };
  }
  emit(memberIds(row.chat_id), { type: EVENTS.MESSAGE_NEW, message: messageOut(getMessage(id)) }); // deliberately no push: the mirrored chats are quiet
  return { ok: true, id };
}

const secret = (req) => { if (!bridgeConfigured() || !same(String(req.headers.authorization || ''), `Bearer ${TOKEN()}`)) throw new HttpError(403, 'forbidden'); };

bridgeIn.post('/bridge/in', (req, res) => {
  secret(req);
  res.json(deliver(req.body || {}));
});

// pictures and voice messages (and videos, when switched on in the bridge) arrive as the raw file with the details in the query
const MEDIA_KINDS = { image: ['jpeg', 'png', 'webp', 'gif'], voice: ['ogg', 'webm', 'mp4', 'mpeg', 'wav'], video: ['mp4', 'webm'] };
bridgeIn.post('/bridge/media', async (req, res) => {
  secret(req);
  const qy = req.query;
  const want = String(qy.kind || '');
  if (!MEDIA_KINDS[want]) { req.resume(); throw new HttpError(400, 'invalid_input'); }
  const uid = Number(qy.owner);
  const row = Number.isInteger(uid) && q.get('SELECT 1 AS x FROM tg_bridge WHERE user_id = ?', uid);
  if (!row) { req.resume(); return res.json({ ok: true, skipped: true }); }
  const fid = rid(16);
  const dest = filePath(fid);
  const limit = want === 'video' ? config.maxUploadBytes : Math.min(config.maxUploadBytes, 25 * 1024 * 1024);
  let size;
  try { size = await receive(req, dest, limit); } catch (e) { removeFile(fid); throw e; }
  if (size === 0) { removeFile(fid); throw new HttpError(400, 'empty_file'); }
  const type = sniff(readHead(dest), want === 'voice');
  const okKind = type && ((want === 'image' && type.kind === 'image') || (want === 'voice' && type.kind === 'voice') || (want === 'video' && type.kind === 'video'));
  if (!okKind) { removeFile(fid); throw new HttpError(415, 'unsupported_media'); }
  const tgChat = String(qy.tg_chat ?? '');
  const name = want === 'image' ? `photo.${type.mime.split('/')[1]}` : want === 'voice' ? 'voice.ogg' : 'video.mp4';
  const dur = Number(qy.duration);
  const dim = (v) => (Number(v) > 0 && Number(v) < 20000 ? Math.round(Number(v)) : null);
  // the file row comes first (the message points at it); it is attached to its chat once the message knows which chat it landed in
  q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at, width, height) VALUES (?,?,?,?,?,?,?,?,?)', fid, uid, null, name, type.mime, size, now(), dim(qy.w), dim(qy.h));
  let out;
  try {
    out = deliver({
    owner: uid, tg_chat: tgChat, kind: qy.chat_kind, title: qy.title, tg_msg: Number(qy.tg_msg), author: qy.author, out: qy.out === '1',
    caption: qy.caption, ts: Number(qy.ts), reply_to: qy.reply_to ? Number(qy.reply_to) : null, backfill: qy.backfill === '1',
  }, { id: fid, kind: type.kind, duration: Number.isFinite(dur) && dur >= 0 && dur < 86400 ? Math.round(dur) : null });
  } catch (e) { q.run('DELETE FROM files WHERE id = ?', fid); removeFile(fid); throw e; }
  if (!out.id) { q.run('DELETE FROM files WHERE id = ?', fid); removeFile(fid); return res.json(out); } // skipped or already there: the file is not kept
  q.run('UPDATE files SET chat_id = (SELECT chat_id FROM messages WHERE id = ?) WHERE id = ?', out.id, fid);
  res.json({ ok: true, id: out.id });
});

// the profile photo of the other side of a mirrored chat (raw image, details in the query)
bridgeIn.post('/bridge/photo', async (req, res) => {
  secret(req);
  const uid = Number(req.query.owner);
  const row = Number.isInteger(uid) && q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', uid, String(req.query.tg_chat ?? ''));
  const photoId = String(req.query.photo_id ?? '').replace(/[^\w-]/g, '').slice(0, 40);
  if (!row || !photoId) { req.resume(); return res.json({ ok: true, skipped: true }); }
  const fid = rid(16);
  const dest = filePath(fid);
  let size;
  try { size = await receive(req, dest, 2 * 1024 * 1024); } catch (e) { removeFile(fid); throw e; }
  const type = size > 0 ? sniff(readHead(dest), false) : null;
  if (!type || type.kind !== 'image') { removeFile(fid); throw new HttpError(415, 'unsupported_media'); }
  const old = q.get('SELECT avatar_file FROM chats WHERE id = ?', row.chat_id)?.avatar_file;
  q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', fid, uid, row.chat_id, `avatar.${type.mime.split('/')[1]}`, type.mime, size, now());
  q.run('UPDATE chats SET avatar_file = ? WHERE id = ?', fid, row.chat_id);
  q.run('UPDATE tg_chats SET tg_photo = ? WHERE user_id = ? AND tg_chat = ?', photoId, uid, row.tg_chat);
  if (old) { q.run('DELETE FROM files WHERE id = ?', old); removeFile(old); }
  refreshChat(uid, row.chat_id);
  res.json({ ok: true });
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

// ------------------------------------------------------------------ keeping both sides equal
/** Read here → read in Telegram too (only in chats that may be answered from here: reading there is visible to the other person). */
export function bridgeRead(chatId, upToLocalId) {
  const row = q.get('SELECT * FROM tg_chats WHERE chat_id = ? AND two_way = 1', chatId);
  if (!row) return;
  const m = q.get("SELECT import_key FROM messages WHERE chat_id = ? AND id <= ? AND import_key LIKE 'tg:%' ORDER BY id DESC LIMIT 1", chatId, upToLocalId);
  const tgId = m ? tgNum(m.import_key) : 0;
  if (!tgId) return;
  call('POST', '/read', row.user_id, { chat: row.tg_chat, max_id: tgId }).catch(() => { /* the next read tries again */ });
}

/** In a mirrored chat an ordinary person cannot delete, clear, leave or edit: the copy is an archive kept in step with Telegram. */
export const bridgeLocked = (chatId, user) => !user.is_admin && !!q.get('SELECT 1 AS x FROM tg_chats WHERE chat_id = ?', chatId);

/** After a restart (and every half hour) tell the bridge the rules again, so both sides never drift apart. */
export function startBridge() {
  const run = async () => {
    if (!bridgeConfigured()) return;
    for (const o of q.all('SELECT user_id FROM tg_bridge')) { try { await pushRules(o.user_id); } catch { /* the bridge is not up yet */ } }
  };
  setTimeout(run, 20_000).unref();
  setInterval(run, 30 * 60_000).unref();
}
