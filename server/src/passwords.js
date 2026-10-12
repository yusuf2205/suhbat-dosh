import crypto from 'node:crypto';

const N = 16384;
const KEYLEN = 64;

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString('base64')}$${key.toString('base64')}`;
}

const DUMMY = hashPassword('not-a-real-password');

/** Constant-ish time: an unknown login is compared against a dummy hash too. */
export function verifyPassword(pw, stored) {
  const [, n, saltB64, keyB64] = String(stored || DUMMY).split('$');
  try {
    const key = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), KEYLEN, { N: Number(n) || N });
    const want = Buffer.from(keyB64, 'base64');
    return stored ? key.length === want.length && crypto.timingSafeEqual(key, want) : false;
  } catch { return false; }
}
