// Runtime settings and who may register: open / by invitation / closed.
import { config } from './config.js';
import { q } from './db.js';
import { HttpError, now, rid } from './util.js';

export const getSetting = (key, fallback = null) => q.get('SELECT value FROM settings WHERE key = ?', key)?.value ?? fallback;

export function setSetting(key, value) {
  q.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, String(value));
}

export const REGISTRATION_MODES = ['open', 'invite', 'closed'];

export function registrationMode() {
  const v = getSetting('registration');
  if (REGISTRATION_MODES.includes(v)) return v;
  return config.registrationOpen ? 'open' : 'closed';
}

const clean = (c) => (typeof c === 'string' ? c.trim().slice(0, 64) : '');

export function inviteState(code) {
  const c = clean(code);
  if (!c) return null;
  const inv = q.get('SELECT * FROM invites WHERE code = ?', c);
  if (!inv) return null;
  if (inv.expires_at && inv.expires_at < now()) return null;
  if (inv.uses >= inv.max_uses) return null;
  return inv;
}

/**
 * May a NEW account be created right now? Returns the invitation to consume (or null).
 * Throws registration_closed / invite_required / invite_invalid.
 */
export function gateRegistration(inviteCode) {
  const mode = registrationMode();
  if (mode === 'open') return null;
  if (mode === 'closed') throw new HttpError(403, 'registration_closed');
  if (!clean(inviteCode)) throw new HttpError(403, 'invite_required');
  const inv = inviteState(inviteCode);
  if (!inv) throw new HttpError(403, 'invite_invalid');
  return inv;
}

export function consumeInvite(inv) {
  if (inv) q.run('UPDATE invites SET uses = uses + 1 WHERE id = ?', inv.id);
}

export function createInvite({ by, note = '', maxUses = 1, ttlDays = 0 }) {
  const code = rid(9);
  q.run(
    'INSERT INTO invites (code, note, created_by, created_at, expires_at, max_uses) VALUES (?,?,?,?,?,?)',
    code, note.slice(0, 120), by, now(), ttlDays > 0 ? now() + ttlDays * 86400_000 : null, Math.max(1, Math.min(1000, maxUses)),
  );
  return code;
}
