// Bridge to the owner's own Telegram account. The Telegram session lives in a separate container (tgbridge); this file is the
// part inside the server: who may link, which chats are mirrored, and where incoming messages land.
// Built for safety: one account for the whole server, only chats the owner picks, read-only unless two-way is switched on per
// chat, disconnecting ends the session on Telegram's side and removes the mirrored data on request.
import express from 'express';
import { timingSafeEqual } from 'node:crypto';
import { q, tx } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { HttpError, int, log, now, rateLimit, str } from './util.js';
import { audit, chatOut, getMessage, memberIds, messageOut } from './service.js';
import { emit } from './realtime.js';
import { getSetting } from './access.js';
import { pushNewMessage } from './push.js';

export const bridge = express.Router(); // signed-in routes
export const bridgeIn = express.Router(); // called by the bridge container only (shared secret)

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

async function call(method, path, body) {
  let r;
  try {
    r = await fetch(`${BASE()}${path}`, {
      method, headers: { Authorization: `Bearer ${TOKEN()}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(25_000),
    });
  } catch { throw new HttpError(503, 'bridge_unavailable'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new HttpError(r.status === 403 ? 502 : r.status, j.error || 'bridge_error');
  return j;
}

/** Who may link a Telegram account: nobody, administrators (default), or everyone. */
const access = () => getSetting('bridge_access', 'admins');
const mayUse = (u) => bridgeConfigured() && (access() === 'all' || (access() === 'admins' && !!u.is_admin));
const owner = () => q.get('SELECT * FROM tg_bridge LIMIT 1');

function guard(req) {
  if (!bridgeConfigured()) throw new HttpError(404, 'bridge_off');
  if (!mayUse(req.user)) throw new HttpError(403, 'forbidden');
}
function mine(req) {
  const o = owner();
  if (!o || o.user_id !== req.user.id) throw new HttpError(404, 'not_linked');
  return o;
}

const chatsOf = (uid) => q.all('SELECT tg_chat, title, chat_id, two_way FROM tg_chats WHERE user_id = ? ORDER BY title', uid)
  .map((c) => ({ tg_chat: c.tg_chat, title: c.title, chat_id: c.chat_id, two_way: !!c.two_way }));

function stateOf(req) {
  const o = owner();
  return {
    available: bridgeConfigured() && mayUse(req.user),
    access: access(),
    busy: !!o && o.user_id !== req.user.id,
    linked: !!o && o.user_id === req.user.id,
    account: o && o.user_id === req.user.id ? { name: o.tg_name, username: o.tg_username } : null,
    keep_days: o?.keep_days || 0,
    chats: o && o.user_id === req.user.id ? chatsOf(req.user.id) : [],
  };
}

bridge.get('/bridge', async (req, res) => {
  let st = stateOf(req);
  st.running = st.available ? await bridgeAvailable() : false;
  // the session was ended from the phone (or the bridge was reset): forget the link here too; the copied chats stay
  if (st.linked && st.running) {
    try {
      const r = await call('GET', '/login/status');
      if (r.linked === false) {
        tx(() => { q.run('DELETE FROM tg_chats WHERE user_id = ?', req.user.id); q.run('DELETE FROM tg_bridge WHERE user_id = ?', req.user.id); });
        audit(req.user.id, 'bridge.ended_remotely');
        st = { ...stateOf(req), running: true };
      }
    } catch { /* the bridge is busy: keep what we know */ }
  }
  res.json(st);
});

bridge.post('/bridge/start', async (req, res) => {
  guard(req);
  if (owner() && owner().user_id !== req.user.id) throw new HttpError(409, 'bridge_busy');
  if (owner()) throw new HttpError(409, 'already_linked');
  if (!rateLimit(`brstart:${req.user.id}`, 10, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const r = await call('POST', '/login/start');
  audit(req.user.id, 'bridge.start');
  res.json({ url: r.url, expires_in: r.expires_in });
});

bridge.get('/bridge/poll', async (req, res) => {
  guard(req);
  if (!rateLimit(`brpoll:${req.user.id}`, 120, 60_000)) throw new HttpError(429, 'too_many_requests');
  const r = await call('GET', '/login/status');
  if (r.status === 'done' && r.account && !owner()) {
    q.run('INSERT INTO tg_bridge (user_id, tg_name, tg_username, created_at) VALUES (?,?,?,?)', req.user.id, String(r.account.name || '').slice(0, 80), String(r.account.username || '').slice(0, 40), now());
    audit(req.user.id, 'bridge.linked', { details: { username: r.account.username || null } });
  }
  res.json({ status: r.status, url: r.url || null, account: r.account || null });
});

/** The cloud password (2-step verification) goes straight to the bridge; it is neither stored nor logged. */
bridge.post('/bridge/password', async (req, res) => {
  guard(req);
  if (!rateLimit(`brpass:${req.user.id}`, 8, 600_000)) throw new HttpError(429, 'too_many_requests');
  const password = str(String(req.body?.password ?? ''), 'password', { min: 1, max: 256 });
  const r = await call('POST', '/login/password', { password });
  if (r.status === 'done' && r.account && !owner()) {
    q.run('INSERT INTO tg_bridge (user_id, tg_name, tg_username, created_at) VALUES (?,?,?,?)', req.user.id, String(r.account.name || '').slice(0, 80), String(r.account.username || '').slice(0, 40), now());
    audit(req.user.id, 'bridge.linked', { details: { username: r.account.username || null } });
  }
  res.json({ status: r.status, account: r.account || null });
});

bridge.get('/bridge/dialogs', async (req, res) => {
  guard(req); mine(req);
  const r = await call('GET', '/dialogs');
  const picked = new Map(chatsOf(req.user.id).map((c) => [c.tg_chat, c]));
  res.json({ dialogs: r.dialogs.map((d) => ({ ...d, picked: picked.has(String(d.id)), two_way: picked.get(String(d.id))?.two_way || false })) });
});

/** { chats: [{ id, title, two_way }] }: exactly these are mirrored. A chat that is dropped keeps what was already copied. */
bridge.put('/bridge/chats', async (req, res) => {
  guard(req); mine(req);
  const list = Array.isArray(req.body?.chats) ? req.body.chats.slice(0, 100) : [];
  const want = new Map();
  for (const c of list) {
    const id = String(c?.id ?? '');
    if (!/^-?\d{1,20}$/.test(id)) throw new HttpError(400, 'invalid_input');
    want.set(id, { title: String(c.title || id).replace(/[\u0000-\u001f]/g, '').slice(0, 60), two_way: !!c.two_way });
  }
  tx(() => {
    for (const [id, c] of want) {
      const have = q.get('SELECT * FROM tg_chats WHERE user_id = ? AND tg_chat = ?', req.user.id, id);
      if (have) { q.run('UPDATE tg_chats SET two_way = ?, title = ? WHERE user_id = ? AND tg_chat = ?', c.two_way ? 1 : 0, c.title, req.user.id, id); continue; }
      const me = owner();
      const r = q.run(
        "INSERT INTO chats (type, title, description, owner_id, imported_from, import_me, last_message_at, created_at) VALUES ('group', ?, ?, ?, 'tgbridge', ?, ?, ?)",
        `✈ ${c.title}`, `tgb:${id}`, req.user.id, me.tg_name || 'Я', now(), now(),
      );
      const cid = Number(r.lastInsertRowid);
      q.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", cid, req.user.id, now());
      q.run('INSERT INTO tg_chats (user_id, tg_chat, title, chat_id, two_way) VALUES (?,?,?,?,?)', req.user.id, id, c.title, cid, c.two_way ? 1 : 0);
    }
    for (const row of q.all('SELECT tg_chat FROM tg_chats WHERE user_id = ?', req.user.id)) {
      if (!want.has(row.tg_chat)) q.run('DELETE FROM tg_chats WHERE user_id = ? AND tg_chat = ?', req.user.id, row.tg_chat);
    }
  });
  await call('POST', '/chats', { chats: [...want].map(([id, c]) => ({ id, two_way: c.two_way })) });
  for (const c of chatsOf(req.user.id)) emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat: chatOut(c.chat_id, req.user.id) });
  audit(req.user.id, 'bridge.chats', { details: { count: want.size, two_way: [...want.values()].filter((c) => c.two_way).length } });
  res.json(stateOf(req));
});

bridge.put('/bridge/settings', (req, res) => {
  guard(req); mine(req);
  const days = int(req.body?.keep_days, 'keep_days', { min: 0, max: 3650 });
  q.run('UPDATE tg_bridge SET keep_days = ? WHERE user_id = ?', days, req.user.id);
  res.json(stateOf(req));
});

/** Disconnect: the session ends on Telegram's side as well. delete_messages also removes the mirrored chats from here. */
bridge.post('/bridge/disconnect', async (req, res) => {
  guard(req); mine(req);
  try { await call('POST', '/logout'); } catch (e) { if (e.code !== 'bridge_unavailable') throw e; }
  const chats = q.all('SELECT chat_id FROM tg_chats WHERE user_id = ?', req.user.id).map((c) => c.chat_id);
  tx(() => {
    q.run('DELETE FROM tg_chats WHERE user_id = ?', req.user.id);
    q.run('DELETE FROM tg_bridge WHERE user_id = ?', req.user.id);
    if (req.body?.delete_messages) for (const id of chats) q.run('DELETE FROM chats WHERE id = ?', id);
  });
  for (const id of chats) emit([req.user.id], req.body?.delete_messages ? { type: EVENTS.CHAT_REMOVE, chat_id: id } : { type: EVENTS.CHAT_UPDATE, chat: chatOut(id, req.user.id) });
  audit(req.user.id, 'bridge.disconnect', { details: { deleted: !!req.body?.delete_messages } });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ from the bridge container
const same = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };

/** One Telegram message. Dedupes by (chat, key), lands unread when it came from somebody else. */
bridgeIn.post('/bridge/in', (req, res) => {
  const given = String(req.headers.authorization || '');
  if (!bridgeConfigured() || !same(given, `Bearer ${TOKEN()}`)) throw new HttpError(403, 'forbidden');
  const b = req.body || {};
  const row = q.get('SELECT * FROM tg_chats WHERE tg_chat = ?', String(b.tg_chat ?? ''));
  if (!row) return res.json({ ok: true, skipped: true });
  const text = String(b.text ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, 4000);
  if (!text.trim()) return res.json({ ok: true, skipped: true });
  const key = `tg:${row.tg_chat}:${int(b.tg_msg, 'tg_msg')}`;
  if (q.get('SELECT 1 AS x FROM messages WHERE chat_id = ? AND import_key = ?', row.chat_id, key)) return res.json({ ok: true, duplicate: true });
  const me = q.get('SELECT tg_name FROM tg_bridge WHERE user_id = ?', row.user_id);
  const author = b.out ? (me?.tg_name || 'Я') : String(b.author || '?').replace(/[\u0000-\u001f]/g, '').slice(0, 64);
  const reply = Number.isInteger(b.reply_to)
    ? q.get('SELECT id FROM messages WHERE chat_id = ? AND import_key = ?', row.chat_id, `tg:${row.tg_chat}:${b.reply_to}`)?.id ?? null : null;
  const ts = Number.isFinite(Number(b.ts)) && Number(b.ts) > 0 ? Math.min(Math.round(Number(b.ts)), now()) : now();
  const r = q.run(
    "INSERT INTO messages (chat_id, sender_id, kind, text, reply_to, import_author, import_key, created_at) VALUES (?,?, 'text', ?,?,?,?,?)",
    row.chat_id, b.out ? row.user_id : null, text, reply, author, key, ts, // others' messages have no account here: they count as unread
  );
  const id = Number(r.lastInsertRowid);
  q.run('UPDATE chats SET last_message_id = ?, last_message_at = ? WHERE id = ?', id, ts, row.chat_id);
  q.run('UPDATE members SET hidden = 0 WHERE chat_id = ?', row.chat_id);
  if (b.out) q.run('UPDATE members SET last_read_id = ?, last_delivered_id = ? WHERE chat_id = ? AND user_id = ?', id, id, row.chat_id, row.user_id);
  const msg = messageOut(getMessage(id));
  emit(memberIds(row.chat_id), { type: EVENTS.MESSAGE_NEW, message: msg });
  if (!b.out) { try { pushNewMessage(q.get('SELECT * FROM chats WHERE id = ?', row.chat_id), getMessage(id)); } catch (e) { log('error', 'bridge push', { err: e.message }); } }
  res.json({ ok: true, id });
});

// ------------------------------------------------------------------ answering from here (two-way chats only)
export const isBridgedChat = (chatId) => !!q.get('SELECT 1 AS x FROM tg_chats WHERE chat_id = ?', chatId);
export const bridgeTwoWay = (chatId) => !!q.get('SELECT 1 AS x FROM tg_chats WHERE chat_id = ? AND two_way = 1', chatId);

/** Called for every message written in a mirrored chat. The row gets the Telegram id so the echo is not copied twice. */
export function bridgeOut(chat, messageId, text, replyKey) {
  const row = q.get('SELECT * FROM tg_chats WHERE chat_id = ?', chat.id);
  if (!row) return;
  const me = q.get('SELECT tg_name FROM tg_bridge WHERE user_id = ?', row.user_id);
  q.run('UPDATE messages SET import_author = ? WHERE id = ?', me?.tg_name || 'Я', messageId);
  const reply = replyKey ? Number(String(replyKey).split(':').pop()) : null;
  call('POST', '/send', { chat: row.tg_chat, text, reply_to: Number.isInteger(reply) ? reply : null }).then((r) => {
    q.run('UPDATE messages SET import_key = ? WHERE id = ?', `tg:${row.tg_chat}:${r.tg_msg}`, messageId);
  }).catch((e) => {
    log('warn', 'bridge send failed', { err: e.code || e.message });
    const m = getMessage(messageId);
    if (m) emit(memberIds(chat.id), { type: EVENTS.MESSAGE_UPDATE, message: { ...messageOut(m), bridge_failed: true } });
  });
}

// ------------------------------------------------------------------ keep only N days
export function startBridgeSweep() {
  const run = () => {
    const o = owner();
    if (!o || !o.keep_days) return;
    const cutoff = now() - o.keep_days * 86400_000;
    for (const c of q.all('SELECT chat_id FROM tg_chats WHERE user_id = ?', o.user_id)) {
      const n = q.run('DELETE FROM messages WHERE chat_id = ? AND created_at < ?', c.chat_id, cutoff);
      if (n.changes) emit([o.user_id], { type: EVENTS.CHAT_UPDATE, chat: chatOut(c.chat_id, o.user_id) });
    }
  };
  setInterval(run, 6 * 3600_000).unref();
  setTimeout(run, 20_000).unref();
}

/** An account that is being deleted must not leave a live Telegram session behind. */
export function bridgeCleanup(userId) {
  const o = owner();
  if (o && o.user_id === userId) call('POST', '/logout').catch((e) => log('warn', 'bridge cleanup failed', { err: e.code || e.message }));
}
