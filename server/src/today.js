// "Сводка дня": not a retelling of the chats but a short list of things to do: who waits for an answer, what is due, what to confirm, what is on today.
import express from 'express';
import { q } from './db.js';
import { now } from './util.js';

export const today = express.Router();

const DAY = 86400_000;
const clip = (s, n) => String(s || '').replace(/\s+/g, ' ').slice(0, n);

export function todayFor(uid) {
  const t = now();
  // people waiting for my answer: the last message of a personal chat is theirs, not older than two weeks
  const waiting = q.all(
    `SELECT c.id AS chat_id, m.id AS message_id, m.created_at AS at, m.kind, m.text
     FROM members mem JOIN chats c ON c.id = mem.chat_id JOIN messages m ON m.id = c.last_message_id
     WHERE mem.user_id = ? AND mem.banned = 0 AND mem.hidden = 0 AND (c.type = 'direct' OR c.imported_from = 'tgbridge')
       AND (m.sender_id IS NULL OR m.sender_id != ?) AND m.kind NOT IN ('call', 'secret') AND m.created_at > ? AND m.tg_deleted = 0
       AND NOT EXISTS (SELECT 1 FROM members m2 JOIN users u ON u.id = m2.user_id WHERE m2.chat_id = c.id AND m2.user_id != ? AND u.is_bot = 1)
     ORDER BY m.created_at ASC LIMIT 15`, uid, uid, t - 14 * DAY, uid,
  ).map((r) => ({ chat_id: r.chat_id, message_id: r.message_id, at: r.at, kind: r.kind, text: clip(r.text, 90) }));

  const tasks = q.all(
    `SELECT k.id, k.chat_id, k.message_id, k.title, k.due_at FROM tasks k JOIN members mem ON mem.chat_id = k.chat_id AND mem.user_id = ? AND mem.banned = 0
     WHERE k.done = 0 AND (k.assignee_id = ? OR (k.assignee_id IS NULL AND k.creator_id = ?)) AND k.due_at IS NOT NULL AND k.due_at < ?
     ORDER BY k.due_at LIMIT 15`, uid, uid, uid, t + 3 * DAY,
  );

  const deals = q.all(
    `SELECT d.id, d.chat_id, d.message_id, d.title, d.due_at FROM deals d JOIN members mem ON mem.chat_id = d.chat_id AND mem.user_id = ? AND mem.banned = 0
     WHERE d.done = 0 AND (d.owner_id = ? OR (d.owner_id IS NULL AND d.creator_id = ?)) AND (d.due_at IS NULL OR d.due_at < ?)
     ORDER BY d.due_at IS NULL, d.due_at LIMIT 15`, uid, uid, uid, t + 3 * DAY,
  );

  // cards that others made and I have not answered
  const confirm = q.all(
    `SELECT d.id, d.chat_id, d.message_id, d.title, d.due_at FROM deals d JOIN members mem ON mem.chat_id = d.chat_id AND mem.user_id = ? AND mem.banned = 0
     WHERE d.done = 0 AND d.creator_id != ? AND NOT EXISTS (SELECT 1 FROM deal_ok o WHERE o.deal_id = d.id AND o.user_id = ?)
     ORDER BY d.created_at DESC LIMIT 10`, uid, uid, uid,
  );

  const events = q.all(
    `SELECT e.id, e.chat_id, e.message_id, e.title, e.start_at FROM events e JOIN members mem ON mem.chat_id = e.chat_id AND mem.user_id = ? AND mem.banned = 0
     LEFT JOIN event_rsvp r ON r.event_id = e.id AND r.user_id = ?
     WHERE e.canceled = 0 AND e.start_at BETWEEN ? AND ? AND COALESCE(r.status, '') != 'no' ORDER BY e.start_at LIMIT 10`, uid, uid, t, t + 36 * 3600_000,
  );

  const count = waiting.length + tasks.length + deals.length + confirm.length + events.length;
  return { waiting, tasks, deals, confirm, events, count, at: t };
}

today.get('/today', (req, res) => res.json(todayFor(req.user.id)));
