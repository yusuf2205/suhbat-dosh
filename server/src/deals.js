// "Договорились": the outcome of a conversation as a card in the chat: what was agreed, who is responsible, until when.
// The people in the chat agree with one tap; the owner gets a reminder at the due time; the card is pinned in the chat.
import express from 'express';
import { q } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { HttpError, int, now, rateLimit, str } from './util.js';
import { emit } from './realtime.js';
import { getMessage, isEncrypted, memberIds, membership, messageOut, requireMember } from './service.js';

let host = { postMessage: null };
export function wireDeals(h) { host = h; }
export const deals = express.Router();

const push = (messageId) => {
  const m = getMessage(messageId);
  const out = messageOut(m);
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: out });
  return out;
};

/** One reminder for the person responsible (else the author) at the due time. */
function syncReminder(d) {
  const ref = `deal:${d.id}`;
  q.run('DELETE FROM scheduled WHERE ref = ?', ref);
  const who = d.owner_id || d.creator_id;
  if (d.done || !d.due_at || d.due_at <= now() || !who) return;
  q.run("INSERT INTO scheduled (user_id, chat_id, kind, text, send_at, created_at, ref) VALUES (?,?,'reminder',?,?,?,?)", who, d.chat_id, `\u{1F91D} ${d.title}`, d.due_at, now(), ref);
}

function dueOf(v) {
  if (v === undefined || v === null || v === '' || v === 0) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < now() - 60_000 || n > now() + 5 * 365 * 86400_000) throw new HttpError(400, 'invalid_time');
  return Math.round(n);
}

deals.post('/chats/:id/deals', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type === 'channel' && me.role === 'member') throw new HttpError(403, 'channel_readonly');
  if (isEncrypted(id)) throw new HttpError(403, 'secret_no_tasks');
  if (!rateLimit(`deal:${req.user.id}`, 30, 60_000)) throw new HttpError(429, 'slow_down');
  const title = str(req.body?.title, 'title', { min: 1, max: 300 });
  const due = dueOf(req.body?.due_at);
  let owner = null;
  if (req.body?.owner_id !== undefined && req.body.owner_id !== null && req.body.owner_id !== '') {
    owner = Number(req.body.owner_id);
    if (!Number.isInteger(owner) || !membership(id, owner)) throw new HttpError(400, 'invalid_input');
  }
  const out = host.postMessage({ chat, user: req.user, text: title, kind: 'deal' });
  const r = q.run('INSERT INTO deals (message_id, chat_id, creator_id, owner_id, title, due_at, created_at) VALUES (?,?,?,?,?,?,?)', out.message.id, id, req.user.id, owner, title, due, now());
  const dealId = Number(r.lastInsertRowid);
  q.run('INSERT INTO deal_ok (deal_id, user_id, at) VALUES (?,?,?)', dealId, req.user.id, now());   // the author agrees with their own card
  syncReminder(q.get('SELECT * FROM deals WHERE id = ?', dealId));
  res.status(201).json({ message: push(out.message.id) });
});

const load = (id) => {
  const d = q.get('SELECT * FROM deals WHERE id = ?', id);
  if (!d) throw new HttpError(404, 'not_found');
  return d;
};

deals.post('/deals/:id/agree', (req, res) => {
  const d = load(int(req.params.id, 'id'));
  requireMember(d.chat_id, req.user.id);
  const has = q.get('SELECT 1 AS x FROM deal_ok WHERE deal_id = ? AND user_id = ?', d.id, req.user.id);
  const want = req.body?.agree === undefined ? !has : req.body.agree === true;
  if (want && !has) q.run('INSERT INTO deal_ok (deal_id, user_id, at) VALUES (?,?,?)', d.id, req.user.id, now());
  if (!want && has) q.run('DELETE FROM deal_ok WHERE deal_id = ? AND user_id = ?', d.id, req.user.id);
  res.json({ message: push(d.message_id) });
});

/** Marked as done by the person responsible, the author or a chat admin. */
deals.post('/deals/:id/done', (req, res) => {
  const d = load(int(req.params.id, 'id'));
  const me = requireMember(d.chat_id, req.user.id);
  if (!(d.owner_id === req.user.id || d.creator_id === req.user.id || d.owner_id === null || me.role !== 'member')) throw new HttpError(403, 'forbidden');
  const done = req.body?.done === undefined ? !d.done : req.body.done === true;
  q.run('UPDATE deals SET done = ?, done_at = ? WHERE id = ?', done ? 1 : 0, done ? now() : null, d.id);
  syncReminder(q.get('SELECT * FROM deals WHERE id = ?', d.id));
  res.json({ message: push(d.message_id) });
});
