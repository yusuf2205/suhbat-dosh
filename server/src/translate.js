// Text translation through your own LibreTranslate container (TRANSLATE_URL), so chats are translated without a third party.
// When it is not running, the browser's built-in translator is used where it exists.
import express from 'express';
import { HttpError, log, rateLimit } from './util.js';

export const translate = express.Router();
const BASE = () => (process.env.TRANSLATE_URL || 'http://translate:5000').replace(/\/+$/, '');

let health = { at: 0, ok: false };
export async function translatorAvailable() {
  if (!BASE()) return false;
  if (Date.now() - health.at < 30_000) return health.ok;
  let ok = false;
  try { ok = (await fetch(`${BASE()}/languages`, { signal: AbortSignal.timeout(2000) })).ok; } catch { ok = false; }
  health = { at: Date.now(), ok };
  return ok;
}
export const translatorReady = () => { translatorAvailable(); return health.ok; };
// known from the start (the first page a person opens must already know whether translation is there), and kept fresh
translatorAvailable().catch(() => {});
setInterval(() => translatorAvailable().catch(() => {}), 60_000).unref();

translate.post('/translate', async (req, res) => {
  if (!rateLimit(`tl:${req.user.id}`, 600, 60_000)) throw new HttpError(429, 'slow_down');
  const text = typeof req.body?.text === 'string' ? req.body.text.slice(0, 2000) : '';
  const target = ['ru', 'uz', 'en'].includes(req.body?.target) ? req.body.target : '';
  if (!text.trim() || !target) throw new HttpError(400, 'invalid_input');
  if (!(await translatorAvailable())) throw new HttpError(503, 'translate_unavailable');
  try {
    const r = await fetch(`${BASE()}/translate`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15_000),
      body: JSON.stringify({ q: text, source: 'auto', target, format: 'text' }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `http_${r.status}`);
    return res.json({ text: String(j.translatedText || ''), from: String(j.detectedLanguage?.language || '') });
  } catch (e) {
    log('warn', 'translate failed', { err: String(e.message).slice(0, 80) });
    throw new HttpError(502, 'translate_failed');
  }
});
