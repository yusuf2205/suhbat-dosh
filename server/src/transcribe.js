// Voice message -> text. The audio is sent only to our own speech-to-text container (WHISPER_URL); jobs run one at a time.
// The result is a draft: it is shown with the uncertain words marked, and the recording always stays the source of truth.
import express from 'express';
import fs from 'node:fs';
import { q } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { HttpError, int, log, now, rateLimit } from './util.js';
import { emit } from './realtime.js';
import { getMessage, memberIds, messageOut, requireMember } from './service.js';
import { filePath } from './files.js';

export const transcribe = express.Router();
const URL_BASE = () => (process.env.WHISPER_URL || 'http://whisper:9000').replace(/\/+$/, '');

let health = { at: 0, ok: false };
export async function transcriberAvailable() {
  if (Date.now() - health.at < 30_000) return health.ok;
  let ok = false;
  try { ok = (await fetch(`${URL_BASE()}/health`, { signal: AbortSignal.timeout(2000) })).ok; } catch { ok = false; }
  health = { at: Date.now(), ok };
  return ok;
}

/** Last known state of the service, refreshed in the background (the client hides the button when it is down). */
export const transcriberReady = () => { transcriberAvailable(); return health.ok; };

const queue = [];
let running = false;

function pushUpdate(messageId) {
  const m = getMessage(messageId);
  if (m) emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(m) });
}

async function runOne(job) {
  const m = getMessage(job.messageId);
  const f = m?.file_id ? q.get('SELECT * FROM files WHERE id = ?', m.file_id) : null;
  if (!m || !f || !fs.existsSync(filePath(f.id))) {
    q.run("UPDATE transcripts SET status = 'error', error = 'gone', updated_at = ? WHERE message_id = ?", now(), job.messageId);
    return;
  }
  try {
    const body = fs.readFileSync(filePath(f.id));
    const r = await fetch(`${URL_BASE()}/transcribe${job.lang ? `?lang=${encodeURIComponent(job.lang)}` : ''}`, {
      method: 'POST', body, headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(20 * 60_000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `http_${r.status}`);
    const words = (j.words || []).slice(0, 4000).map((w) => [String(w.w).slice(0, 60), Number(w.p)]);
    q.run("UPDATE transcripts SET status = 'done', lang = ?, text = ?, words = ?, model = ?, error = NULL, updated_at = ? WHERE message_id = ?",
      String(j.language || '').slice(0, 8), String(j.text || '').slice(0, 20000), JSON.stringify(words), String(j.model || '').slice(0, 40), now(), job.messageId);
  } catch (e) {
    log('warn', 'transcription failed', { message: job.messageId, err: String(e.message).slice(0, 120) });
    const code = e.name === 'TimeoutError' ? 'timeout' : /decode/.test(String(e.message)) ? 'decode_failed' : 'unavailable';
    q.run("UPDATE transcripts SET status = 'error', error = ?, updated_at = ? WHERE message_id = ?", code, now(), job.messageId);
  }
}

async function pump() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await runOne(job);
      pushUpdate(job.messageId);
    }
  } finally { running = false; }
}

/** After a restart: jobs that were still pending go back into the queue. */
export function resumeTranscriptions() {
  for (const r of q.all("SELECT message_id FROM transcripts WHERE status = 'pending' ORDER BY created_at")) queue.push({ messageId: r.message_id, lang: '' });
  if (queue.length) pump();
}

transcribe.post('/messages/:id/transcribe', async (req, res) => {
  if (!rateLimit(`tr:${req.user.id}`, 30, 3600_000)) throw new HttpError(429, 'slow_down');
  const m = getMessage(int(req.params.id, 'id'));
  if (!m) throw new HttpError(404, 'not_found');
  requireMember(m.chat_id, req.user.id);
  const isSecret = !!q.get('SELECT 1 AS x FROM secret_chats WHERE chat_id = ?', m.chat_id);
  if (isSecret || m.kind === 'secret') throw new HttpError(403, 'secret_no_transcribe'); // the server cannot read these
  const f = m.file_id ? q.get('SELECT * FROM files WHERE id = ?', m.file_id) : null;
  const okKind = f && (m.kind === 'voice' || m.kind === 'audio' || (m.kind === 'video' && /^circle\./i.test(f.name)));
  if (!okKind) throw new HttpError(400, 'invalid_input');
  if (!(await transcriberAvailable())) throw new HttpError(503, 'transcribe_unavailable');
  const lang = ['ru', 'uz', 'en'].includes(req.body?.lang) ? req.body.lang : '';
  const cur = q.get('SELECT status FROM transcripts WHERE message_id = ?', m.id);
  if (cur && cur.status !== 'error') return res.json({ message: messageOut(getMessage(m.id)) });
  q.run(
    `INSERT INTO transcripts (message_id, status, requested_by, created_at, updated_at) VALUES (?, 'pending', ?, ?, ?)
     ON CONFLICT(message_id) DO UPDATE SET status = 'pending', error = NULL, updated_at = excluded.updated_at`,
    m.id, req.user.id, now(), now(),
  );
  queue.push({ messageId: m.id, lang });
  pump();
  pushUpdate(m.id);
  return res.status(202).json({ message: messageOut(getMessage(m.id)) });
});

setTimeout(() => transcriberAvailable(), 300).unref(); // know the state before the first client asks
