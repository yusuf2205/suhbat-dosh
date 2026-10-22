// Mini-apps inside chats: a shared checklist and an expense splitter. All state lives in one JSON document per app;
// every change goes through /mini/:id/op, is validated here, and is pushed to the chat as a message update.
import express from 'express';
import { q } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { HttpError, int, now, rateLimit, rid, str } from './util.js';
import { emit } from './realtime.js';
import { getMessage, memberIds, messageOut, requireMember } from './service.js';

let host = { postMessage: null };
export function wireMini(h) { host = h; }
export const mini = express.Router();

const push = (a) => {
  const m = getMessage(a.message_id);
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(m) });
  return messageOut(m);
};
const load = (id) => {
  const a = q.get('SELECT * FROM mini_apps WHERE id = ?', id);
  if (!a) throw new HttpError(404, 'not_found');
  return a;
};
const save = (a, data) => {
  q.run('UPDATE mini_apps SET data = ?, updated_at = ? WHERE id = ?', JSON.stringify(data), now(), a.id);
};

mini.post('/chats/:id/mini', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type === 'channel' && me.role === 'member') throw new HttpError(403, 'channel_readonly');
  if (!rateLimit(`mini:${req.user.id}`, 20, 60_000)) throw new HttpError(429, 'slow_down');
  const type = req.body?.type;
  if (!['checklist', 'expenses'].includes(type)) throw new HttpError(400, 'invalid_input');
  const title = str(req.body?.title, 'title', { min: 1, max: 80 });
  const data = type === 'checklist' ? { items: [] } : { currency: 'UZS', expenses: [] };
  const out = host.postMessage({ chat, user: req.user, text: title, kind: 'miniapp' });
  q.run('INSERT INTO mini_apps (message_id, chat_id, type, title, data, creator_id, updated_at) VALUES (?,?,?,?,?,?,?)',
    out.message.id, id, type, title, JSON.stringify(data), req.user.id, now());
  const a = q.get('SELECT * FROM mini_apps WHERE message_id = ?', out.message.id);
  res.status(201).json({ message: push(a) });
});

mini.post('/mini/:id/op', (req, res) => {
  if (!rateLimit(`miniop:${req.user.id}`, 120, 60_000)) throw new HttpError(429, 'slow_down');
  const a = load(int(req.params.id, 'id'));
  requireMember(a.chat_id, req.user.id);
  const data = JSON.parse(a.data);
  const op = req.body?.op;
  const members = new Set(memberIds(a.chat_id));

  if (a.type === 'checklist') {
    data.items ||= [];
    if (op === 'add') {
      if (data.items.length >= 200) throw new HttpError(400, 'too_many_items');
      data.items.push({ id: rid(6), text: str(req.body?.text, 'text', { min: 1, max: 200 }), done: false, by: req.user.id, at: now() });
    } else if (op === 'toggle') {
      const it = data.items.find((x) => x.id === req.body?.item);
      if (!it) throw new HttpError(404, 'not_found');
      it.done = !it.done;
      it.done_by = it.done ? req.user.id : null;
    } else if (op === 'remove') {
      const it = data.items.find((x) => x.id === req.body?.item);
      if (!it) throw new HttpError(404, 'not_found');
      if (it.by !== req.user.id && a.creator_id !== req.user.id) throw new HttpError(403, 'forbidden');
      data.items = data.items.filter((x) => x !== it);
    } else if (op === 'clear_done') {
      if (a.creator_id !== req.user.id) throw new HttpError(403, 'forbidden');
      data.items = data.items.filter((x) => !x.done);
    } else throw new HttpError(400, 'invalid_input');
  } else {
    data.expenses ||= [];
    if (op === 'add') {
      if (data.expenses.length >= 300) throw new HttpError(400, 'too_many_items');
      const amount = Number(req.body?.amount);
      if (!Number.isInteger(amount) || amount < 1 || amount > 1e12) throw new HttpError(400, 'invalid_input');
      const payer = req.body?.payer == null ? req.user.id : Number(req.body.payer);
      if (!members.has(payer)) throw new HttpError(400, 'invalid_input');
      let split = req.body?.split;
      if (split === 'all' || split == null) split = [...members];
      if (!Array.isArray(split) || !split.length || split.some((u) => !members.has(Number(u)))) throw new HttpError(400, 'invalid_input');
      data.expenses.push({ id: rid(6), title: str(req.body?.title, 'title', { min: 1, max: 60 }), amount, payer, split: [...new Set(split.map(Number))], by: req.user.id, at: now() });
    } else if (op === 'remove') {
      const ex = data.expenses.find((x) => x.id === req.body?.item);
      if (!ex) throw new HttpError(404, 'not_found');
      if (ex.by !== req.user.id && a.creator_id !== req.user.id) throw new HttpError(403, 'forbidden');
      data.expenses = data.expenses.filter((x) => x !== ex);
    } else throw new HttpError(400, 'invalid_input');
  }
  save(a, data);
  res.json({ message: push(a) });
});
