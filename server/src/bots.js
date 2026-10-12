// Bots: Telegram-style Bot API (/bot<token>/<method>) + owner-side management (/api/bots).
// A bot is a users row (is_bot = 1) that is authenticated by a token instead of a session.
import express from 'express';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import { config } from './config.js';
import { q, tx } from './db.js';
import { EVENTS, LIMITS } from '../../shared/contracts.js';
import {
  HttpError, int, log, now, rateLimit, rid, sha256, str,
} from './util.js';
import { emit } from './realtime.js';
import {
  audit, directPeerId, getMessage, getUser, isBlockedEitherWay, memberIds, membership, messageOut, publicUser, refreshLastMessage,
} from './service.js';
import {
  checkName, filePath, readHead, receive, removeFile, sniff,
} from './files.js';

// api.js imports this module and this module needs two things from api.js: injected at start-up to avoid a cycle.
let host = { postMessage: null, pushChat: null };
export function wireBots(h) { host = h; }
export const getHost = () => host;

const MAX_BOTS_PER_USER = 10;
const BOT_USERNAME = /^[A-Za-z][A-Za-z0-9_]{1,28}bot$/i;
const TOKEN_RE = /^(\d+):([A-Za-z0-9_-]{20,64})$/;
const COMMAND_RE = /^[a-z0-9_]{1,32}$/;

// ---------------------------------------------------------------- helpers
const tgUser = (u) => (u ? { id: u.id, is_bot: !!u.is_bot, first_name: u.name, username: u.username || undefined } : undefined);

function tgChat(chatId, botId) {
  const c = q.get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!c) return { id: chatId, type: 'private' };
  if (c.type === 'direct') {
    const u = getUser(directPeerId(chatId, botId));
    return { id: chatId, type: 'private', first_name: u?.name, username: u?.username || undefined };
  }
  return { id: chatId, type: c.type === 'group' ? 'group' : 'channel', title: c.title };
}

export function tgMessage(row, botId, nested = false) {
  const m = {
    message_id: row.id,
    from: tgUser(getUser(row.sender_id)),
    chat: tgChat(row.chat_id, botId),
    date: Math.floor(row.created_at / 1000),
  };
  if (row.edited_at) m.edit_date = Math.floor(row.edited_at / 1000);
  if (row.reply_to && !nested) {
    const r = getMessage(row.reply_to);
    if (r) m.reply_to_message = tgMessage(r, botId, true);
  }
  const f = row.file_id ? q.get('SELECT * FROM files WHERE id = ?', row.file_id) : null;
  const key = f ? 'caption' : 'text';
  if (row.text) {
    m[key] = row.text;
    const cmd = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)?/.exec(row.text);
    if (cmd) m[f ? 'caption_entities' : 'entities'] = [{ type: 'bot_command', offset: 0, length: cmd[0].length }];
  }
  if (f) {
    const base = { file_id: f.id, file_unique_id: f.id, file_size: f.size };
    if (row.kind === 'image') m.photo = [{ ...base, width: f.width || 0, height: f.height || 0 }];
    else if (row.kind === 'voice') m.voice = { ...base, duration: row.duration || 0, mime_type: f.mime };
    else if (row.kind === 'audio') m.audio = { ...base, duration: row.duration || 0, mime_type: f.mime, file_name: f.name };
    else if (row.kind === 'video') m.video = { ...base, width: f.width || 0, height: f.height || 0, duration: row.duration || 0, mime_type: f.mime, file_name: f.name };
    else m.document = { ...base, file_name: f.name, mime_type: f.mime };
  }
  if (row.markup) { try { m.reply_markup = JSON.parse(row.markup); } catch { /* ignore */ } }
  return m;
}

/** Validate / sanitize an inline keyboard. Returns the JSON string to store, or null. */
export function cleanMarkup(v) {
  if (v === undefined || v === null || v === '') return null;
  let o = v;
  if (typeof v === 'string') { try { o = JSON.parse(v); } catch { throw new HttpError(400, 'bad_markup'); } }
  const rows = o?.inline_keyboard;
  if (!Array.isArray(rows)) return null;
  const out = [];
  for (const row of rows.slice(0, 8)) {
    if (!Array.isArray(row)) continue;
    const r = [];
    for (const b of row.slice(0, 8)) {
      const text = typeof b?.text === 'string' ? b.text.trim().slice(0, 64) : '';
      if (!text) continue;
      if (typeof b.callback_data === 'string' && b.callback_data.length && Buffer.byteLength(b.callback_data) <= 64) r.push({ text, callback_data: b.callback_data });
      else if (typeof b.url === 'string' && /^(https?:\/\/|tg:\/\/)/i.test(b.url) && b.url.length <= 512) r.push({ text, url: b.url });
    }
    if (r.length) out.push(r);
  }
  return out.length ? JSON.stringify({ inline_keyboard: out }) : null;
}

function cleanCommands(v) {
  let a = v;
  if (typeof v === 'string') { try { a = JSON.parse(v); } catch { throw new HttpError(400, 'bad_commands'); } }
  if (!Array.isArray(a) || a.length > 50) throw new HttpError(400, 'bad_commands');
  return a.map((c) => {
    const command = String(c?.command ?? '').replace(/^\//, '').toLowerCase();
    const description = String(c?.description ?? '').trim().slice(0, 256);
    if (!COMMAND_RE.test(command) || !description) throw new HttpError(400, 'bad_commands');
    return { command, description };
  });
}

// ---------------------------------------------------------------- outgoing network, guarded against SSRF
function isPrivateIp(ip) {
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
    return m ? isPrivateIp(m[1]) : false;
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

const allowPrivate = () => /^(1|true|yes|on)$/i.test(process.env.BOT_WEBHOOK_ALLOW_PRIVATE || '');

function request(urlStr, { method = 'GET', headers = {}, body = null, timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { return reject(new HttpError(400, 'bad_url')); }
    if (!/^https?:$/.test(u.protocol)) return reject(new HttpError(400, 'bad_url'));
    const priv = allowPrivate();
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (!priv && net.isIP(host) && isPrivateIp(host)) return reject(new HttpError(400, 'private_address'));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request(u, {
      method,
      headers,
      timeout: timeoutMs,
      lookup: (hostname, options, cb) => {
        dns.lookup(hostname, options, (err, address, family) => {
          if (err) return cb(err);
          const list = Array.isArray(address) ? address : [{ address, family }];
          if (!priv && list.some((a) => isPrivateIp(a.address))) return cb(new Error('private_address'));
          return cb(null, address, family);
        });
      },
    }, resolve);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------- update queue + webhook
const waiters = new Map(); // botId -> Set<() => void>

function wake(botId) {
  const s = waiters.get(botId);
  if (!s) return;
  for (const fn of [...s]) fn();
}

async function deliverWebhook(bot, updateId, payload, attempt = 0) {
  const fresh = getUser(bot.id);
  if (!fresh?.bot_webhook) return;
  try {
    const body = JSON.stringify({ update_id: updateId, ...payload });
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (fresh.bot_webhook_secret) headers['x-telegram-bot-api-secret-token'] = fresh.bot_webhook_secret;
    const res = await request(fresh.bot_webhook, { method: 'POST', headers, body });
    res.resume();
    if (res.statusCode >= 200 && res.statusCode < 300) {
      q.run('DELETE FROM bot_updates WHERE update_id = ?', updateId);
      return;
    }
    throw new Error(`status ${res.statusCode}`);
  } catch (e) {
    log('warn', 'bot webhook failed', { bot: bot.id, attempt, err: e.message });
    if (attempt < 3) setTimeout(() => deliverWebhook(bot, updateId, payload, attempt + 1), 3000 * (attempt + 1)).unref();
  }
}

function enqueue(bot, payload) {
  q.run('DELETE FROM bot_updates WHERE bot_id = ? AND update_id NOT IN (SELECT update_id FROM bot_updates WHERE bot_id = ? ORDER BY update_id DESC LIMIT 1000)', bot.id, bot.id);
  const r = q.run('INSERT INTO bot_updates (bot_id, payload, created_at) VALUES (?,?,?)', bot.id, JSON.stringify(payload), now());
  const updateId = Number(r.lastInsertRowid);
  if (bot.bot_webhook) deliverWebhook(bot, updateId, payload);
  wake(bot.id);
}

/** Called by api.js for every posted message: deliver it to the bots that should see it. */
export function notifyBots(chat, row) {
  if (chat.type === 'channel') return;
  const bots = q.all(
    `SELECT u.* FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? AND m.banned = 0 AND u.is_bot = 1 AND u.bot_token_hash IS NOT NULL AND u.id != ?`,
    chat.id, row.sender_id ?? 0,
  );
  for (const bot of bots) {
    if (chat.type === 'group') {
      // privacy mode like Telegram's default: only commands, @mentions and replies to the bot
      const text = row.text || '';
      const mention = bot.username && new RegExp(`@${bot.username}\\b`, 'i').test(text);
      const toBot = row.reply_to && getMessage(row.reply_to)?.sender_id === bot.id;
      if (!(text.startsWith('/') || mention || toBot)) continue;
    }
    enqueue(bot, { message: tgMessage(row, bot.id) });
  }
}

// ---------------------------------------------------------------- Bot API
const cbQueries = new Map(); // callback query id -> { userId, chatId, at }
setInterval(() => {
  const t = Date.now();
  for (const [k, v] of cbQueries) if (t - v.at > 5 * 60_000) cbQueries.delete(k);
}, 60_000).unref();

function botFromToken(token) {
  const m = TOKEN_RE.exec(token || '');
  if (!m) return null;
  const bot = q.get('SELECT * FROM users WHERE bot_token_hash = ? AND is_bot = 1', sha256(token));
  return bot && String(bot.id) === m[1] ? bot : null;
}

const fail = (code, description) => { throw Object.assign(new HttpError(code, 'bot_api', description), { tg: true }); };

function botChat(bot, params) {
  const id = Number(params.chat_id);
  if (!Number.isInteger(id)) fail(400, 'Bad Request: chat_id is invalid');
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  const me = chat && membership(id, bot.id);
  if (!me) fail(403, 'Forbidden: bot is not a member of the chat');
  if (chat.type === 'direct') {
    const peer = directPeerId(id, bot.id);
    if (isBlockedEitherWay(bot.id, peer)) fail(403, 'Forbidden: bot was blocked by the user');
  }
  if (chat.type === 'channel' && me.role === 'member') fail(403, 'Forbidden: bot is not an administrator of the channel');
  return { chat, me };
}

async function fetchToChat(bot, chat, params, urlValue, kindHint) {
  const fid = rid(16);
  const dest = filePath(fid);
  try {
    const res = await request(String(urlValue), { headers: { 'user-agent': 'Suhbat-dosh-bot-fetch' } });
    if (res.statusCode !== 200) { res.resume(); fail(400, `Bad Request: wrong file URL (HTTP ${res.statusCode})`); }
    const size = await receive(res, dest, config.maxUploadBytes);
    if (!size) fail(400, 'Bad Request: file is empty');
    const type = sniff(readHead(dest), kindHint === 'voice');
    let name = 'file';
    try { name = decodeURIComponent(new URL(String(urlValue)).pathname.split('/').pop() || 'file'); } catch { /* keep */ }
    name = checkName(params.file_name ? String(params.file_name) : name);
    q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)',
      fid, bot.id, chat.id, name, type?.mime ?? 'application/octet-stream', size, now());
    return { fid, kind: type?.kind ?? 'file' };
  } catch (e) {
    removeFile(fid);
    if (e instanceof HttpError && e.tg) throw e;
    if (e instanceof HttpError) fail(400, `Bad Request: ${e.code}`);
    return fail(400, `Bad Request: failed to get HTTP URL content (${e.message})`);
  }
}

const METHODS = {
  getMe: (bot) => tgUser(bot) && { ...tgUser(bot), can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false },

  async getUpdates(bot, p, ctx) {
    if (bot.bot_webhook) fail(409, 'Conflict: can\'t use getUpdates method while webhook is active; use deleteWebhook to delete the webhook first');
    const offset = Number(p.offset) || 0;
    if (offset > 0) q.run('DELETE FROM bot_updates WHERE bot_id = ? AND update_id < ?', bot.id, offset);
    const limit = Math.min(100, Math.max(1, Number(p.limit) || 100));
    const timeout = Math.min(50, Math.max(0, Number(p.timeout) || 0));
    const read = () => q.all('SELECT * FROM bot_updates WHERE bot_id = ? AND update_id >= ? ORDER BY update_id LIMIT ?', bot.id, Math.max(offset, 0), limit);
    let rows = read();
    if (!rows.length && timeout > 0) {
      await new Promise((resolve) => {
        let done = false;
        const set = waiters.get(bot.id) || waiters.set(bot.id, new Set()).get(bot.id);
        const finish = () => { if (done) return; done = true; set.delete(finish); clearTimeout(timer); resolve(); };
        const timer = setTimeout(finish, timeout * 1000);
        set.add(finish);
        ctx.onClose(finish);
      });
      rows = read();
    }
    return rows.map((r) => ({ update_id: r.update_id, ...JSON.parse(r.payload) }));
  },

  sendMessage(bot, p) {
    const { chat } = botChat(bot, p);
    const text = str(typeof p.text === 'string' ? p.text : '', 'text', { min: 1, max: LIMITS.TEXT_MAX });
    const replyTo = Number(p.reply_to_message_id) || null;
    const out = host.postMessage({ chat, user: bot, text, replyTo, markup: cleanMarkup(p.reply_markup) });
    return tgMessage(getMessage(out.message.id), bot.id);
  },

  async sendMedia(bot, p, _ctx, field, hint) {
    const { chat } = botChat(bot, p);
    const src = p[field];
    if (typeof src !== 'string' || !src) fail(400, `Bad Request: ${field} must be an HTTP(S) URL or a file_id`);
    const own = q.get('SELECT * FROM files WHERE id = ?', src);
    if (!own && !/^https?:\/\//i.test(src)) fail(400, `Bad Request: ${field} must be an HTTP(S) URL or a file_id`);
    let fid = src;
    let kind;
    if (own) { // re-send a file that is already stored on this server
      if (!membership(own.chat_id, bot.id)) fail(400, 'Bad Request: wrong file_id');
      kind = sniff(readHead(filePath(own.id)), hint === 'voice')?.kind ?? 'file';
    } else {
      ({ fid, kind } = await fetchToChat(bot, chat, p, src, hint));
    }
    const duration = Number(p.duration) || null;
    const out = host.postMessage({
      chat, user: bot, text: typeof p.caption === 'string' ? p.caption.slice(0, LIMITS.TEXT_MAX) : '', kind, fileId: fid,
      duration: ['voice', 'audio', 'video'].includes(kind) ? duration : null, replyTo: Number(p.reply_to_message_id) || null, markup: cleanMarkup(p.reply_markup),
    });
    return tgMessage(getMessage(out.message.id), bot.id);
  },

  editMessageText(bot, p) {
    const { chat } = botChat(bot, p);
    const m = getMessage(Number(p.message_id));
    if (!m || m.chat_id !== chat.id || m.sender_id !== bot.id) fail(400, 'Bad Request: message to edit not found');
    const text = str(typeof p.text === 'string' ? p.text : '', 'text', { min: m.file_id ? 0 : 1, max: LIMITS.TEXT_MAX });
    q.run('UPDATE messages SET text = ?, markup = ?, edited_at = ? WHERE id = ?', text, cleanMarkup(p.reply_markup), now(), m.id);
    emit(memberIds(chat.id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(getMessage(m.id)) });
    return tgMessage(getMessage(m.id), bot.id);
  },

  editMessageReplyMarkup(bot, p) {
    const { chat } = botChat(bot, p);
    const m = getMessage(Number(p.message_id));
    if (!m || m.chat_id !== chat.id || m.sender_id !== bot.id) fail(400, 'Bad Request: message not found');
    q.run('UPDATE messages SET markup = ? WHERE id = ?', cleanMarkup(p.reply_markup), m.id);
    emit(memberIds(chat.id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(getMessage(m.id)) });
    return tgMessage(getMessage(m.id), bot.id);
  },

  deleteMessage(bot, p) {
    const { chat, me } = botChat(bot, p);
    const m = getMessage(Number(p.message_id));
    if (!m || m.chat_id !== chat.id) fail(400, 'Bad Request: message to delete not found');
    if (m.sender_id !== bot.id && !(chat.type !== 'direct' && me.role !== 'member')) fail(400, 'Bad Request: message can\'t be deleted');
    q.run('UPDATE chats SET pinned_message_id = NULL WHERE pinned_message_id = ?', m.id);
    q.run('DELETE FROM messages WHERE id = ?', m.id);
    if (m.file_id && !q.get('SELECT 1 AS x FROM messages WHERE file_id = ?', m.file_id)) {
      q.run('DELETE FROM files WHERE id = ?', m.file_id);
      removeFile(m.file_id);
    }
    refreshLastMessage(chat.id);
    const ids = memberIds(chat.id);
    emit(ids, { type: EVENTS.MESSAGE_DELETE, chat_id: chat.id, message_id: m.id });
    host.pushChat(chat.id, ids);
    return true;
  },

  sendChatAction(bot, p) {
    const { chat } = botChat(bot, p);
    emit(memberIds(chat.id).filter((x) => x !== bot.id), { type: EVENTS.TYPING, chat_id: chat.id, user_id: bot.id });
    return true;
  },

  answerCallbackQuery(bot, p) {
    const c = cbQueries.get(String(p.callback_query_id));
    if (!c || c.botId !== bot.id) fail(400, 'Bad Request: query is too old and response timeout expired or query ID is invalid');
    cbQueries.delete(String(p.callback_query_id));
    const text = typeof p.text === 'string' ? p.text.slice(0, 200) : '';
    if (text) emit([c.userId], { type: 'bot.answer', chat_id: c.chatId, text, alert: p.show_alert === true || p.show_alert === 'true' });
    return true;
  },

  setMyCommands(bot, p) {
    q.run('UPDATE users SET bot_commands = ? WHERE id = ?', JSON.stringify(cleanCommands(p.commands)), bot.id);
    pushBotProfile(bot.id);
    return true;
  },
  getMyCommands: (bot) => JSON.parse(bot.bot_commands || '[]'),
  deleteMyCommands(bot) {
    q.run("UPDATE users SET bot_commands = '[]' WHERE id = ?", bot.id);
    pushBotProfile(bot.id);
    return true;
  },

  async setWebhook(bot, p) {
    const url = typeof p.url === 'string' ? p.url.trim() : '';
    if (!url) { q.run('UPDATE users SET bot_webhook = NULL, bot_webhook_secret = NULL WHERE id = ?', bot.id); return true; }
    if (!/^https?:\/\//i.test(url) || url.length > 512) fail(400, 'Bad Request: bad webhook: invalid URL');
    try {
      const u = new URL(url);
      const host2 = u.hostname.replace(/^\[|\]$/g, '');
      if (!allowPrivate() && net.isIP(host2) && isPrivateIp(host2)) fail(400, 'Bad Request: bad webhook: IP address is not allowed');
    } catch (e) { if (e.tg) throw e; fail(400, 'Bad Request: bad webhook: invalid URL'); }
    const secret = typeof p.secret_token === 'string' ? p.secret_token.slice(0, 256) : null;
    q.run('UPDATE users SET bot_webhook = ?, bot_webhook_secret = ? WHERE id = ?', url, secret, bot.id);
    if (p.drop_pending_updates === true || p.drop_pending_updates === 'true') q.run('DELETE FROM bot_updates WHERE bot_id = ?', bot.id);
    return true;
  },
  deleteWebhook(bot, p) {
    q.run('UPDATE users SET bot_webhook = NULL, bot_webhook_secret = NULL WHERE id = ?', bot.id);
    if (p.drop_pending_updates === true || p.drop_pending_updates === 'true') q.run('DELETE FROM bot_updates WHERE bot_id = ?', bot.id);
    return true;
  },
  getWebhookInfo: (bot) => ({
    url: bot.bot_webhook || '',
    has_custom_certificate: false,
    pending_update_count: q.get('SELECT COUNT(*) AS n FROM bot_updates WHERE bot_id = ?', bot.id).n,
  }),

  getChat(bot, p) {
    const { chat } = botChat(bot, p);
    return { ...tgChat(chat.id, bot.id), description: chat.description || undefined };
  },

  getFile(bot, p) {
    const f = q.get('SELECT * FROM files WHERE id = ?', String(p.file_id || ''));
    if (!f || !f.chat_id || !membership(f.chat_id, bot.id)) fail(400, 'Bad Request: wrong file_id');
    return { file_id: f.id, file_unique_id: f.id, file_size: f.size, file_path: `files/${f.id}` };
  },
};
METHODS.sendPhoto = (bot, p, c) => METHODS.sendMedia(bot, p, c, 'photo', 'image');
METHODS.sendDocument = (bot, p, c) => METHODS.sendMedia(bot, p, c, 'document', 'file');
METHODS.sendVoice = (bot, p, c) => METHODS.sendMedia(bot, p, c, 'voice', 'voice');
METHODS.sendAudio = (bot, p, c) => METHODS.sendMedia(bot, p, c, 'audio', 'audio');
METHODS.sendVideo = (bot, p, c) => METHODS.sendMedia(bot, p, c, 'video', 'video');
// aliases some libraries use
METHODS.getme = METHODS.getMe;

function pushBotProfile(botId) {
  const u = getUser(botId);
  if (!u) return;
  const viewers = q.all('SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN members m2 ON m2.chat_id = m1.chat_id WHERE m1.user_id = ?', botId).map((r) => r.id);
  for (const v of viewers) emit([v], { type: EVENTS.PRESENCE, user: publicUser(u, v) });
}

export const botApi = express.Router();
botApi.use(express.json({ limit: '256kb' }));
botApi.use(express.urlencoded({ extended: false, limit: '256kb' }));

botApi.all(/^\/bot([^/]+)\/([A-Za-z]+)$/, async (req, res) => {
  const [token, method] = [req.params[0], req.params[1]];
  res.setHeader('Cache-Control', 'no-store');
  const bot = botFromToken(token);
  if (!bot) return res.status(401).json({ ok: false, error_code: 401, description: 'Unauthorized' });
  if (!rateLimit(`botapi:${bot.id}`, 60, 1000)) {
    return res.status(429).json({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
  }
  const fn = METHODS[method];
  if (!fn || method === 'sendMedia') return res.status(404).json({ ok: false, error_code: 404, description: 'Not Found' });
  const params = { ...req.query, ...(req.body && typeof req.body === 'object' ? req.body : {}) };
  const ctx = { onClose: (f) => res.on('close', f) };
  q.run('UPDATE users SET last_seen = ? WHERE id = ?', now(), bot.id);
  try {
    const result = await fn(bot, params, ctx);
    return res.json({ ok: true, result });
  } catch (e) {
    if (e instanceof HttpError) {
      return res.status(e.status).json({ ok: false, error_code: e.status, description: e.tg ? e.message : `Bad Request: ${e.code}` });
    }
    log('error', 'bot api', { err: e?.message });
    return res.status(500).json({ ok: false, error_code: 500, description: 'Internal Server Error' });
  }
});

// files for bots: /file/bot<token>/files/<id>
botApi.get(/^\/file\/bot([^/]+)\/files\/([A-Za-z0-9_-]+)$/, (req, res) => {
  const bot = botFromToken(req.params[0]);
  if (!bot) return res.status(401).json({ ok: false, error_code: 401, description: 'Unauthorized' });
  const f = q.get('SELECT * FROM files WHERE id = ?', req.params[1]);
  if (!f || !f.chat_id || !membership(f.chat_id, bot.id) || !fs.existsSync(filePath(f.id))) return res.status(404).json({ ok: false, error_code: 404, description: 'Not Found' });
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.sendFile(filePath(f.id), { dotfiles: 'allow' });
});

// ---------------------------------------------------------------- owner-side management (session auth + BotFather)
export const botsRouter = express.Router();

export const botOut = (b, withHook = true) => ({
  ...publicUser(b, b.bot_owner_id),
  is_bot: true,
  description: b.bio,
  commands: JSON.parse(b.bot_commands || '[]'),
  webhook: withHook ? b.bot_webhook || null : undefined,
  created_at: b.created_at,
});

const newToken = (id) => `${id}:${rid(24)}`;

export const listOwnBots = (ownerId) => q.all('SELECT * FROM users WHERE is_bot = 1 AND bot_owner_id = ? ORDER BY id', ownerId);

export function ownBot(ownerId, id) {
  const b = q.get('SELECT * FROM users WHERE id = ? AND is_bot = 1 AND bot_owner_id = ?', Number(id), ownerId);
  if (!b) throw new HttpError(404, 'not_found');
  return b;
}

/** Create a bot account for `owner`. Returns { bot, token } (the token is never stored in clear text). */
export function createBotAccount(owner, nameRaw, usernameRaw) {
  if (!rateLimit(`botcreate:${owner.id}`, 10, 3600_000)) throw new HttpError(429, 'slow_down');
  if (owner.is_bot) throw new HttpError(403, 'forbidden');
  if (q.get('SELECT COUNT(*) AS n FROM users WHERE is_bot = 1 AND bot_owner_id = ?', owner.id).n >= MAX_BOTS_PER_USER) throw new HttpError(400, 'too_many_bots');
  const name = str(nameRaw, 'name', { min: 1, max: LIMITS.NAME_MAX });
  const username = str(usernameRaw, 'username', { min: 5, max: LIMITS.USERNAME_MAX }).replace(/^@/, '');
  if (!BOT_USERNAME.test(username)) throw new HttpError(400, 'invalid_bot_username');
  let id;
  try {
    const r = q.run(
      'INSERT INTO users (phone, username, name, last_seen, created_at, is_bot, bot_owner_id) VALUES (?,?,?,?,?,1,?)',
      `bot:${rid(9)}`, username, name, now(), now(), owner.id,
    );
    id = Number(r.lastInsertRowid);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'username_taken');
    throw e;
  }
  const token = newToken(id);
  q.run('UPDATE users SET bot_token_hash = ? WHERE id = ?', sha256(token), id);
  audit(owner.id, 'bot.create', { target_type: 'user', target_id: id, details: { username } });
  return { bot: getUser(id), token };
}

export function updateBotAccount(owner, id, body) {
  const b = ownBot(owner.id, id);
  if (body.name !== undefined) q.run('UPDATE users SET name = ? WHERE id = ?', str(body.name, 'name', { min: 1, max: LIMITS.NAME_MAX }), b.id);
  if (body.description !== undefined) q.run('UPDATE users SET bio = ? WHERE id = ?', str(body.description, 'description', { max: LIMITS.BIO_MAX }), b.id);
  if (body.commands !== undefined) q.run('UPDATE users SET bot_commands = ? WHERE id = ?', JSON.stringify(cleanCommands(body.commands)), b.id);
  if (body.webhook !== undefined) {
    const url = typeof body.webhook === 'string' ? body.webhook.trim() : '';
    if (url && !/^https?:\/\//i.test(url)) throw new HttpError(400, 'bad_url');
    q.run('UPDATE users SET bot_webhook = ? WHERE id = ?', url || null, b.id);
  }
  pushBotProfile(b.id);
  return getUser(b.id);
}

export function resetBotToken(owner, id) {
  const b = ownBot(owner.id, id);
  const token = newToken(b.id);
  q.run('UPDATE users SET bot_token_hash = ? WHERE id = ?', sha256(token), b.id);
  audit(owner.id, 'bot.token_reset', { target_type: 'user', target_id: b.id });
  return token;
}

export function deleteBotAccount(owner, id) {
  const b = ownBot(owner.id, id);
  const chats = q.all("SELECT c.id FROM chats c JOIN members m ON m.chat_id = c.id WHERE m.user_id = ? AND c.type = 'direct'", b.id).map((r) => r.id);
  const watchers = new Map();
  for (const cid of chats) watchers.set(cid, memberIds(cid));
  const fileIds = [];
  tx(() => {
    for (const cid of chats) {
      fileIds.push(...q.all('SELECT id FROM files WHERE chat_id = ?', cid).map((r) => r.id));
      q.run('DELETE FROM chats WHERE id = ?', cid);
    }
    q.run('DELETE FROM users WHERE id = ?', b.id);
  });
  for (const f of fileIds) removeFile(f);
  for (const [cid, uids] of watchers) emit(uids, { type: EVENTS.CHAT_REMOVE, chat_id: cid });
  audit(owner.id, 'bot.delete', { target_type: 'user', target_id: b.id, details: { username: b.username } });
}

// BotFather answers button presses itself (it has no token and no external process)
let fatherHooks = { callback: null };
export function wireBotFatherCallbacks(h) { fatherHooks = h; }

botsRouter.get('/', (req, res) => {
  res.json({ bots: listOwnBots(req.user.id).map((b) => botOut(b)) });
});

/** The built-in bot that creates and configures bots from a chat. */
botsRouter.get('/father', (req, res) => {
  const u = q.get("SELECT * FROM users WHERE phone = 'system:botfather'");
  if (!u) throw new HttpError(404, 'not_found');
  res.json({ user: publicUser(u, req.user.id) });
});

botsRouter.post('/', (req, res) => {
  const r = createBotAccount(req.user, req.body?.name, req.body?.username);
  res.status(201).json({ bot: botOut(r.bot), token: r.token });
});

botsRouter.post('/callback', async (req, res) => {
  const mid = int(req.body?.message_id, 'message_id');
  const data = str(typeof req.body?.data === 'string' ? req.body.data : '', 'data', { min: 1, max: 64 });
  const m = getMessage(mid);
  if (!m || !membership(m.chat_id, req.user.id)) throw new HttpError(404, 'not_found');
  if (!rateLimit(`botcb:${req.user.id}`, 20, 5000)) throw new HttpError(429, 'slow_down');
  const bot = m.sender_id ? getUser(m.sender_id) : null;
  if (!bot?.is_bot || !m.markup) throw new HttpError(400, 'invalid_input');
  const ok = JSON.parse(m.markup).inline_keyboard.some((row) => row.some((b) => b.callback_data === data));
  if (!ok) throw new HttpError(400, 'invalid_input');
  if (bot.phone === 'system:botfather') {
    await fatherHooks.callback?.(req.user, m, data);
    return res.json({ ok: true });
  }
  const id = rid(9);
  cbQueries.set(id, { botId: bot.id, userId: req.user.id, chatId: m.chat_id, at: Date.now() });
  enqueue(bot, {
    callback_query: {
      id, from: tgUser(req.user), message: tgMessage(m, bot.id), chat_instance: String(m.chat_id), data,
    },
  });
  return res.json({ ok: true });
});

botsRouter.patch('/:id', (req, res) => {
  res.json({ bot: botOut(updateBotAccount(req.user, req.params.id, req.body || {})) });
});

botsRouter.post('/:id/token', (req, res) => {
  res.json({ token: resetBotToken(req.user, req.params.id) });
});

botsRouter.delete('/:id', (req, res) => {
  deleteBotAccount(req.user, req.params.id);
  res.json({ ok: true });
});
