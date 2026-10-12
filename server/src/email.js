import crypto from 'node:crypto';
import { config } from './config.js';
import { q } from './db.js';
import { HttpError, hmac, log, now, safeEqual } from './util.js';

// E-mail one-time codes, delivered through the Resend HTTP API (no SMTP, no extra dependencies).
export const emailEnabled = () => !!config.resendApiKey;

const TTL = 10 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const EMAIL_RE = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

export function normalizeEmail(v) {
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_email');
  const e = v.trim().toLowerCase();
  if (e.length > 120 || !EMAIL_RE.test(e)) throw new HttpError(400, 'invalid_email');
  return e;
}

async function send(to, subject, text, html) {
  const r = await fetch(`${config.resendApiBase}/emails`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${config.resendApiKey}` },
    body: JSON.stringify({ from: config.emailFrom, to: [to], subject, text, html }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!r.ok) {
    // never log the address, the key or the response body
    log('warn', 'email send failed', { status: r.status });
    throw new HttpError(502, 'email_failed');
  }
}

/** Create + send a code. purpose: 'login' or 'link:<userId>'. */
export async function issueCode(email, purpose = 'login') {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  q.run(
    `INSERT INTO email_codes (email, purpose, code_hash, expires_at, attempts, created_at) VALUES (?,?,?,?,0,?)
     ON CONFLICT(email, purpose) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, created_at = excluded.created_at`,
    email, purpose, hmac(`email:${email}:${purpose}:${code}`), now() + TTL, now(),
  );
  const brand = 'Suhbat-dosh';
  const text = `${brand}\n\nКод входа / Kirish kodi: ${code}\n\n` +
    'Код действует 10 минут. Если вы его не запрашивали, просто проигнорируйте письмо.\n' +
    'Kod 10 daqiqa amal qiladi. Agar siz so‘ramagan bo‘lsangiz, xatni e’tiborsiz qoldiring.';
  const html = `<div style="font-family:system-ui,Segoe UI,Arial,sans-serif;max-width:420px;margin:auto;padding:24px">` +
    `<h2 style="margin:0 0 12px">${brand}</h2>` +
    `<p style="color:#555;margin:0 0 8px">Код входа / Kirish kodi</p>` +
    `<p style="font-size:34px;letter-spacing:6px;font-weight:700;margin:0 0 16px">${code}</p>` +
    `<p style="color:#777;font-size:13px">Код действует 10 минут. Если вы его не запрашивали, просто проигнорируйте письмо.<br>` +
    `Kod 10 daqiqa amal qiladi. Agar siz so‘ramagan bo‘lsangiz, xatni e’tiborsiz qoldiring.</p></div>`;
  await send(email, `${brand}: ${code}`, text, html);
}

/** Returns true when the code is right (and consumes it). Throws HttpError otherwise. */
export function checkCode(email, purpose, code, { consume = true } = {}) {
  const row = q.get('SELECT * FROM email_codes WHERE email = ? AND purpose = ?', email, purpose);
  if (!row || row.expires_at < now()) throw new HttpError(400, 'invalid_code');
  if (row.attempts >= MAX_ATTEMPTS) {
    q.run('DELETE FROM email_codes WHERE email = ? AND purpose = ?', email, purpose);
    throw new HttpError(429, 'too_many_attempts');
  }
  if (!safeEqual(row.code_hash, hmac(`email:${email}:${purpose}:${code}`))) {
    q.run('UPDATE email_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?', email, purpose);
    throw new HttpError(400, 'invalid_code');
  }
  if (consume) q.run('DELETE FROM email_codes WHERE email = ? AND purpose = ?', email, purpose);
  return true;
}
