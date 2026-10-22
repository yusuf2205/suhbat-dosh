// Topics in groups ("forum" mode) and comments under the posts of a channel.
import express from 'express';
import { q } from './db.js';
import { EVENTS, LIMITS } from '../../shared/contracts.js';
import { HttpError, int, now, rateLimit, str } from './util.js';
import { emit } from './realtime.js';
import {
  audit, chatOut, getMessage, isAdmin, memberIds, messageOut, requireMember,
} from './service.js';

export const forum = express.Router();
let host = { postMessage: null, pushChat: null };
export function wireForum(h) { host = h; }

const announce = (chatId) => emit(memberIds(chatId), { type: 'topics.update', chat_id: chatId });

function adminChat(req) {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  return { id, me, chat };
}

// ------------------------------------------------------------------ topics
/** Topics on or off for a group (the owner). Everything said so far stays in "General". */
forum.post('/chats/:id/forum', (req, res) => {
  const { id, me, chat } = adminChat(req);
  if (chat.type !== 'group' || me.role !== 'owner') throw new HttpError(403, 'forbidden');
  if (chat.e2e || chat.imported_from) throw new HttpError(400, 'not_for_encrypted');
  const on = req.body?.on === true;
  if (on && !chat.forum) {
    // each person's reading position becomes the position in General, so nothing old shows up as unread
    for (const m of q.all('SELECT user_id, last_read_id FROM members WHERE chat_id = ?', id)) {
      q.run('INSERT OR REPLACE INTO topic_reads (chat_id, user_id, topic_id, last_read_id) VALUES (?,?,0,?)', id, m.user_id, m.last_read_id);
    }
  }
  q.run('UPDATE chats SET forum = ? WHERE id = ?', on ? 1 : 0, id);
  audit(req.user.id, 'chat.forum', { chat_id: id, target_type: 'chat', target_id: id, details: { on } });
  host.pushChat?.(id);
  announce(id);
  res.json({ chat: chatOut(id, req.user.id) });
});

const topicOut = (t, uid) => {
  const unread = q.get(
    `SELECT COUNT(*) AS n FROM messages x LEFT JOIN topic_reads tr ON tr.chat_id = x.chat_id AND tr.user_id = ? AND tr.topic_id = ?
     WHERE x.chat_id = ? AND COALESCE(x.topic_id, 0) = ? AND x.thread_of IS NULL AND x.id > COALESCE(tr.last_read_id, 0) AND (x.sender_id IS NULL OR x.sender_id != ?)`,
    uid, t.id, t.chat_id, t.id, uid,
  ).n;
  const last = q.get('SELECT * FROM messages WHERE chat_id = ? AND COALESCE(topic_id, 0) = ? AND thread_of IS NULL ORDER BY id DESC LIMIT 1', t.chat_id, t.id);
  return {
    id: t.id, title: t.title, emoji: t.emoji, closed: !!t.closed, unread,
    last: last ? { id: last.id, text: last.kind === 'text' ? last.text.slice(0, 80) : '', kind: last.kind, at: last.created_at, sender_id: last.sender_id } : null,
  };
};

forum.get('/chats/:id/topics', (req, res) => {
  const { id, chat } = adminChat(req);
  if (!chat.forum) throw new HttpError(404, 'not_found');
  const topics = q.all('SELECT * FROM topics WHERE chat_id = ? ORDER BY id', id);
  res.json({ topics: [topicOut({ id: 0, chat_id: id, title: '', emoji: '', closed: 0 }, req.user.id), ...topics.map((t) => topicOut(t, req.user.id))] });
});

forum.post('/chats/:id/topics', (req, res) => {
  const { id, me, chat } = adminChat(req);
  if (!chat.forum) throw new HttpError(404, 'not_found');
  if (!isAdmin(me)) throw new HttpError(403, 'forbidden');
  if (!rateLimit(`topic:${req.user.id}`, 30, 3600_000)) throw new HttpError(429, 'slow_down');
  if (q.get('SELECT COUNT(*) AS n FROM topics WHERE chat_id = ?', id).n >= 100) throw new HttpError(400, 'too_many_items');
  const title = str(req.body?.title, 'title', { min: 1, max: 40 });
  const emoji = str(String(req.body?.emoji ?? ''), 'emoji', { max: 8 });
  const r = q.run('INSERT INTO topics (chat_id, title, emoji, created_by, created_at) VALUES (?,?,?,?,?)', id, title, emoji, req.user.id, now());
  audit(req.user.id, 'topic.create', { chat_id: id, target_type: 'chat', target_id: id, details: { title } });
  announce(id);
  res.status(201).json({ topic: topicOut(q.get('SELECT * FROM topics WHERE id = ?', Number(r.lastInsertRowid)), req.user.id) });
});

forum.patch('/topics/:tid', (req, res) => {
  const t = q.get('SELECT * FROM topics WHERE id = ?', int(req.params.tid, 'tid'));
  if (!t) throw new HttpError(404, 'not_found');
  const me = requireMember(t.chat_id, req.user.id);
  if (!isAdmin(me) && t.created_by !== req.user.id) throw new HttpError(403, 'forbidden');
  const b = req.body || {};
  if (b.title !== undefined) q.run('UPDATE topics SET title = ? WHERE id = ?', str(b.title, 'title', { min: 1, max: 40 }), t.id);
  if (b.emoji !== undefined) q.run('UPDATE topics SET emoji = ? WHERE id = ?', str(String(b.emoji), 'emoji', { max: 8 }), t.id);
  if (b.closed !== undefined) q.run('UPDATE topics SET closed = ? WHERE id = ?', b.closed ? 1 : 0, t.id);
  announce(t.chat_id);
  res.json({ topic: topicOut(q.get('SELECT * FROM topics WHERE id = ?', t.id), req.user.id) });
});

/** Reading position inside one topic (the normal chat-wide route handles every other chat). */
forum.post('/chats/:id/read-topic', (req, res) => {
  const { id, chat } = adminChat(req);
  if (!chat.forum) throw new HttpError(404, 'not_found');
  const topic = int(req.body?.topic, 'topic', { min: 0 });
  const upTo = Math.min(int(req.body?.message_id, 'message_id', { min: 0 }), chat.last_message_id ?? 0);
  q.run(
    `INSERT INTO topic_reads (chat_id, user_id, topic_id, last_read_id) VALUES (?,?,?,?)
     ON CONFLICT(chat_id, user_id, topic_id) DO UPDATE SET last_read_id = MAX(last_read_id, excluded.last_read_id)`, id, req.user.id, topic, upTo,
  );
  q.run('UPDATE members SET last_delivered_id = MAX(last_delivered_id, ?) WHERE chat_id = ? AND user_id = ?', upTo, id, req.user.id);
  emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat: chatOut(id, req.user.id) });
  res.json({ ok: true });
});

// ------------------------------------------------------------------ comments under channel posts
forum.post('/chats/:id/comments-on', (req, res) => {
  const { id, me, chat } = adminChat(req);
  if (chat.type !== 'channel' || me.role !== 'owner') throw new HttpError(403, 'forbidden');
  q.run('UPDATE chats SET comments = ? WHERE id = ?', req.body?.on === true ? 1 : 0, id);
  audit(req.user.id, 'chat.comments', { chat_id: id, target_type: 'chat', target_id: id, details: { on: req.body?.on === true } });
  host.pushChat?.(id);
  res.json({ chat: chatOut(id, req.user.id) });
});

function postOf(req) {
  const post = getMessage(int(req.params.id, 'id'));
  if (!post || post.thread_of) throw new HttpError(404, 'not_found');
  requireMember(post.chat_id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', post.chat_id);
  if (chat.type !== 'channel' || !chat.comments) throw new HttpError(404, 'not_found');
  return { post, chat };
}

forum.get('/messages/:id/comments', (req, res) => {
  const { post } = postOf(req);
  const limit = int(req.query.limit, 'limit', { min: 1, max: 100, optional: true }) ?? 50;
  const before = int(req.query.before, 'before', { optional: true });
  const rows = q.all('SELECT * FROM messages WHERE thread_of = ? AND id < ? ORDER BY id DESC LIMIT ?', post.id, before ?? Number.MAX_SAFE_INTEGER, limit + 1);
  res.json({ comments: rows.slice(0, limit).reverse().map(messageOut), has_more: rows.length > limit });
});

forum.post('/messages/:id/comments', (req, res) => {
  const { post, chat } = postOf(req);
  const me = requireMember(chat.id, req.user.id);
  if (me.role === 'member' && !me.can_send) throw new HttpError(403, 'restricted');
  if (!rateLimit(`comment:${req.user.id}`, 20, 60_000)) throw new HttpError(429, 'slow_down');
  const text = str(req.body?.text, 'text', { min: 1, max: LIMITS.TEXT_MAX });
  const clientId = req.body?.client_id !== undefined ? str(req.body.client_id, 'client_id', { min: 8, max: 64 }) : null;
  const replyTo = int(req.body?.reply_to, 'reply_to', { optional: true }) ?? null;
  const reply = replyTo && q.get('SELECT 1 AS x FROM messages WHERE id = ? AND thread_of = ?', replyTo, post.id) ? replyTo : null;
  const out = host.postMessage({ chat, user: req.user, text, kind: 'text', clientId, replyTo: reply, threadOf: post.id });
  res.status(out.duplicate ? 200 : 201).json({ comment: out.message });
});
