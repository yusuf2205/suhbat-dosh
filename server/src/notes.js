// Shared notes: several people type into one text. Edits arrive as single replacements against a revision; the server
// rewrites them over the edits it already accepted, applies them, and tells everybody in the chat.
import express from 'express';
import { q, tx } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { applyOp, diffOp, transform } from '../../shared/ot.js';
import { HttpError, int, now, rateLimit, str } from './util.js';
import { emit } from './realtime.js';
import { getMessage, isEncrypted, memberIds, messageOut, requireMember } from './service.js';

let host = { postMessage: null };
export function wireNotes(h) { host = h; }
export const notes = express.Router();

const BODY_MAX = 200_000;
const SESSION_GAP = Number(process.env.NOTE_SESSION_GAP_MS) || 10 * 60_000; // a pause this long ends an editing session
const KEEP_VERSIONS = 60;

/** The text as it was at the end of the previous editing session, kept before a new session changes it. */
function snapshot(n, force = false) {
  if (n.rev === 0 || !n.body) return;
  if (!force && now() - n.updated_at < SESSION_GAP) return;
  q.run('INSERT OR IGNORE INTO note_versions (note_id, rev, body, user_id, at) VALUES (?,?,?,?,?)', n.id, n.rev, n.body, n.updated_by, n.updated_at);
  q.run('DELETE FROM note_versions WHERE note_id = ? AND rev NOT IN (SELECT rev FROM note_versions WHERE note_id = ? ORDER BY rev DESC LIMIT ?)', n.id, n.id, KEEP_VERSIONS);
}
const KEEP_OPS = 400;
const answered = new Map(); // `${note}:${cid}` -> the answer already given, so a repeated request is not applied twice
const lastCard = new Map();
const cardTimer = new Map(); // note id -> when its chat card was refreshed (the card shows a short preview)

const load = (id) => {
  const n = q.get('SELECT * FROM notes WHERE id = ?', id);
  if (!n) throw new HttpError(404, 'not_found');
  return n;
};

function refreshCard(n, force = false) {
  const t = now();
  if (!force && t - (lastCard.get(n.id) || 0) < 8000) {
    // a burst of typing: the card is refreshed once more when it calms down
    if (!cardTimer.has(n.id)) cardTimer.set(n.id, setTimeout(() => { cardTimer.delete(n.id); const fresh = q.get('SELECT * FROM notes WHERE id = ?', n.id); if (fresh) refreshCard(fresh, true); }, 8200).unref());
    return;
  }
  lastCard.set(n.id, t);
  const m = getMessage(n.message_id);
  if (m) emit(memberIds(n.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(m) });
}

notes.post('/chats/:id/notes', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type === 'channel' && me.role === 'member') throw new HttpError(403, 'channel_readonly');
  if (isEncrypted(id)) throw new HttpError(403, 'secret_no_notes');
  if (!rateLimit(`note:${req.user.id}`, 20, 60_000)) throw new HttpError(429, 'slow_down');
  const title = str(req.body?.title, 'title', { min: 1, max: 80 });
  const out = host.postMessage({ chat, user: req.user, text: title, kind: 'note' });
  q.run('INSERT INTO notes (message_id, chat_id, title, creator_id, updated_at) VALUES (?,?,?,?,?)', out.message.id, id, title, req.user.id, now());
  refreshCard(q.get('SELECT * FROM notes WHERE message_id = ?', out.message.id), true); // the card was announced before its text existed
  res.status(201).json({ message: messageOut(getMessage(out.message.id)) });
});

notes.get('/notes/:id', (req, res) => {
  const n = load(int(req.params.id, 'id'));
  requireMember(n.chat_id, req.user.id);
  res.json({ note: { id: n.id, chat_id: n.chat_id, title: n.title, body: n.body, rev: n.rev, creator_id: n.creator_id } });
});

/** { rev, pos, del, ins, cid }: an edit made on top of revision `rev`. */
notes.post('/notes/:id/op', (req, res) => {
  if (!rateLimit(`noteop:${req.user.id}`, 600, 60_000)) throw new HttpError(429, 'slow_down');
  const n0 = load(int(req.params.id, 'id'));
  requireMember(n0.chat_id, req.user.id);
  const b = req.body || {};
  const base = int(b.rev, 'rev', { min: 0 });
  const pos = int(b.pos, 'pos', { min: 0 });
  const del = int(b.del, 'del', { min: 0 });
  const ins = typeof b.ins === 'string' ? b.ins.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '') : '';
  if (ins.length > 30_000 || (!del && !ins)) throw new HttpError(400, 'invalid_input');
  const cid = String(b.cid || '').slice(0, 24);
  const seen = cid ? answered.get(`${n0.id}:${cid}`) : null;
  if (seen) return res.json(seen);

  const done = tx(() => {
    const n = load(n0.id);
    snapshot(n);
    if (base > n.rev) throw new HttpError(409, 'resync');
    const missed = q.all('SELECT * FROM note_ops WHERE note_id = ? AND rev > ? ORDER BY rev', n.id, base);
    if (missed.length !== n.rev - base) throw new HttpError(409, 'resync'); // the history that old was already trimmed
    let op = { pos, del, ins };
    for (const m of missed) op = transform(op, { pos: m.pos, del: m.del, ins: m.ins });
    if (op.pos > n.body.length) op = { ...op, pos: n.body.length, del: 0 };
    if (op.pos + op.del > n.body.length) op = { ...op, del: n.body.length - op.pos };
    const body = applyOp(n.body, op);
    if (body.length > BODY_MAX) throw new HttpError(413, 'note_too_long');
    const rev = n.rev + 1;
    q.run('UPDATE notes SET body = ?, rev = ?, updated_by = ?, updated_at = ? WHERE id = ?', body, rev, req.user.id, now(), n.id);
    q.run('INSERT INTO note_ops (note_id, rev, user_id, pos, del, ins, at) VALUES (?,?,?,?,?,?,?)', n.id, rev, req.user.id, op.pos, op.del, op.ins, now());
    if (rev % 100 === 0) q.run('DELETE FROM note_ops WHERE note_id = ? AND rev <= ?', n.id, rev - KEEP_OPS);
    return { rev, op };
  });
  emit(memberIds(n0.chat_id), { type: 'note.op', note_id: n0.id, rev: done.rev, op: done.op, user_id: req.user.id, cid });
  refreshCard(load(n0.id));
  if (cid) {
    answered.set(`${n0.id}:${cid}`, done);
    if (answered.size > 2000) answered.delete(answered.keys().next().value);
  }
  res.json({ rev: done.rev, op: done.op });
});

/** Plain text download of the note. */
notes.get('/notes/:id/export', (req, res) => {
  const n = load(int(req.params.id, 'id'));
  requireMember(n.chat_id, req.user.id);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(`${n.title}.txt`)}`);
  res.send(n.body);
});

/** Earlier versions: where an editing session ended (newest first). */
notes.get('/notes/:id/versions', (req, res) => {
  const n = load(int(req.params.id, 'id'));
  requireMember(n.chat_id, req.user.id);
  const rows = q.all('SELECT rev, body, user_id, at FROM note_versions WHERE note_id = ? ORDER BY rev DESC', n.id);
  res.json({
    current: { rev: n.rev, at: n.updated_at, user_id: n.updated_by, length: n.body.length },
    versions: rows.map((r) => ({ rev: r.rev, at: r.at, user_id: r.user_id, length: r.body.length, preview: r.body.replace(/\s+/g, ' ').trim().slice(0, 160) })),
  });
});

notes.get('/notes/:id/versions/:rev', (req, res) => {
  const n = load(int(req.params.id, 'id'));
  requireMember(n.chat_id, req.user.id);
  const v = q.get('SELECT * FROM note_versions WHERE note_id = ? AND rev = ?', n.id, int(req.params.rev, 'rev', { min: 0 }));
  if (!v) throw new HttpError(404, 'not_found');
  res.json({ version: { rev: v.rev, at: v.at, user_id: v.user_id, body: v.body } });
});

/** Put an earlier version back: it becomes a normal new edit (the text now is kept as a version first), everybody sees it at once. */
notes.post('/notes/:id/restore', (req, res) => {
  if (!rateLimit(`noterestore:${req.user.id}`, 30, 3600_000)) throw new HttpError(429, 'slow_down');
  const n0 = load(int(req.params.id, 'id'));
  requireMember(n0.chat_id, req.user.id);
  const rev = int(req.body?.rev, 'rev', { min: 0 });
  const done = tx(() => {
    const n = load(n0.id);
    const v = q.get('SELECT * FROM note_versions WHERE note_id = ? AND rev = ?', n.id, rev);
    if (!v) throw new HttpError(404, 'not_found');
    const op = diffOp(n.body, v.body);
    if (!op) return { rev: n.rev, op: null };
    snapshot(n, true);
    const next = n.rev + 1;
    q.run('UPDATE notes SET body = ?, rev = ?, updated_by = ?, updated_at = ? WHERE id = ?', v.body, next, req.user.id, now(), n.id);
    q.run('INSERT INTO note_ops (note_id, rev, user_id, pos, del, ins, at) VALUES (?,?,?,?,?,?,?)', n.id, next, req.user.id, op.pos, op.del, op.ins, now());
    return { rev: next, op };
  });
  if (done.op) {
    emit(memberIds(n0.chat_id), { type: 'note.op', note_id: n0.id, rev: done.rev, op: done.op, user_id: req.user.id, cid: 'restore' });
    refreshCard(load(n0.id), true);
  }
  res.json({ rev: done.rev });
});
