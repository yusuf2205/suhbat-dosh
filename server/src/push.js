// Web Push (VAPID): notifications for people whose app is closed. No third-party account is needed;
// the browser vendor's push service only relays an end-to-end encrypted payload.
import express from 'express';
import webpush from 'web-push';
import { q } from './db.js';
import { getSetting, setSetting } from './access.js';
import { HttpError, log, now, rateLimit } from './util.js';
import { isOnline } from './realtime.js';
import { getUser, memberIds } from './service.js';

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

pushRouter.post('/push/unsubscribe', (req, res) => {
  q.run('DELETE FROM push_subs WHERE endpoint = ? AND user_id = ?', String(req.body?.endpoint || ''), req.user.id);
  res.json({ ok: true });
});

const preview = (m) => {
  if (m.kind === 'secret') return '🔒 Секретное сообщение';
  if (m.kind === 'poll') return `📊 ${m.text}`;
  if (m.kind === 'event') return `📅 ${m.text}`;
  if (m.kind === 'miniapp') return `🧩 ${m.text}`;
  if (m.kind === 'location') return '📍 Геолокация';
  if (m.kind === 'sticker') return `${m.text || ''} Стикер`.trim();
  if (m.kind === 'contact') { try { return `👤 ${JSON.parse(m.text).name}`; } catch { return '👤 Контакт'; } }
  if (m.text) return m.text.slice(0, 140);
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
  const payload = JSON.stringify({ title, body: preview(row), chat_id: chat.id, message_id: row.id, tag: `chat-${chat.id}` });
  for (const uid of memberIds(chat.id)) {
    if (uid === row.sender_id || isOnline(uid)) continue;
    const m = q.get('SELECT muted, muted_until FROM members WHERE chat_id = ? AND user_id = ?', chat.id, uid);
    if (!m || m.muted || (m.muted_until || 0) > now()) continue;
    const u = getUser(uid);
    if (!u || u.banned_at || u.presence === 'busy') continue; // "busy": no notifications
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
