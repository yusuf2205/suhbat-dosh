// Search over the messages a person can see: text, the speech-to-text of voice messages and the names of files.
// Words of three letters or more go through the FTS5 trigram index (any part of a word, any letter case, Cyrillic too);
// shorter words are matched with LIKE on the rows the index already narrowed down.
import { db } from './db.js';
import { escapeLike } from './util.js';

const phrase = (w) => `"${w.replace(/"/g, '""')}"`;

/**
 * @param {number} userId
 * @param {{term?: string, chatId?: number, from?: number, type?: string, since?: number, until?: number, chatType?: string, before?: number, limit?: number}} o
 * @returns {object[]} message rows (newest first), each with chat_type and chat_title
 */
export function searchMessages(userId, o = {}) {
  const words = String(o.term || '').toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  const long = words.filter((w) => [...w].length >= 3);
  const short = words.filter((w) => [...w].length < 3);
  const where = ['m.id > MAX(mb.cleared_before, 0)', 'c.e2e = 0'];
  const params = [userId];
  if (long.length) { where.push('m.id IN (SELECT rowid FROM msg_fts WHERE msg_fts MATCH ?)'); params.push(long.map(phrase).join(' AND ')); }
  for (const w of short) { where.push("lc(m.text) LIKE ? ESCAPE '\\'"); params.push(`%${escapeLike(w)}%`); }
  if (o.chatId !== undefined) { where.push('m.chat_id = ?'); params.push(o.chatId); }
  if (o.from) { where.push('m.sender_id = ?'); params.push(o.from); }
  if (o.since !== undefined) { where.push('m.created_at >= ?'); params.push(o.since); }
  if (o.until !== undefined) { where.push('m.created_at <= ?'); params.push(o.until); }
  if (o.chatType) { where.push('c.type = ?'); params.push(o.chatType); }
  if (o.before) { where.push('m.id < ?'); params.push(o.before); }
  if (o.type === 'link') where.push("m.kind = 'text' AND (m.text LIKE '%http://%' OR m.text LIKE '%https://%')");
  else if (o.type === 'text') where.push("m.kind = 'text'");
  else if (o.type) { where.push('m.kind = ?'); params.push(o.type); }
  params.push(Math.min(o.limit || 40, 100));
  return db.prepare(
    `SELECT m.*, c.type AS chat_type, c.title AS chat_title FROM messages m
     JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0
     JOIN chats c ON c.id = m.chat_id
     WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
  ).all(...params);
}
