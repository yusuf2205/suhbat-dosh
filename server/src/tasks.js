// Tasks made from chat messages: a card in the chat with a checkbox, an assignee and a due time, plus personal lists.
import express from 'express';
import { q } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { HttpError, int, now, rateLimit, str } from './util.js';
import { emit } from './realtime.js';
import { chatOut, getMessage, memberIds, membership, messageOut, requireMember } from './service.js';

let host = { postMessage: null };
export function wireTasks(h) { host = h; }
export const tasks = express.Router();

const push = (messageId) => {
  const m = getMessage(messageId);
  const out = messageOut(m);
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: out });
  return out;
};

/** One reminder for whoever has to do it (the assignee, else the author), at the due time. */
function syncReminder(k) {
  const ref = `task:${k.id}`;
  q.run('DELETE FROM scheduled WHERE ref = ?', ref);
  const who = k.assignee_id || k.creator_id;
  if (k.done || !k.due_at || k.due_at <= now() || !who) return;
  q.run("INSERT INTO scheduled (user_id, chat_id, kind, text, send_at, created_at, ref) VALUES (?,?,'reminder',?,?,?,?)",
    who, k.chat_id, `✅ ${k.title}`, k.due_at, now(), ref);
}

function dueOf(v) {
  if (v === undefined || v === null || v === '' || v === 0) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < now() - 60_000 || n > now() + 5 * 365 * 86400_000) throw new HttpError(400, 'invalid_time');
  return Math.round(n);
}

function assigneeOf(chatId, v) {
  if (v === undefined || v === null || v === '') return null;
  const id = Number(v);
  if (!Number.isInteger(id) || !membership(chatId, id)) throw new HttpError(400, 'invalid_input');
  return id;
}

tasks.post('/chats/:id/tasks', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type === 'channel' && me.role === 'member') throw new HttpError(403, 'channel_readonly');
  if (q.get('SELECT 1 AS x FROM secret_chats WHERE chat_id = ?', id)) throw new HttpError(403, 'secret_no_tasks');
  if (!rateLimit(`task:${req.user.id}`, 40, 60_000)) throw new HttpError(429, 'slow_down');
  const title = str(req.body?.title, 'title', { min: 1, max: 200 });
  const due = dueOf(req.body?.due_at);
  let assignee = assigneeOf(id, req.body?.assignee_id);
  // in a personal chat there is only one possible person
  if (chat.type === 'direct' && assignee === null && req.body?.assignee_id === 'me') assignee = req.user.id;
  const sourceId = int(req.body?.source_id, 'source_id', { optional: true }) ?? null;
  if (sourceId && !q.get('SELECT 1 AS x FROM messages WHERE id = ? AND chat_id = ?', sourceId, id)) throw new HttpError(404, 'not_found');
  const out = host.postMessage({ chat, user: req.user, text: title, kind: 'task', replyTo: sourceId });
  const r = q.run(
    'INSERT INTO tasks (message_id, chat_id, source_id, creator_id, assignee_id, title, due_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    out.message.id, id, sourceId, req.user.id, assignee, title, due, now(),
  );
  syncReminder(q.get('SELECT * FROM tasks WHERE id = ?', Number(r.lastInsertRowid)));
  res.status(201).json({ message: push(out.message.id) });
});

const load = (id) => {
  const k = q.get('SELECT * FROM tasks WHERE id = ?', id);
  if (!k) throw new HttpError(404, 'not_found');
  return k;
};

/** Who may change a task: its author, its assignee, any chat admin; a task nobody owns - any member. */
function canEdit(k, me, uid) {
  return k.creator_id === uid || k.assignee_id === uid || k.assignee_id === null || me.role !== 'member';
}

tasks.post('/tasks/:id/toggle', (req, res) => {
  const k = load(int(req.params.id, 'id'));
  const me = requireMember(k.chat_id, req.user.id);
  if (!canEdit(k, me, req.user.id)) throw new HttpError(403, 'forbidden');
  const done = req.body?.done === undefined ? !k.done : !!req.body.done;
  q.run('UPDATE tasks SET done = ?, done_at = ?, done_by = ? WHERE id = ?', done ? 1 : 0, done ? now() : null, done ? req.user.id : null, k.id);
  syncReminder(load(k.id));
  res.json({ message: push(k.message_id) });
});

tasks.patch('/tasks/:id', (req, res) => {
  const k = load(int(req.params.id, 'id'));
  const me = requireMember(k.chat_id, req.user.id);
  if (!canEdit(k, me, req.user.id)) throw new HttpError(403, 'forbidden');
  const b = req.body || {};
  if (b.title !== undefined) {
    const title = str(b.title, 'title', { min: 1, max: 200 });
    q.run('UPDATE tasks SET title = ? WHERE id = ?', title, k.id);
    q.run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', title, now(), k.message_id);
  }
  if (b.due_at !== undefined) q.run('UPDATE tasks SET due_at = ? WHERE id = ?', dueOf(b.due_at), k.id);
  if (b.assignee_id !== undefined) q.run('UPDATE tasks SET assignee_id = ? WHERE id = ?', assigneeOf(k.chat_id, b.assignee_id), k.id);
  syncReminder(load(k.id));
  res.json({ message: push(k.message_id) });
});

/** My lists: `mine` (assigned to me, open), `given` (I assigned to somebody else, open), `free` (nobody's, in my chats), `done`. */
tasks.get('/tasks', (req, res) => {
  const uid = req.user.id;
  const scope = ['mine', 'given', 'free', 'done'].includes(req.query.scope) ? req.query.scope : 'mine';
  const where = {
    mine: 'k.done = 0 AND k.assignee_id = ?',
    given: 'k.done = 0 AND k.creator_id = ? AND k.assignee_id IS NOT NULL AND k.assignee_id != k.creator_id',
    free: 'k.done = 0 AND k.assignee_id IS NULL AND ? > 0',
    done: 'k.done = 1 AND (k.assignee_id = ? OR k.creator_id = ?)',
  }[scope];
  const args = scope === 'done' ? [uid, uid, uid] : [uid, uid];
  const rows = q.all(
    `SELECT k.* FROM tasks k JOIN members mb ON mb.chat_id = k.chat_id AND mb.user_id = ? AND mb.banned = 0
     WHERE ${where} ORDER BY k.done_at DESC, (k.due_at IS NULL), k.due_at, k.id DESC LIMIT 200`,
    ...args,
  );
  res.json({
    tasks: rows.map((k) => {
      const chat = chatOut(k.chat_id, uid);
      return {
        id: k.id, message_id: k.message_id, chat_id: k.chat_id, chat_title: chat?.title || chat?.peer?.name || '', title: k.title,
        due_at: k.due_at, done: !!k.done, creator_id: k.creator_id, assignee_id: k.assignee_id, done_at: k.done_at,
      };
    }),
  });
});

/** Counters for the badge in the sidebar. */
tasks.get('/tasks/count', (req, res) => {
  const n = q.get(
    `SELECT COUNT(*) AS n FROM tasks k JOIN members mb ON mb.chat_id = k.chat_id AND mb.user_id = ? AND mb.banned = 0
     WHERE k.done = 0 AND k.assignee_id = ?`, req.user.id, req.user.id).n;
  const overdue = q.get(
    `SELECT COUNT(*) AS n FROM tasks k JOIN members mb ON mb.chat_id = k.chat_id AND mb.user_id = ? AND mb.banned = 0
     WHERE k.done = 0 AND k.assignee_id = ? AND k.due_at IS NOT NULL AND k.due_at < ?`, req.user.id, req.user.id, now()).n;
  res.json({ open: n, overdue });
});
