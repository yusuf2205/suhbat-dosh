// Search by meaning. A small multilingual model (the `embed` container, EMBED_URL) turns every readable message into a vector;
// a question is turned into a vector too and the closest messages are returned, even when they share no words with it.
// Only text the server can read is indexed: secret and encrypted chats, one-time and private things never are.
import express from 'express';
import { q } from './db.js';
import { HttpError, int, log, now, rateLimit, str } from './util.js';
import { messageOut } from './service.js';

export const semantic = express.Router();
const BASE = () => (process.env.EMBED_URL || 'http://embed:9100').replace(/\/+$/, '');

let health = { at: 0, ok: false };
export async function embedderAvailable() {
  if (!BASE()) return false;
  if (Date.now() - health.at < 20_000) return health.ok;
  let ok = false;
  try { ok = (await fetch(`${BASE()}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { ok = false; }
  health = { at: Date.now(), ok };
  return ok;
}
export const embedderReady = () => { embedderAvailable(); return health.ok; };

async function embed(texts, kind) {
  const r = await fetch(`${BASE()}/embed`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ texts, kind }), signal: AbortSignal.timeout(60_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !Array.isArray(j.vectors)) throw new Error(j.error || `http_${r.status}`);
  return j.vectors.map((v) => Float32Array.from(v));
}

const toBlob = (v) => Buffer.from(v.buffer, v.byteOffset, v.byteLength);
const fromBlob = (b) => new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));

/** Embed the next batch of messages that have no vector yet (newest first). Returns how many were done. */
export async function indexBatch(limit = 48) {
  const rows = q.all(
    `SELECT m.id, m.text FROM messages m JOIN chats c ON c.id = m.chat_id
     WHERE m.kind = 'text' AND length(m.text) >= 12 AND m.once = 0 AND c.e2e = 0
       AND NOT EXISTS (SELECT 1 FROM embeddings e WHERE e.message_id = m.id)
       AND NOT EXISTS (SELECT 1 FROM secret_chats s WHERE s.chat_id = m.chat_id)
     ORDER BY m.id DESC LIMIT ?`, limit,
  );
  if (!rows.length) return 0;
  const vecs = await embed(rows.map((r) => r.text.slice(0, 600)), 'passage');
  for (let i = 0; i < rows.length; i += 1) q.run('INSERT OR REPLACE INTO embeddings (message_id, vec) VALUES (?,?)', rows[i].id, toBlob(vecs[i]));
  return rows.length;
}

let busy = false;
export function startIndexer() {
  const tick = async () => {
    if (busy || !BASE()) return;
    busy = true;
    let more = false;
    try {
      if (await embedderAvailable()) more = (await indexBatch()) > 0;
    } catch (e) { log('warn', 'embedding failed', { err: String(e.message).slice(0, 100) }); health = { at: Date.now(), ok: false }; }
    busy = false;
    if (more) setTimeout(tick, 300).unref();
  };
  const every = Number(process.env.EMBED_TICK_MS) || 20_000;
  setInterval(tick, every).unref();
  setTimeout(tick, 1500).unref();
}

semantic.get('/search/semantic', async (req, res) => {
  if (!rateLimit(`sem:${req.user.id}`, 30, 60_000)) throw new HttpError(429, 'slow_down');
  const term = str(String(req.query.q ?? ''), 'q', { min: 3, max: 200 });
  const chatId = int(req.query.chat_id, 'chat_id', { optional: true });
  if (!(await embedderAvailable())) throw new HttpError(503, 'semantic_unavailable');
  let qv;
  try { [qv] = await embed([term], 'query'); } catch { throw new HttpError(502, 'semantic_failed'); }
  const rows = q.all(
    `SELECT e.message_id AS id, e.vec FROM embeddings e JOIN messages m ON m.id = e.message_id
     JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0
     WHERE m.id > mb.cleared_before ${chatId !== undefined ? 'AND m.chat_id = ?' : ''}`,
    ...(chatId !== undefined ? [req.user.id, chatId] : [req.user.id]),
  );
  const scored = [];
  for (const r of rows) {
    const v = fromBlob(r.vec);
    if (v.length !== qv.length) continue;
    let dot = 0;
    for (let i = 0; i < v.length; i += 1) dot += v[i] * qv[i];
    scored.push([dot, r.id]);
  }
  scored.sort((a, b) => b[0] - a[0]);
  const out = [];
  for (const [score, id] of scored.slice(0, 20)) {
    const m = q.get('SELECT * FROM messages WHERE id = ?', id);
    if (m) out.push({ score: Math.round(score * 1000) / 1000, message: messageOut(m) });
  }
  res.json({ results: out, indexed: rows.length, at: now() });
});

semantic.get('/search/semantic/status', async (req, res) => {
  const ready = await embedderAvailable();
  const total = q.get("SELECT COUNT(*) AS n FROM messages m JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0 WHERE m.kind = 'text' AND length(m.text) >= 12", req.user.id).n;
  const done = q.get('SELECT COUNT(*) AS n FROM embeddings e JOIN messages m ON m.id = e.message_id JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0', req.user.id).n;
  res.json({ ready, total, done });
});
