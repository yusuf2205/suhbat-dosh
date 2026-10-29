import crypto from 'node:crypto';
import { config } from './config.js';

export class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export const rid = (bytes = 16) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const hmac = (s) => crypto.createHmac('sha256', config.secret).update(s).digest('hex');
export const now = () => Date.now();

export function safeEqual(a, b) {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

// ---- validation helpers (server-side, all input is untrusted) ----
export function str(v, field, { min = 0, max = 1000, optional = false } = {}) {
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new HttpError(400, 'invalid_input', `${field} is required`);
  }
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_input', `${field} must be a string`);
  const s = v.normalize('NFC').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (s.length < min || s.length > max) {
    throw new HttpError(400, 'invalid_input', `${field} length must be ${min}..${max}`);
  }
  return s;
}

/** A length in seconds: a recorder reports 4.37, the whole second is stored. Anything that is not a plausible length is left out. */
export function seconds(v, max = 24 * 3600) {
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(max, Math.round(n));
}

export function int(v, field, { min = 1, max = Number.MAX_SAFE_INTEGER, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return undefined;
    throw new HttpError(400, 'invalid_input', `${field} is required`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new HttpError(400, 'invalid_input', `${field} invalid`);
  return n;
}

export function oneOf(v, field, list, { optional = false } = {}) {
  if ((v === undefined || v === null) && optional) return undefined;
  if (!list.includes(v)) throw new HttpError(400, 'invalid_input', `${field} invalid`);
  return v;
}

export function normalizePhone(v) {
  if (typeof v !== 'string') throw new HttpError(400, 'invalid_phone');
  let s = v.replace(/[\s()\-.]/g, '');
  if (!s.startsWith('+')) s = '+' + s;
  if (!/^\+[1-9]\d{7,14}$/.test(s)) throw new HttpError(400, 'invalid_phone');
  return s;
}

export function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// ---- logging: never log message bodies, phone numbers, codes or tokens ----
const levels = { debug: 10, info: 20, warn: 30, error: 40 };
export function log(level, msg, fields = {}) {
  if (levels[level] < levels[config.logLevel]) return;
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...fields });
  (level === 'error' ? console.error : console.log)(line);
}

// ---- tiny in-memory sliding-window rate limiter ----
const buckets = new Map();
export function rateLimit(key, limit, windowMs) {
  const t = Date.now();
  const arr = (buckets.get(key) || []).filter((x) => t - x < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return false;
  }
  arr.push(t);
  buckets.set(key, arr);
  return true;
}
setInterval(() => {
  const t = Date.now();
  for (const [k, arr] of buckets) {
    if (!arr.length || t - arr[arr.length - 1] > 3600_000) buckets.delete(k);
  }
}, 60_000).unref();

/** Messages relayed between call participants (watching together, drawing): only small plain objects. */
export function syncData(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  let s;
  try { s = JSON.stringify(d); } catch { return null; }
  return s.length <= 2000 ? d : null;
}
