// Quick replies: a person's own snippets, typed as "/shortcut" in any chat. They follow the person to every device.
import express from 'express';
import { q } from './db.js';
import { HttpError, int, now, rateLimit, str } from './util.js';

export const quick = express.Router();

const out = (r) => ({ id: r.id, shortcut: r.shortcut, text: r.text });
const list = (uid) => q.all('SELECT * FROM quick_replies WHERE user_id = ? ORDER BY position, id', uid).map(out);

const shortcutOf = (v) => {
  const s = str(String(v ?? ''), 'shortcut', { min: 1, max: 24 }).replace(/^\/+/, '').toLowerCase();
  if (!/^[\p{L}\p{N}_-]{1,24}$/u.test(s)) throw new HttpError(400, 'invalid_input');
  return s;
};

quick.get('/me/quick', (req, res) => res.json({ replies: list(req.user.id) }));

quick.post('/me/quick', (req, res) => {
  if (!rateLimit(`quick:${req.user.id}`, 60, 3600_000)) throw new HttpError(429, 'slow_down');
  if (q.get('SELECT COUNT(*) AS n FROM quick_replies WHERE user_id = ?', req.user.id).n >= 50) throw new HttpError(400, 'too_many_items');
  const shortcut = shortcutOf(req.body?.shortcut);
  const text = str(req.body?.text, 'text', { min: 1, max: 1000 });
  if (q.get('SELECT 1 AS x FROM quick_replies WHERE user_id = ? AND shortcut = ?', req.user.id, shortcut)) throw new HttpError(409, 'shortcut_taken');
  const pos = q.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM quick_replies WHERE user_id = ?', req.user.id).n;
  q.run('INSERT INTO quick_replies (user_id, shortcut, text, position, created_at) VALUES (?,?,?,?,?)', req.user.id, shortcut, text, pos, now());
  res.status(201).json({ replies: list(req.user.id) });
});

quick.patch('/me/quick/:id', (req, res) => {
  const r = q.get('SELECT * FROM quick_replies WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!r) throw new HttpError(404, 'not_found');
  if (req.body?.shortcut !== undefined) {
    const s = shortcutOf(req.body.shortcut);
    if (s !== r.shortcut && q.get('SELECT 1 AS x FROM quick_replies WHERE user_id = ? AND shortcut = ?', req.user.id, s)) throw new HttpError(409, 'shortcut_taken');
    q.run('UPDATE quick_replies SET shortcut = ? WHERE id = ?', s, r.id);
  }
  if (req.body?.text !== undefined) q.run('UPDATE quick_replies SET text = ? WHERE id = ?', str(req.body.text, 'text', { min: 1, max: 1000 }), r.id);
  res.json({ replies: list(req.user.id) });
});

quick.delete('/me/quick/:id', (req, res) => {
  q.run('DELETE FROM quick_replies WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  res.json({ replies: list(req.user.id) });
});
