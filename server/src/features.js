// User-facing extras: chat folders, scheduled messages & reminders, polls, global search, data export.
import express from 'express';
import { config } from './config.js';
import { db, q, tx } from './db.js';
import { EVENTS, LIMITS } from '../../shared/contracts.js';
import {
  HttpError, escapeLike, int, log, now, rateLimit, str,
} from './util.js';
import { emit, isOnline } from './realtime.js';
import {
  chatOut, directPeerId, eventOut, getMessage, getUser, memberIds, membership, messageOut, publicUser, requireMember,
} from './service.js';
import { serviceMessage } from './notify.js';
import { searchMessages } from './search.js';

let host = { postMessage: null };
export function wireFeatures(h) { host = h; }

export const features = express.Router();

// ------------------------------------------------------------------ folders
const RULE_INCLUDE = ['direct', 'groups', 'channels', 'bots', 'telegram'];
const RULE_EXCLUDE = ['muted', 'read', 'archived'];
function cleanRules(v) {
  if (v === undefined || v === null || v === '') return '';
  const o = typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v;
  if (!o || typeof o !== 'object') throw new HttpError(400, 'invalid_input');
  const include = [...new Set((Array.isArray(o.include) ? o.include : []).filter((x) => RULE_INCLUDE.includes(x)))];
  const exclude = [...new Set((Array.isArray(o.exclude) ? o.exclude : []).filter((x) => RULE_EXCLUDE.includes(x)))];
  return include.length || exclude.length ? JSON.stringify({ include, exclude }) : '';
}
const rulesOf = (f) => { try { return f.rules ? JSON.parse(f.rules) : null; } catch { return null; } };
const folderOut = (f) => ({
  id: f.id, name: f.name, emoji: f.emoji, position: f.position, rules: rulesOf(f),
  chat_ids: q.all('SELECT chat_id FROM folder_chats WHERE folder_id = ?', f.id).map((r) => r.chat_id),
});
const foldersOf = (uid) => q.all('SELECT * FROM folders WHERE user_id = ? ORDER BY position, id', uid).map(folderOut);
const pushFolders = (uid) => emit([uid], { type: 'folders.update', folders: foldersOf(uid) });

function cleanChatIds(uid, ids) {
  if (!Array.isArray(ids)) return [];
  const out = [];
  for (const raw of ids.slice(0, 500)) {
    const id = Number(raw);
    if (Number.isInteger(id) && membership(id, uid)) out.push(id);
  }
  return [...new Set(out)];
}

features.get('/folders', (req, res) => res.json({ folders: foldersOf(req.user.id) }));

features.post('/folders', (req, res) => {
  if (q.get('SELECT COUNT(*) AS n FROM folders WHERE user_id = ?', req.user.id).n >= 20) throw new HttpError(400, 'too_many_folders');
  const name = str(req.body?.name, 'name', { min: 1, max: 24 });
  const emoji = str(String(req.body?.emoji ?? ''), 'emoji', { max: 8 });
  const ids = cleanChatIds(req.user.id, req.body?.chat_ids);
  const rules = cleanRules(req.body?.rules);
  const pos = q.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM folders WHERE user_id = ?', req.user.id).n;
  const r = q.run('INSERT INTO folders (user_id, name, emoji, position, rules, created_at) VALUES (?,?,?,?,?,?)', req.user.id, name, emoji, pos, rules, now());
  const fid = Number(r.lastInsertRowid);
  for (const c of ids) q.run('INSERT OR IGNORE INTO folder_chats (folder_id, chat_id) VALUES (?,?)', fid, c);
  pushFolders(req.user.id);
  res.status(201).json({ folders: foldersOf(req.user.id) });
});

/** The order of the tabs: { ids: [folder ids, first to last] }. */
features.put('/folders/order', (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 40) : [];
  tx(() => ids.forEach((id, i) => q.run('UPDATE folders SET position = ? WHERE id = ? AND user_id = ?', i + 1, id, req.user.id)));
  pushFolders(req.user.id);
  res.json({ folders: foldersOf(req.user.id) });
});

features.patch('/folders/:id', (req, res) => {
  const f = q.get('SELECT * FROM folders WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!f) throw new HttpError(404, 'not_found');
  const b = req.body || {};
  if (b.name !== undefined) q.run('UPDATE folders SET name = ? WHERE id = ?', str(b.name, 'name', { min: 1, max: 24 }), f.id);
  if (b.emoji !== undefined) q.run('UPDATE folders SET emoji = ? WHERE id = ?', str(String(b.emoji), 'emoji', { max: 8 }), f.id);
  if (b.rules !== undefined) q.run('UPDATE folders SET rules = ? WHERE id = ?', cleanRules(b.rules), f.id);
  if (b.chat_ids !== undefined) {
    const ids = cleanChatIds(req.user.id, b.chat_ids);
    tx(() => {
      q.run('DELETE FROM folder_chats WHERE folder_id = ?', f.id);
      for (const c of ids) q.run('INSERT OR IGNORE INTO folder_chats (folder_id, chat_id) VALUES (?,?)', f.id, c);
    });
  }
  pushFolders(req.user.id);
  res.json({ folders: foldersOf(req.user.id) });
});

features.delete('/folders/:id', (req, res) => {
  q.run('DELETE FROM folders WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  pushFolders(req.user.id);
  res.json({ folders: foldersOf(req.user.id) });
});

// ------------------------------------------------------------------ pinned chats
features.post('/chats/:id/pin-chat', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const on = req.body?.pinned !== false;
  if (on && q.get('SELECT COUNT(*) AS n FROM members WHERE user_id = ? AND pinned_at IS NOT NULL', req.user.id).n >= 10) {
    throw new HttpError(400, 'too_many_pins');
  }
  q.run('UPDATE members SET pinned_at = ? WHERE chat_id = ? AND user_id = ?', on ? now() : null, id, req.user.id);
  const chat = chatOut(id, req.user.id);
  emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat });
  res.json({ chat });
});

features.post('/chats/:id/sound', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const v = req.body?.sound;
  const sound = v === null || v === 'default' ? null : ['none', 'chime', 'pop', 'bell'].includes(v) ? v : undefined;
  if (sound === undefined) throw new HttpError(400, 'invalid_input');
  q.run('UPDATE members SET sound = ? WHERE chat_id = ? AND user_id = ?', sound, id, req.user.id);
  const chat = chatOut(id, req.user.id);
  emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat });
  res.json({ chat });
});

// ------------------------------------------------------------------ scheduled messages and reminders
const schedOut = (s) => ({ id: s.id, kind: s.kind, chat_id: s.chat_id, text: s.text, reply_to: s.reply_to, send_at: s.send_at, created_at: s.created_at, silent: !!s.silent, when_online: !!s.when_online });
const scheduledOf = (uid) => q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at', uid).map(schedOut);
const MAX_AHEAD = 366 * 86400_000;

function parseWhen(v) {
  const at = Number(v);
  if (!Number.isFinite(at) || at < now() + 5_000 || at > now() + MAX_AHEAD) throw new HttpError(400, 'invalid_time');
  return Math.round(at);
}

features.get('/scheduled', (req, res) => {
  res.json({ scheduled: q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at LIMIT 200', req.user.id).map(schedOut) });
});

features.post('/chats/:id/schedule', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  if (q.get('SELECT COUNT(*) AS n FROM scheduled WHERE user_id = ?', req.user.id).n >= 100) throw new HttpError(400, 'too_many_scheduled');
  const text = str(req.body?.text, 'text', { min: 1, max: LIMITS.TEXT_MAX });
  const at = parseWhen(req.body?.send_at);
  const reply = int(req.body?.reply_to, 'reply_to', { optional: true }) ?? null;
  const silent = req.body?.silent === true ? 1 : 0;
  const whenOnline = req.body?.when_online === true && q.get('SELECT type FROM chats WHERE id = ?', id)?.type === 'direct' ? 1 : 0;
  q.run("INSERT INTO scheduled (user_id, chat_id, kind, text, reply_to, send_at, silent, when_online, created_at) VALUES (?,?,'message',?,?,?,?,?,?)", req.user.id, id, text, reply, at, silent, whenOnline, now());
  res.status(201).json({ scheduled: q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at', req.user.id).map(schedOut) });
});

features.post('/reminders', (req, res) => {
  if (q.get('SELECT COUNT(*) AS n FROM scheduled WHERE user_id = ?', req.user.id).n >= 100) throw new HttpError(400, 'too_many_scheduled');
  const text = str(req.body?.text, 'text', { min: 1, max: 500 });
  const at = parseWhen(req.body?.send_at);
  const chat = int(req.body?.chat_id, 'chat_id', { optional: true });
  if (chat !== undefined) requireMember(chat, req.user.id);
  q.run("INSERT INTO scheduled (user_id, chat_id, kind, text, send_at, created_at) VALUES (?,?,'reminder',?,?,?)", req.user.id, chat ?? null, text, at, now());
  res.status(201).json({ scheduled: q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at', req.user.id).map(schedOut) });
});

/** Change the text, the time or the flags of a message that has not been sent yet. */
features.patch('/scheduled/:id', (req, res) => {
  const s = q.get('SELECT * FROM scheduled WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!s) throw new HttpError(404, 'not_found');
  const b = req.body || {};
  if (b.text !== undefined) q.run('UPDATE scheduled SET text = ? WHERE id = ?', str(b.text, 'text', { min: 1, max: s.kind === 'reminder' ? 500 : LIMITS.TEXT_MAX }), s.id);
  if (b.send_at !== undefined) q.run('UPDATE scheduled SET send_at = ? WHERE id = ?', parseWhen(b.send_at), s.id);
  if (s.kind === 'message') {
    if (b.silent !== undefined) q.run('UPDATE scheduled SET silent = ? WHERE id = ?', b.silent ? 1 : 0, s.id);
    if (b.when_online !== undefined) q.run('UPDATE scheduled SET when_online = ? WHERE id = ?', b.when_online && q.get('SELECT type FROM chats WHERE id = ?', s.chat_id)?.type === 'direct' ? 1 : 0, s.id);
  }
  res.json({ scheduled: scheduledOf(req.user.id) });
});

features.delete('/scheduled/:id', (req, res) => {
  q.run('DELETE FROM scheduled WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  res.json({ scheduled: q.all('SELECT * FROM scheduled WHERE user_id = ? ORDER BY send_at', req.user.id).map(schedOut) });
});

function runDue() {
  const due = q.all('SELECT * FROM scheduled WHERE send_at <= ? ORDER BY send_at LIMIT 50', now());
  for (const s of due) {
    // "when they are online": wait for the other person (but not longer than a day past the chosen time)
    if (s.when_online && s.kind === 'message' && s.send_at + 86400_000 > now()) {
      const peer = directPeerId(s.chat_id, s.user_id);
      if (peer && peer !== s.user_id && !isOnline(peer)) continue;
    }
    q.run('DELETE FROM scheduled WHERE id = ?', s.id);
    try {
      const user = getUser(s.user_id);
      if (!user || user.banned_at) continue;
      if (s.kind === 'reminder') {
        serviceMessage(s.user_id, `⏰ Напоминание: ${s.text}`);
      } else if (membership(s.chat_id, s.user_id)) {
        const chat = q.get('SELECT * FROM chats WHERE id = ?', s.chat_id);
        const replyTo = s.reply_to && q.get('SELECT 1 AS x FROM messages WHERE id = ? AND chat_id = ?', s.reply_to, s.chat_id) ? s.reply_to : null;
        host.postMessage({ chat, user, text: s.text, replyTo, silent: !!s.silent });
      }
    } catch (e) { log('error', 'scheduled send failed', { id: s.id, err: e.message }); }
  }
}
export function startScheduler() {
  setInterval(runDue, 10_000).unref();
}

// ------------------------------------------------------------------ polls
const pollMessageUpdate = (messageId) => {
  const m = getMessage(messageId);
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(m) });
  return messageOut(m);
};

features.post('/chats/:id/polls', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type === 'channel' && me.role === 'member') throw new HttpError(403, 'channel_readonly');
  if (!rateLimit(`poll:${req.user.id}`, 10, 60_000)) throw new HttpError(429, 'slow_down');
  const question = str(req.body?.question, 'question', { min: 1, max: 255 });
  const raw = Array.isArray(req.body?.options) ? req.body.options : [];
  const options = raw.map((o) => (typeof o === 'string' ? str(o, 'option', { max: 100 }) : '')).filter(Boolean);
  if (options.length < 2 || options.length > 10) throw new HttpError(400, 'invalid_input', 'options 2..10');
  const kind = ['poll', 'quiz', 'slots'].includes(req.body?.kind) ? req.body.kind : 'poll';
  let correct = null;
  let explanation = '';
  if (kind === 'quiz') {
    correct = Number(req.body?.correct);
    if (!Number.isInteger(correct) || correct < 0 || correct >= options.length) throw new HttpError(400, 'invalid_input', 'correct');
    explanation = str(req.body?.explanation || '', 'explanation', { max: 200 });
  }
  const multiple = kind === 'slots' ? 1 : kind === 'quiz' ? 0 : (req.body?.multiple ? 1 : 0);
  const out = host.postMessage({ chat, user: req.user, text: question, kind: 'poll' });
  q.run('INSERT INTO polls (message_id, question, options, multiple, kind, correct, explanation) VALUES (?,?,?,?,?,?,?)',
    out.message.id, question, JSON.stringify(options), multiple, kind, correct, explanation);
  res.status(201).json({ message: pollMessageUpdate(out.message.id) });
});

features.post('/polls/:id/vote', (req, res) => {
  const p = q.get('SELECT * FROM polls WHERE id = ?', int(req.params.id, 'id'));
  if (!p) throw new HttpError(404, 'not_found');
  const m = getMessage(p.message_id);
  requireMember(m.chat_id, req.user.id);
  if (p.closed) throw new HttpError(400, 'poll_closed');
  const n = JSON.parse(p.options).length;
  const picks = [...new Set((Array.isArray(req.body?.options) ? req.body.options : []).map(Number))].filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  if (!p.multiple && picks.length > 1) throw new HttpError(400, 'invalid_input');
  if (p.kind === 'quiz' && q.get('SELECT 1 AS x FROM poll_votes WHERE poll_id = ? AND user_id = ?', p.id, req.user.id)) throw new HttpError(400, 'already_voted'); // one try per person
  tx(() => {
    q.run('DELETE FROM poll_votes WHERE poll_id = ? AND user_id = ?', p.id, req.user.id);
    for (const i of picks) q.run('INSERT INTO poll_votes (poll_id, user_id, option) VALUES (?,?,?)', p.id, req.user.id, i);
  });
  res.json({ message: pollMessageUpdate(p.message_id) });
});

// A quiz tells its right answer only to people who have answered (or to everybody once it is closed).
features.get('/polls/:id/result', (req, res) => {
  const p = q.get('SELECT * FROM polls WHERE id = ?', int(req.params.id, 'id'));
  if (!p) throw new HttpError(404, 'not_found');
  const m = getMessage(p.message_id);
  requireMember(m.chat_id, req.user.id);
  const voted = !!q.get('SELECT 1 AS x FROM poll_votes WHERE poll_id = ? AND user_id = ?', p.id, req.user.id);
  if (p.kind !== 'quiz' || !(voted || p.closed || m.sender_id === req.user.id)) return res.json({ correct: null });
  return res.json({ correct: p.correct, explanation: p.explanation });
});

features.post('/polls/:id/close', (req, res) => {
  const p = q.get('SELECT * FROM polls WHERE id = ?', int(req.params.id, 'id'));
  if (!p) throw new HttpError(404, 'not_found');
  const m = getMessage(p.message_id);
  requireMember(m.chat_id, req.user.id);
  if (m.sender_id !== req.user.id) throw new HttpError(403, 'forbidden');
  q.run('UPDATE polls SET closed = 1 WHERE id = ?', p.id);
  res.json({ message: pollMessageUpdate(p.message_id) });
});

// ------------------------------------------------------------------ meetings / calendar
const eventMessageUpdate = (messageId) => {
  const m = getMessage(messageId);
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(m) });
  return messageOut(m);
};

/** Reminders for people who said "yes" or "maybe": 15 minutes before the start. */
function syncReminder(ev, userId) {
  const ref = `event:${ev.id}:${userId}`;
  q.run('DELETE FROM scheduled WHERE ref = ?', ref);
  const r = q.get('SELECT status FROM event_rsvp WHERE event_id = ? AND user_id = ?', ev.id, userId);
  const at = ev.start_at - 15 * 60_000;
  if (ev.canceled || !r || r.status === 'no' || at <= now()) return;
  q.run("INSERT INTO scheduled (user_id, chat_id, kind, text, send_at, created_at, ref) VALUES (?,?,'reminder',?,?,?,?)",
    userId, ev.chat_id, `${ev.title} \u2014 ${ev.meeting ? 'встреча' : 'событие'} через 15 минут`, at, now(), ref);
}

features.post('/chats/:id/events', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type === 'channel' && me.role === 'member') throw new HttpError(403, 'channel_readonly');
  if (!rateLimit(`event:${req.user.id}`, 20, 60_000)) throw new HttpError(429, 'slow_down');
  const title = str(req.body?.title, 'title', { min: 1, max: 120 });
  const description = str(req.body?.description || '', 'description', { max: 500 });
  const location = str(req.body?.location || '', 'location', { max: 120 });
  const start = Number(req.body?.start_at);
  if (!Number.isFinite(start) || start < now() - 60_000 || start > now() + 3 * 365 * 86400_000) throw new HttpError(400, 'invalid_time');
  const minutes = Number(req.body?.duration_min ?? 60);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 24 * 60) throw new HttpError(400, 'invalid_input');
  const out = host.postMessage({ chat, user: req.user, text: title, kind: 'event' });
  const r = q.run(
    'INSERT INTO events (message_id, chat_id, creator_id, title, description, location, start_at, end_at, meeting, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    out.message.id, id, req.user.id, title, description, location, Math.round(start), Math.round(start) + minutes * 60_000, req.body?.meeting ? 1 : 0, now(),
  );
  const ev = q.get('SELECT * FROM events WHERE id = ?', Number(r.lastInsertRowid));
  q.run("INSERT INTO event_rsvp (event_id, user_id, status) VALUES (?,?,'yes')", ev.id, req.user.id);
  syncReminder(ev, req.user.id);
  res.status(201).json({ message: eventMessageUpdate(out.message.id) });
});

features.post('/events/:id/rsvp', (req, res) => {
  const ev = q.get('SELECT * FROM events WHERE id = ?', int(req.params.id, 'id'));
  if (!ev) throw new HttpError(404, 'not_found');
  requireMember(ev.chat_id, req.user.id);
  if (ev.canceled) throw new HttpError(400, 'event_canceled');
  const status = req.body?.status;
  if (status === null) q.run('DELETE FROM event_rsvp WHERE event_id = ? AND user_id = ?', ev.id, req.user.id);
  else if (['yes', 'maybe', 'no'].includes(status)) {
    q.run('INSERT INTO event_rsvp (event_id, user_id, status) VALUES (?,?,?) ON CONFLICT(event_id, user_id) DO UPDATE SET status = excluded.status', ev.id, req.user.id, status);
  } else throw new HttpError(400, 'invalid_input');
  syncReminder(ev, req.user.id);
  res.json({ message: eventMessageUpdate(ev.message_id) });
});

features.post('/events/:id/cancel', (req, res) => {
  const ev = q.get('SELECT * FROM events WHERE id = ?', int(req.params.id, 'id'));
  if (!ev) throw new HttpError(404, 'not_found');
  const me = requireMember(ev.chat_id, req.user.id);
  if (ev.creator_id !== req.user.id && me.role === 'member') throw new HttpError(403, 'forbidden');
  q.run('UPDATE events SET canceled = 1 WHERE id = ?', ev.id);
  q.run("DELETE FROM scheduled WHERE ref LIKE ?", `event:${ev.id}:%`);
  res.json({ message: eventMessageUpdate(ev.message_id) });
});

// upcoming events from every chat of the user (the calendar)
features.get('/events/upcoming', (req, res) => {
  const rows = q.all(
    `SELECT e.*, m.id AS mid FROM events e JOIN members mb ON mb.chat_id = e.chat_id AND mb.user_id = ? AND mb.banned = 0
     JOIN messages m ON m.id = e.message_id
     WHERE e.end_at >= ? AND e.canceled = 0 ORDER BY e.start_at LIMIT 100`, req.user.id, now() - 3600_000);
  res.json({ events: rows.map((e) => {
    const chat = chatOut(e.chat_id, req.user.id);
    const mine = q.get('SELECT status FROM event_rsvp WHERE event_id = ? AND user_id = ?', e.id, req.user.id);
    return {
      id: e.id, message_id: e.message_id, chat_id: e.chat_id, chat_title: chat?.title || chat?.peer?.name || '', title: e.title,
      location: e.location, start_at: e.start_at, end_at: e.end_at, meeting: !!e.meeting, mine: mine?.status || null,
    };
  }) });
});

// .ics file: opens in the phone / desktop calendar
features.get('/events/:id/ics', (req, res) => {
  const ev = q.get('SELECT * FROM events WHERE id = ?', int(req.params.id, 'id'));
  if (!ev) throw new HttpError(404, 'not_found');
  requireMember(ev.chat_id, req.user.id);
  const fmt = (ts) => new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const esc = (v) => String(v || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Suhbat-dosh//RU', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:event-${ev.id}@suhbat-dosh`, `DTSTAMP:${fmt(now())}`, `DTSTART:${fmt(ev.start_at)}`, `DTEND:${fmt(ev.end_at)}`,
    `SUMMARY:${esc(ev.title)}`, ev.description ? `DESCRIPTION:${esc(ev.description)}` : '', ev.location ? `LOCATION:${esc(ev.location)}` : '',
    ev.canceled ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'BEGIN:VALARM', 'TRIGGER:-PT15M', 'ACTION:DISPLAY', 'DESCRIPTION:Reminder', 'END:VALARM', 'END:VEVENT', 'END:VCALENDAR',
  ].filter(Boolean);
  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="event-${ev.id}.ics"`);
  res.send(lines.join('\r\n') + '\r\n');
});

// ------------------------------------------------------------------ search across every chat, with filters
features.get('/search/global', (req, res) => {
  if (!rateLimit(`gsearch:${req.user.id}`, 60, 60_000)) throw new HttpError(429, 'too_many_requests');
  const term = str(String(req.query.q ?? ''), 'q', { max: 100 });
  const from = int(req.query.from_user, 'from_user', { optional: true });
  const type = ['text', 'image', 'video', 'voice', 'audio', 'file', 'link', 'poll'].includes(req.query.type) ? req.query.type : null;
  const since = int(req.query.since, 'since', { min: 0, optional: true });
  const until = int(req.query.until, 'until', { min: 0, optional: true });
  const before = int(req.query.before, 'before', { min: 1, optional: true });
  const chatType = ['direct', 'group', 'channel'].includes(req.query.chat_type) ? req.query.chat_type : null;
  if (term.length < 2 && !from && !type && !since && !until) throw new HttpError(400, 'invalid_input', 'query too short');
  const rows = searchMessages(req.user.id, { term, from, type, since, until, before, chatType, limit: 60 });
  res.json({
    more: rows.length === 60,
    results: rows.map((r) => {
      let chatTitle = r.chat_title;
      if (r.chat_type === 'direct') {
        const peer = q.get('SELECT u.* FROM members mm JOIN users u ON u.id = mm.user_id WHERE mm.chat_id = ? AND mm.user_id != ?', r.chat_id, req.user.id)
          || getUser(req.user.id);
        chatTitle = peer?.name || '';
      }
      const sender = r.sender_id ? publicUser(getUser(r.sender_id), req.user.id) : null;
      return { message: messageOut(r), chat_type: r.chat_type, chat_title: chatTitle, sender_name: sender?.name || '' };
    }),
  });
});

// ------------------------------------------------------------------ export all personal data (JSON)
features.get('/export', (req, res) => {
  if (!rateLimit(`export:${req.user.id}`, 3, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const me = getUser(req.user.id);
  const chats = q.all(
    `SELECT c.*, mb.cleared_before FROM chats c JOIN members mb ON mb.chat_id = c.id
     WHERE mb.user_id = ? AND mb.banned = 0 ORDER BY c.id`, me.id,
  );
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="suhbat-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.write(`{"exported_at":${now()},"user":${JSON.stringify({ id: me.id, name: me.name, username: me.username, phone: me.phone?.startsWith('email:') || me.phone?.startsWith('login:') ? null : me.phone, email: me.email, bio: me.bio })},"chats":[`);
  chats.forEach((c, i) => {
    let title = c.title;
    if (c.type === 'direct') {
      const peer = q.get('SELECT u.name FROM members mm JOIN users u ON u.id = mm.user_id WHERE mm.chat_id = ? AND mm.user_id != ?', c.id, me.id);
      title = peer?.name || me.name;
    }
    const messages = q.all(
      `SELECT m.id, m.sender_id, u.name AS sender, m.kind, m.text, m.created_at, m.edited_at, f.name AS file_name, f.size AS file_size
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id LEFT JOIN files f ON f.id = m.file_id
       WHERE m.chat_id = ? AND m.id > ? ORDER BY m.id`, c.id, c.cleared_before || 0,
    );
    res.write(`${i ? ',' : ''}${JSON.stringify({ id: c.id, type: c.type, title, messages })}`);
  });
  res.end(']}');
});
