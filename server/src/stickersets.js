// Sticker and emoji sets made by people: a set is a named group of their own stickers with a link, and anybody can add it to their
// own collection. Pictures of a set are visible to every signed-in person (the set is public by nature), so stickers and custom
// emoji work in any chat.
import express from 'express';
import { q } from './db.js';
import { HttpError, int, now, rateLimit, rid, str } from './util.js';

export const sets = express.Router();

const slugOf = () => rid(6).toLowerCase().replace(/[^a-z0-9]/g, '').padEnd(8, 'x').slice(0, 8);

const itemOut = (i) => {
  const f = q.get('SELECT * FROM files WHERE id = ?', i.file_id);
  return f ? { id: i.id, emoji: i.emoji, file: { id: f.id, url: `/api/files/${f.id}`, mime: f.mime, name: f.name, size: f.size } } : null;
};
const setOut = (s, uid) => ({
  id: s.id, slug: s.slug, title: s.title, kind: s.kind, mine: s.owner_id === uid,
  installed: s.owner_id === uid || !!q.get('SELECT 1 AS x FROM sticker_installed WHERE user_id = ? AND set_id = ?', uid, s.id),
  items: q.all('SELECT * FROM sticker_set_items WHERE set_id = ? ORDER BY position, id', s.id).map(itemOut).filter(Boolean),
});

const own = (req) => {
  const s = q.get('SELECT * FROM sticker_sets WHERE id = ? AND owner_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!s) throw new HttpError(404, 'not_found');
  return s;
};

/** My own sets and the ones I added. */
sets.get('/sets', (req, res) => {
  const rows = q.all(
    `SELECT s.* FROM sticker_sets s WHERE s.owner_id = ? OR s.id IN (SELECT set_id FROM sticker_installed WHERE user_id = ?) ORDER BY s.id`,
    req.user.id, req.user.id,
  );
  res.json({ sets: rows.map((s) => setOut(s, req.user.id)) });
});

sets.post('/sets', (req, res) => {
  if (!rateLimit(`mkset:${req.user.id}`, 20, 3600_000)) throw new HttpError(429, 'slow_down');
  if (q.get('SELECT COUNT(*) AS n FROM sticker_sets WHERE owner_id = ?', req.user.id).n >= 30) throw new HttpError(400, 'too_many_items');
  const title = str(req.body?.title, 'title', { min: 1, max: 40 });
  const kind = req.body?.kind === 'emoji' ? 'emoji' : 'sticker';
  let slug = slugOf();
  while (q.get('SELECT 1 AS x FROM sticker_sets WHERE slug = ?', slug)) slug = slugOf();
  const r = q.run('INSERT INTO sticker_sets (owner_id, slug, title, kind, created_at) VALUES (?,?,?,?,?)', req.user.id, slug, title, kind, now());
  res.status(201).json({ set: setOut(q.get('SELECT * FROM sticker_sets WHERE id = ?', Number(r.lastInsertRowid)), req.user.id) });
});

sets.patch('/sets/:id', (req, res) => {
  const s = own(req);
  if (req.body?.title !== undefined) q.run('UPDATE sticker_sets SET title = ? WHERE id = ?', str(req.body.title, 'title', { min: 1, max: 40 }), s.id);
  res.json({ set: setOut(q.get('SELECT * FROM sticker_sets WHERE id = ?', s.id), req.user.id) });
});

sets.delete('/sets/:id', (req, res) => {
  const s = own(req);
  q.run('DELETE FROM sticker_sets WHERE id = ?', s.id);
  res.json({ ok: true });
});

/** Add one of my own stickers (by its id in my collection) to a set. Emoji sets take small still pictures only. */
sets.post('/sets/:id/items', (req, res) => {
  const s = own(req);
  const st = q.get('SELECT * FROM stickers WHERE id = ? AND user_id = ?', int(req.body?.sticker_id, 'sticker_id'), req.user.id);
  if (!st) throw new HttpError(404, 'not_found');
  const f = q.get('SELECT * FROM files WHERE id = ?', st.file_id);
  if (!f) throw new HttpError(404, 'not_found');
  if (s.kind === 'emoji' && (!/^image\/(png|webp|gif)$/.test(f.mime) || f.size > 256 * 1024)) throw new HttpError(400, 'emoji_invalid');
  if (q.get('SELECT COUNT(*) AS n FROM sticker_set_items WHERE set_id = ?', s.id).n >= 120) throw new HttpError(400, 'too_many_items');
  if (q.get('SELECT 1 AS x FROM sticker_set_items WHERE set_id = ? AND file_id = ?', s.id, st.file_id)) throw new HttpError(409, 'already_in_set');
  const pos = q.get('SELECT COALESCE(MAX(position), 0) + 1 AS n FROM sticker_set_items WHERE set_id = ?', s.id).n;
  q.run('INSERT INTO sticker_set_items (set_id, file_id, emoji, position) VALUES (?,?,?,?)', s.id, st.file_id, st.emoji, pos);
  res.status(201).json({ set: setOut(s, req.user.id) });
});

sets.delete('/sets/:id/items/:item', (req, res) => {
  const s = own(req);
  q.run('DELETE FROM sticker_set_items WHERE id = ? AND set_id = ?', int(req.params.item, 'item'), s.id);
  res.json({ set: setOut(s, req.user.id) });
});

/** A set found by its link. */
sets.get('/sets/by/:slug', (req, res) => {
  const s = q.get('SELECT * FROM sticker_sets WHERE slug = ?', String(req.params.slug).toLowerCase().slice(0, 32));
  if (!s) throw new HttpError(404, 'not_found');
  res.json({ set: setOut(s, req.user.id) });
});

sets.post('/sets/:id/install', (req, res) => {
  const s = q.get('SELECT * FROM sticker_sets WHERE id = ?', int(req.params.id, 'id'));
  if (!s) throw new HttpError(404, 'not_found');
  if (s.owner_id !== req.user.id) {
    if (q.get('SELECT COUNT(*) AS n FROM sticker_installed WHERE user_id = ?', req.user.id).n >= 60) throw new HttpError(400, 'too_many_items');
    q.run('INSERT OR IGNORE INTO sticker_installed (user_id, set_id, at) VALUES (?,?,?)', req.user.id, s.id, now());
  }
  res.json({ set: setOut(s, req.user.id) });
});

sets.delete('/sets/:id/install', (req, res) => {
  q.run('DELETE FROM sticker_installed WHERE user_id = ? AND set_id = ?', req.user.id, int(req.params.id, 'id'));
  res.json({ ok: true });
});

/** A sticker of a set that can be sent: any item of a set the person has. */
export function setItemFor(userId, itemId) {
  return q.get(
    `SELECT i.* FROM sticker_set_items i JOIN sticker_sets s ON s.id = i.set_id
     WHERE i.id = ? AND (s.owner_id = ? OR s.id IN (SELECT set_id FROM sticker_installed WHERE user_id = ?))`, itemId, userId, userId,
  );
}
