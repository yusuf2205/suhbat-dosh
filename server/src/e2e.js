// End-to-end encrypted groups: the server is only a post office for public keys and for wrapped group keys.
//  * every device of a person has its own key pair (the private part never leaves the device);
//  * a member's device that holds the group key wraps it for the devices that do not have it yet (a new member, a new phone);
//  * when somebody is removed, an admin's device makes a new key (epoch) for the people who remain.
import express from 'express';
import { q, tx } from './db.js';
import { HttpError, int, now, rateLimit } from './util.js';
import { emit } from './realtime.js';
import { chatOut, memberIds, requireMember } from './service.js';
import { EVENTS } from '../../shared/contracts.js';

export const e2e = express.Router();

const PUB_RE = /^[A-Za-z0-9+/=_-]{80,140}$/;
const DEV_RE = /^[A-Za-z0-9_-]{16,40}$/;
const MAX_DEVICES = 8;
const FRESH_MS = 180 * 86400_000;

const devicesOfChat = (chatId) => q.all(
  `SELECT d.id, d.user_id, d.pub FROM e2e_devices d JOIN members m ON m.user_id = d.user_id AND m.chat_id = ? AND m.banned = 0
   WHERE d.seen_at > ? ORDER BY d.user_id, d.created_at`, chatId, now() - FRESH_MS);

/** Tell the members that somebody must wrap the group key for a new device or make a new key. */
export function e2eNeed(chatId) {
  const c = q.get('SELECT e2e FROM chats WHERE id = ?', chatId);
  if (!c?.e2e) return;
  emit(memberIds(chatId), { type: 'e2e.need', chat_id: chatId });
}

/** Removing a member: the next key must not reach that person's devices. */
export function e2eRotate(chatId) {
  const c = q.get('SELECT e2e FROM chats WHERE id = ?', chatId);
  if (!c?.e2e) return;
  q.run('UPDATE chats SET e2e_rotate = 1 WHERE id = ?', chatId);
  e2eNeed(chatId);
}

/** Register (or refresh) this device. */
e2e.post('/e2e/devices', (req, res) => {
  if (!rateLimit(`e2edev:${req.user.id}`, 40, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const id = String(req.body?.id ?? '');
  const pub = String(req.body?.pub ?? '');
  if (!DEV_RE.test(id) || !PUB_RE.test(pub)) throw new HttpError(400, 'invalid_input');
  const name = String(req.body?.name ?? '').replace(/[\u0000-\u001f]/g, '').slice(0, 60);
  const have = q.get('SELECT * FROM e2e_devices WHERE id = ?', id);
  let fresh = false;
  if (have) {
    if (have.user_id !== req.user.id || have.pub !== pub) throw new HttpError(409, 'device_conflict');
    q.run('UPDATE e2e_devices SET seen_at = ?, name = ? WHERE id = ?', now(), name, id);
  } else {
    const mine = q.all('SELECT id FROM e2e_devices WHERE user_id = ? ORDER BY seen_at', req.user.id);
    for (const old of mine.slice(0, Math.max(0, mine.length - (MAX_DEVICES - 1)))) q.run('DELETE FROM e2e_devices WHERE id = ?', old.id);
    q.run('INSERT INTO e2e_devices (id, user_id, pub, name, created_at, seen_at) VALUES (?,?,?,?,?,?)', id, req.user.id, pub, name, now(), now());
    fresh = true;
  }
  if (fresh) {
    for (const c of q.all('SELECT m.chat_id FROM members m JOIN chats c ON c.id = m.chat_id WHERE m.user_id = ? AND m.banned = 0 AND c.e2e = 1', req.user.id)) e2eNeed(c.chat_id);
  }
  res.json({ ok: true, new: fresh });
});

/** State of an encrypted group for this device: the epoch, everybody's devices, and the wrapped keys meant for this device. */
e2e.get('/chats/:id/e2e', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (!c?.e2e) throw new HttpError(404, 'not_found');
  const device = String(req.query.device ?? '');
  const mine = DEV_RE.test(device) && q.get('SELECT 1 AS x FROM e2e_devices WHERE id = ? AND user_id = ?', device, req.user.id);
  const keys = mine ? q.all('SELECT epoch, wrapped FROM e2e_keys WHERE chat_id = ? AND device_id = ? ORDER BY epoch', id, device) : [];
  const devices = devicesOfChat(id);
  const have = new Set(q.all('SELECT device_id FROM e2e_keys WHERE chat_id = ? AND epoch = ?', id, c.e2e_epoch).map((r) => r.device_id));
  res.json({
    epoch: c.e2e_epoch, rotate: !!c.e2e_rotate, devices,
    missing: devices.filter((d) => !have.has(d.id)).map((d) => d.id), keys,
  });
});

/** { epoch, wraps: [{ device, wrapped }] }: wrap the current key for more devices, or start the next epoch (admins; the owner for the first one). */
e2e.post('/chats/:id/e2e/keys', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (!c?.e2e) throw new HttpError(404, 'not_found');
  if (!rateLimit(`e2ekeys:${req.user.id}`, 120, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const epoch = int(req.body?.epoch, 'epoch', { min: 1, max: 100000 });
  const wraps = Array.isArray(req.body?.wraps) ? req.body.wraps.slice(0, 600) : [];
  if (!wraps.length) throw new HttpError(400, 'invalid_input');
  const next = epoch === c.e2e_epoch + 1;
  if (!next && epoch !== c.e2e_epoch) throw new HttpError(409, 'epoch_conflict');
  if (next && me.role === 'member') throw new HttpError(403, 'forbidden');
  const allowed = new Map(devicesOfChat(id).map((d) => [d.id, d]));
  tx(() => {
    for (const w of wraps) {
      const dev = String(w?.device ?? '');
      const wrapped = String(w?.wrapped ?? '');
      if (!allowed.has(dev) || wrapped.length < 20 || wrapped.length > 800) throw new HttpError(400, 'invalid_input');
      q.run('INSERT OR IGNORE INTO e2e_keys (chat_id, epoch, device_id, wrapped, created_at) VALUES (?,?,?,?,?)', id, epoch, dev, wrapped, now());
    }
    if (next) q.run('UPDATE chats SET e2e_epoch = ?, e2e_rotate = 0 WHERE id = ?', epoch, id);
  });
  for (const uid of new Set(wraps.map((w) => allowed.get(String(w.device))?.user_id).filter(Boolean))) emit([uid], { type: 'e2e.keys', chat_id: id });
  if (next) for (const uid of memberIds(id)) emit([uid], { type: EVENTS.CHAT_UPDATE, chat: chatOut(id, uid) });
  res.json({ ok: true, epoch: next ? epoch : c.e2e_epoch });
});
