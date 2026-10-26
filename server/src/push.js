// Web Push (VAPID): notifications for people whose app is closed. No third-party account is needed;
// the browser vendor's push service only relays an end-to-end encrypted payload.
import express from 'express';
import webpush from 'web-push';
import { q } from './db.js';
import { getSetting, setSetting } from './access.js';
import { HttpError, log, now, rateLimit } from './util.js';
import { isOnline } from './realtime.js';
import { getUser, memberIds } from './service.js';
import { focusActive, focusAllows } from '../../shared/focus.js';

export const focusOf = (u) => { try { return u.focus ? JSON.parse(u.focus) : null; } catch { return null; } };

/** Does the focus mode of this user mute a notification from `senderId`? */
export function focusMutes(u, ev) {
  const f = focusOf(u);
  if (!f || !focusActive(f)) return false;
  return !focusAllows(f, ev);
}

let keys = null;
function vapid() {
  if (keys) return keys;
  try { keys = JSON.parse(getSetting('vapid', 'null')); } catch { keys = null; }
  if (!keys?.publicKey) {
    keys = webpush.generateVAPIDKeys();
    setSetting('vapid', JSON.stringify(keys));
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@suhbat-dosh.uz', keys.publicKey, keys.privateKey);
  return keys;
}

export const pushRouter = express.Router();

pushRouter.get('/push/key', (_req, res) => res.json({ key: vapid().publicKey }));

pushRouter.post('/push/subscribe', (req, res) => {
  if (!rateLimit(`pushsub:${req.user.id}`, 30, 3600_000)) throw new HttpError(429, 'slow_down');
  const s = req.body?.subscription;
  const endpoint = s?.endpoint;
  if (typeof endpoint !== 'string' || !/^https:\/\//.test(endpoint) || endpoint.length > 600
    || typeof s?.keys?.p256dh !== 'string' || typeof s?.keys?.auth !== 'string') throw new HttpError(400, 'invalid_input');
  q.run(
    `INSERT INTO push_subs (user_id, endpoint, p256dh, auth, ua, created_at) VALUES (?,?,?,?,?,?)
     ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`,
    req.user.id, endpoint, s.keys.p256dh.slice(0, 200), s.keys.auth.slice(0, 100), String(req.headers['user-agent'] || '').slice(0, 160), now(),
  );
  res.json({ ok: true });
});

/** How many messages wait for this person in chats that are not muted or archived (the number on the app icon). */
export function unreadBadge(uid) {
  return q.get(
    `SELECT COUNT(*) AS n FROM (SELECT 1 FROM messages m
       JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0 AND mb.muted = 0 AND mb.archived = 0 AND COALESCE(mb.muted_until, 0) <= ?
       WHERE m.id > MAX(mb.last_read_id, mb.cleared_before) AND m.thread_of IS NULL AND (m.sender_id IS NULL OR m.sender_id != ?) LIMIT 99)`, uid, now(), uid).n;
}

/** A test notification to all the devices of the person: is the phone really reachable in the background? */
pushRouter.post('/push/test', (req, res) => {
  if (!rateLimit(`pushtest:${req.user.id}`, 6, 60_000)) throw new HttpError(429, 'slow_down');
  const sent = pushToUser(req.user.id, { title: 'Suhbat-dosh', body: 'Проверка уведомлений: всё работает', tag: 'push-test', badge: unreadBadge(req.user.id) }, { ttl: 120 });
  res.json({ ok: true, devices: sent });
});

pushRouter.post('/push/unsubscribe', (req, res) => {
  q.run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', String(req.body?.endpoint || ''), req.user.id);
  res.json({ ok: true });
});

const preview = (m) => {
  if (m.kind === 'secret') return '🔒 Секретное сообщение';
  if (m.kind === 'poll') return `📊 ${m.text}`;
  if (m.kind === 'event') return `📅 ${m.text}`;
  if (m.kind === 'miniapp') return `🧩 ${m.text}`;
  if (m.kind === 'task') return `✅ ${m.text}`;
  if (m.kind === 'deal') return `\u{1F91D} ${m.text}`;
  if (m.kind === 'note') return `📝 ${m.text}`;
  if (m.kind === 'location') return '📍 Геолокация';
  if (m.kind === 'sticker') return `${m.text || ''} Стикер`.trim();
  if (m.kind === 'contact') { try { return `👤 ${JSON.parse(m.text).name}`; } catch { return '👤 Контакт'; } }
  if (m.text) return m.text.replace(/\{\{e:[\w-]{8,40}\}\}/g, '🙂').slice(0, 140);
  return ({ image: '🖼 Фото', video: '🎬 Видео', voice: '🎤 Голосовое сообщение', audio: '🎵 Аудио', file: '📎 Файл', call: '📞 Звонок' })[m.kind] || 'Новое сообщение';
};

/** Web Push to every device of one user (used for incoming calls). Returns how many devices were tried. */
export function pushToUser(userId, data, { ttl = 60, urgency = 'high' } = {}) {
  const subs = q.all('SELECT * FROM push_subs WHERE user_id = ?', userId);
  if (!subs.length) return 0;
  vapid();
  const payload = JSON.stringify(data);
  for (const s of subs) {
    try {
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: ttl, urgency })
        .catch((e) => {
          if (e.statusCode === 404 || e.statusCode === 410) q.run('DELETE FROM push_subs WHERE id = ?', s.id);
          else log('warn', 'push failed', { status: e.statusCode, err: String(e.message).slice(0, 80) });
        });
    } catch (e) { log('warn', 'push failed', { err: String(e.message).slice(0, 80) }); }
  }
  return subs.length;
}

/** Called for every new message: push to members who are offline and have not muted the chat. */
export function pushNewMessage(chat, row) {
  if (row.kind === 'call') return;
  const sender = row.sender_id ? getUser(row.sender_id) : null;
  const title = chat.type === 'direct' ? sender?.name || 'Suhbat-dosh' : `${chat.title}${sender ? ` · ${sender.name}` : ''}`;
  const base = { title, body: preview(row), chat_id: chat.id, message_id: row.id, tag: `chat-${chat.id}` };
  for (const uid of memberIds(chat.id)) {
    if (uid === row.sender_id || isOnline(uid)) continue;
    const m = q.get('SELECT muted, muted_until FROM members WHERE chat_id = ? AND user_id = ?', chat.id, uid);
    if (!m || m.muted || (m.muted_until || 0) > now()) continue;
    const u = getUser(uid);
    if (!u || u.banned_at || u.presence === 'busy') continue; // "busy": no notifications
    const mention = !!u.username && new RegExp(`@${u.username}\\b`, 'i').test(row.text || '');
    if (focusMutes(u, { senderId: row.sender_id, urgent: !!row.urgent, mention })) continue; // focus mode
    const payload = JSON.stringify({ ...base, badge: unreadBadge(uid) });
    for (const s of q.all('SELECT * FROM push_subs WHERE user_id = ?', uid)) {
      vapid();
      webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 3600, urgency: 'high' })
        .catch((e) => {
          if (e.statusCode === 404 || e.statusCode === 410) q.run('DELETE FROM push_subs WHERE id = ?', s.id);
          else log('warn', 'push failed', { status: e.statusCode, err: String(e.message).slice(0, 80) });
        });
    }
  }
}
