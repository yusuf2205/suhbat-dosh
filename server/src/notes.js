// Shared notes: several people type into one text. Edits arrive as single replacements against a revision; the server
// rewrites them over the edits it already accepted, applies them, and tells everybody in the chat.
import express from 'express';
import { q, tx } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { applyOp, transform } from '../../shared/ot.js';
import { HttpError, int, now, rateLimit, str } from './util.js';
import { emit } from './realtime.js';
import { getMessage, isEncrypted, memberIds, messageOut, requireMember } from './service.js';

let host = { postMessage: null };
export function wireNotes(h) { host = h; }
export const notes = express.Router();

const BODY_MAX = 200_000;
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
