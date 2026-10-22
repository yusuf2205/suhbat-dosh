// Personal safety and identity: checking a conversation partner's safety number, and a different name + animal avatar per group.
import express from 'express';
import { q } from './db.js';
import { ANIMAL_IDS } from '../../shared/animals.js';
import { HttpError, int, now, rateLimit, str } from './util.js';
import { audit, chatOut, memberIds, requireMember } from './service.js';
import { emit } from './realtime.js';

export const personal = express.Router();

const shareChat = (a, b) => !!q.get(
  'SELECT 1 AS x FROM members m1 JOIN members m2 ON m2.chat_id = m1.chat_id WHERE m1.user_id = ? AND m2.user_id = ? AND m1.banned = 0 AND m2.banned = 0 LIMIT 1', a, b,
);

// ------------------------------------------------------------------ safety number
// Both phones compute the same number from the public keys of the devices of both people; if anybody's keys change, the number
// changes. The server only hands out public keys and remembers which number was confirmed.
personal.get('/users/:id/safety', (req, res) => {
  const uid = int(req.params.id, 'id');
  if (uid !== req.user.id && !shareChat(req.user.id, uid)) throw new HttpError(404, 'not_found');
  const devices = q.all('SELECT pub FROM e2e_devices WHERE user_id = ? ORDER BY pub', uid).map((d) => d.pub);
  const v = uid === req.user.id ? null : q.get('SELECT number, at FROM verified_peers WHERE user_id = ? AND peer_id = ?', req.user.id, uid);
  res.json({ user_id: uid, devices, verified: v ? { number: v.number, at: v.at } : null });
});

personal.post('/users/:id/verify', (req, res) => {
  const uid = int(req.params.id, 'id');
  if (uid === req.user.id || !shareChat(req.user.id, uid)) throw new HttpError(404, 'not_found');
  if (!rateLimit(`verify:${req.user.id}`, 60, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const number = str(String(req.body?.number ?? ''), 'number', { min: 60, max: 60 });
  if (!/^\d{60}$/.test(number)) throw new HttpError(400, 'invalid_input');
  q.run(
    'INSERT INTO verified_peers (user_id, peer_id, number, at) VALUES (?,?,?,?) ON CONFLICT(user_id, peer_id) DO UPDATE SET number = excluded.number, at = excluded.at',
    req.user.id, uid, number, now(),
  );
  audit(req.user.id, 'safety.verify', { target_type: 'user', target_id: uid });
  res.json({ ok: true, verified: { number, at: now() } });
});

personal.delete('/users/:id/verify', (req, res) => {
  q.run('DELETE FROM verified_peers WHERE user_id = ? AND peer_id = ?', req.user.id, int(req.params.id, 'id'));
  res.json({ ok: true });
});

// ------------------------------------------------------------------ a name and an animal for one group
/** { animal: 'goose', name: 'Неопознанный Гусь' } sets it; { animal: '' } returns to the real name. Groups only. */
personal.put('/chats/:id/alias', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const chat = q.get('SELECT type, e2e FROM chats WHERE id = ?', id);
  if (chat.type !== 'group') throw new HttpError(400, 'groups_only');
  const animal = String(req.body?.animal ?? '');
  if (animal !== '' && !ANIMAL_IDS.has(animal)) throw new HttpError(400, 'invalid_input');
  const name = animal ? str(String(req.body?.name ?? ''), 'name', { min: 2, max: 40 }).replace(/[\u0000-\u001f]/g, '') : '';
  if (!rateLimit(`alias:${req.user.id}`, 30, 3600_000)) throw new HttpError(429, 'too_many_requests');
  q.run('UPDATE members SET alias_name = ?, alias_animal = ? WHERE chat_id = ? AND user_id = ?', name, animal, id, req.user.id);
  audit(req.user.id, 'chat.alias', { chat_id: id, details: { animal } });
  for (const uid of memberIds(id)) emit([uid], { type: 'chat.update', chat: chatOut(id, uid) });
  res.json({ chat: chatOut(id, req.user.id) });
});
