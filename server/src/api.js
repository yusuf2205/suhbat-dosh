import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import crypto2 from 'node:crypto';
import { config } from './config.js';
import { db, q, tx } from './db.js';
import {
  CHAT_TYPES, EVENTS, LIMITS, PRIVACY_VALUES, REACTIONS,
} from '../../shared/contracts.js';
import {
  HttpError, escapeLike, hmac, int, log, normalizePhone, now, oneOf, parseCookies, rateLimit, rid, safeEqual,
  sha256, str,
} from './util.js';
import { dropSession, emit, isOnline } from './realtime.js';
import {
  chatOut, directKey, directPeerId, getMessage, getUser, isAdmin, isBlockedEitherWay, listChats, memberIds,
  membership, messageOut, publicUser, refreshLastMessage, requireMember, selfUser, audit,
} from './service.js';
import { admin } from './admin.js';
import { botsRouter, notifyBots, wireBots } from './bots.js';
import { handleFatherMessage } from './botfather.js';
import { pushNewMessage, pushRouter } from './push.js';
import { consumeInvite, gateRegistration, registrationMode } from './access.js';
import { serviceMessage, wireNotify } from './notify.js';
import { features, wireFeatures } from './features.js';
import { activeFor as activeGroupCalls } from './groupcalls.js';
import { hashPassword, verifyPassword } from './passwords.js';
import { assertQuota, checkSpam, safety } from './safety.js';
import { currentIceServers } from './turn.js';
import { recentCalls } from './calls.js';
import { BUILD_ID, SERVER_VERSION } from './build.js';
import { getBotUsername, pollLogin, startLogin, telegramEnabled } from './telegram.js';
import { checkCode, emailEnabled, issueCode, normalizeEmail } from './email.js';
import { checkName, filePath, readHead, receive, removeFile, sniff, thumbPath } from './files.js';
import zlib from 'node:zlib';

export const api = express.Router();

// ------------------------------------------------------------------ auth plumbing

export function authenticate(req) {
  const token = parseCookies(req.headers.cookie).sid;
  if (!token) return null;
  const s = q.get('SELECT * FROM sessions WHERE token_hash = ? AND revoked = 0', sha256(token));
  if (!s || now() - s.last_active > config.sessionTtlMs) return null;
  const user = getUser(s.user_id);
  if (!user || user.banned_at) return null;
  // a device that signed in once stays signed in: use renews both the server record and the cookie (once a day)
  const renew = now() - s.last_active > 24 * 3600_000;
  if (now() - s.last_active > 60_000) q.run('UPDATE sessions SET last_active = ? WHERE id = ?', now(), s.id);
  return { user, session: s, token, renew };
}

function ip(req) {
  return config.trustProxy ? (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.ip : req.socket.remoteAddress || '';
}

const aud = (req, action, o = {}) => audit(o.actor ?? req.user?.id ?? null, action, { ...o, ip: ip(req) });

const requireAuth = (req, res, next) => {
  const a = authenticate(req);
  if (!a) return next(new HttpError(401, 'unauthorized'));
  if (a.renew) setCookie(res, a.token, req);
  req.user = a.user;
  req.session = a.session;
  next();
};

function setCookie(res, token, req) {
  const parts = [`sid=${token}`, 'HttpOnly', 'SameSite=Strict', 'Path=/', `Max-Age=${Math.floor(config.sessionTtlMs / 1000)}`];
  if (config.cookieSecure || req?.secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

// ------------------------------------------------------------------ auth routes

function startSession(req, res, user, via) {
  if (user.banned_at) throw new HttpError(403, 'account_banned');
  // an administrator who has set a login + password signs in only with them
  if (user.is_admin && user.admin_pass && via !== 'admin_password') throw new HttpError(403, 'admin_password_required');
  const token = rid(32);
  const device = String(req.headers['user-agent'] || '').slice(0, 160);
  // a sign-in from a device this account has not used before is reported in the service chat
  const known = q.get('SELECT 1 AS x FROM sessions WHERE user_id = ? AND device = ?', user.id, device);
  const any = q.get('SELECT 1 AS x FROM sessions WHERE user_id = ?', user.id);
  q.run(
    'INSERT INTO sessions (user_id, token_hash, device, ip, created_at, last_active) VALUES (?, ?, ?, ?, ?, ?)',
    user.id, sha256(token), String(req.headers['user-agent'] || '').slice(0, 160), ip(req), now(), now(),
  );
  setCookie(res, token, req);
  if (any && !known) {
    try {
      serviceMessage(user.id, `🔐 Новый вход в аккаунт
Устройство: ${device.slice(0, 90) || '—'}
IP: ${ip(req) || '—'}
Если это были не вы — откройте Настройки → Активные сессии и завершите сеанс.`);
    } catch { /* a notice must never block the sign-in */ }
  }
  aud(req, 'auth.login', { actor: user.id, target_type: 'user', target_id: user.id, details: { via, device: String(req.headers['user-agent'] || '').slice(0, 120) } });
}

async function deliverOtp(phone, code) {
  if (config.otpMode === 'log') {
    // Private-install mode: the operator reads the code from the server log and relays it.
    log('info', 'otp issued', { phone_tail: phone.slice(-4), code });
  } else if (config.otpMode === 'webhook') {
    const r = await fetch(config.smsWebhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(config.smsWebhookToken ? { authorization: `Bearer ${config.smsWebhookToken}` } : {}),
      },
      body: JSON.stringify({ phone, text: `Suhbat-dosh: ${code}` }),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) throw new HttpError(502, 'sms_failed');
  }
}

api.post('/auth/request', async (req, res) => {
  if (config.otpMode !== 'dev') throw new HttpError(403, 'otp_disabled'); // retired (dev mode keeps it for the tests)
  const phone = normalizePhone(req.body?.phone);
  if (!rateLimit(`otp-ip:${ip(req)}`, config.otpPerIp, 600_000) || !rateLimit(`otp-phone:${phone}`, 3, 600_000)) {
    throw new HttpError(429, 'too_many_requests');
  }
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  q.run(
    `INSERT INTO otp_codes (phone, code_hash, expires_at, attempts, created_at) VALUES (?, ?, ?, 0, ?)
     ON CONFLICT(phone) DO UPDATE SET code_hash = excluded.code_hash, expires_at = excluded.expires_at,
       attempts = 0, created_at = excluded.created_at`,
    phone, hmac(`${phone}:${code}`), now() + config.otpTtlMs, now(),
  );
  await deliverOtp(phone, code);
  res.json({ ok: true, ttl: config.otpTtlMs / 1000, ...(config.otpMode === 'dev' ? { dev_code: code } : {}) });
});

api.post('/auth/verify', (req, res) => {
  if (config.otpMode !== 'dev') throw new HttpError(403, 'otp_disabled');
  const phone = normalizePhone(req.body?.phone);
  const code = str(req.body?.code, 'code', { min: 6, max: 6 });
  if (!rateLimit(`verify-ip:${ip(req)}`, config.otpPerIp * 3, 600_000)) throw new HttpError(429, 'too_many_requests');
  const otp = q.get('SELECT * FROM otp_codes WHERE phone = ?', phone);
  if (!otp || otp.expires_at < now()) throw new HttpError(400, 'invalid_code');
  if (otp.attempts >= config.otpMaxAttempts) {
    q.run('DELETE FROM otp_codes WHERE phone = ?', phone);
    throw new HttpError(429, 'too_many_attempts');
  }
  if (!safeEqual(otp.code_hash, hmac(`${phone}:${code}`))) {
    q.run('UPDATE otp_codes SET attempts = attempts + 1 WHERE phone = ?', phone);
    throw new HttpError(400, 'invalid_code');
  }
  let user = q.get('SELECT * FROM users WHERE phone = ?', phone);
  if (!user) {
    const inv = gateRegistration(req.body?.invite);
    if (req.body?.name === undefined) return res.json({ needs_name: true });
    const name = str(req.body.name, 'name', { min: 1, max: LIMITS.NAME_MAX });
    const r = q.run(
      'INSERT INTO users (phone, name, last_seen, created_at) VALUES (?, ?, ?, ?)', phone, name, now(), now(),
    );
    user = getUser(Number(r.lastInsertRowid));
    consumeInvite(inv);
    if (config.superAdminPhones.includes(phone)) {
      q.run('UPDATE users SET is_admin = 1 WHERE id = ?', user.id);
      user = getUser(user.id);
    }
    aud(req, 'user.register', { actor: user.id, target_type: 'user', target_id: user.id, details: { name: user.name } });
  }
  q.run('DELETE FROM otp_codes WHERE phone = ?', phone);
  startSession(req, res, user, 'phone_code');
  res.json({ user: selfUser(user) });
});

const LOGIN_RE = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
const PASSWORD_MIN = 8;
const goodPassword = (v) => {
  const p = String(v ?? '');
  if (p.length < PASSWORD_MIN || p.length > 200) throw new HttpError(400, 'weak_password');
  return p;
};

// the one sign-in form: login (username) + password; administrators may use their admin login here as well
api.post('/auth/login', (req, res) => {
  const login = str(String(req.body?.login ?? ''), 'login', { min: 1, max: 64 }).replace(/^@/, '').toLowerCase();
  const password = str(String(req.body?.password ?? ''), 'password', { min: 1, max: 200 });
  if (!rateLimit(`login-ip:${ip(req)}`, 20, 600_000) || !rateLimit(`login:${login}`, 8, 600_000)) throw new HttpError(429, 'too_many_requests');
  let user = q.get('SELECT * FROM users WHERE username = ? COLLATE NOCASE', login);
  let via = 'password';
  let ok = !!user?.pw_hash && verifyPassword(password, user.pw_hash);
  if (!ok) {
    const adm = q.get('SELECT * FROM users WHERE admin_login = ? AND is_admin = 1', login);
    if (adm && verifyPassword(password, adm.admin_pass)) { user = adm; ok = true; via = 'admin_password'; }
  }
  if (!ok) {
    if (!user?.pw_hash) verifyPassword(password, null); // same work for unknown logins
    aud(req, 'auth.login_failed', { actor: null, details: { login } });
    throw new HttpError(401, 'invalid_credentials');
  }
  startSession(req, res, user, via);
  res.json({ user: selfUser(user) });
});

// step 1 of sign-up: check the login and the address, mail a code (the account does not exist yet)
api.post('/auth/register/code', async (req, res) => {
  if (!emailEnabled()) throw new HttpError(404, 'email_disabled');
  if (!rateLimit(`regcode-ip:${ip(req)}`, 10, 600_000)) throw new HttpError(429, 'too_many_requests');
  gateRegistration(req.body?.invite); // closed / invitation-only is reported before a mail is sent
  const username = str(String(req.body?.username ?? ''), 'username', { min: 1, max: LIMITS.USERNAME_MAX }).replace(/^@/, '');
  if (!LOGIN_RE.test(username)) throw new HttpError(400, 'invalid_username');
  if (q.get('SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE', username)) throw new HttpError(409, 'username_taken');
  const email = normalizeEmail(req.body?.email);
  if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new HttpError(409, 'email_taken');
  if (!rateLimit(`regcode-to:${email}`, 3, 600_000)) throw new HttpError(429, 'too_many_requests');
  await issueCode(email, 'register');
  res.json({ ok: true, ttl: 600 });
});

api.post('/auth/register', (req, res) => {
  if (!rateLimit(`reg-ip:${ip(req)}`, 10, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const inv = gateRegistration(req.body?.invite);
  const name = str(req.body?.name, 'name', { min: 1, max: LIMITS.NAME_MAX });
  const username = str(String(req.body?.username ?? ''), 'username', { min: 1, max: LIMITS.USERNAME_MAX }).replace(/^@/, '');
  if (!LOGIN_RE.test(username)) throw new HttpError(400, 'invalid_username');
  const password = goodPassword(req.body?.password);
  if (q.get('SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE', username)) throw new HttpError(409, 'username_taken');
  // an e-mail address is mandatory and must be proven with the mailed code
  let email = null;
  if (emailEnabled()) {
    email = normalizeEmail(req.body?.email);
    if (q.get('SELECT 1 AS x FROM users WHERE email = ?', email)) throw new HttpError(409, 'email_taken');
    checkCode(email, 'register', str(req.body?.code, 'code', { min: 6, max: 6 }));
  }
  const r = q.run(
    'INSERT INTO users (phone, name, username, pw_hash, email, email_verified_at, last_seen, created_at) VALUES (?,?,?,?,?,?,?,?)',
    `login:${username.toLowerCase()}`, name, username, hashPassword(password), email, email ? now() : null, now(), now(),
  );
  const user = getUser(Number(r.lastInsertRowid));
  consumeInvite(inv);
  aud(req, 'user.register', { actor: user.id, target_type: 'user', target_id: user.id, details: { name, via: 'password' } });
  startSession(req, res, user, 'password');
  res.status(201).json({ user: selfUser(user) });
});

api.post('/auth/admin-login', (req, res) => {
  const login = str(String(req.body?.login ?? ''), 'login', { min: 1, max: 64 }).toLowerCase();
  const password = str(String(req.body?.password ?? ''), 'password', { min: 1, max: 200 });
  if (!rateLimit(`adminlogin-ip:${ip(req)}`, 10, 600_000) || !rateLimit(`adminlogin:${login}`, 5, 600_000)) throw new HttpError(429, 'too_many_requests');
  const user = q.get('SELECT * FROM users WHERE admin_login = ? AND is_admin = 1', login);
  const ok = verifyPassword(password, user?.admin_pass);
  if (!user || !ok) {
    aud(req, 'auth.admin_login_failed', { actor: null, details: { login } });
    throw new HttpError(401, 'invalid_credentials');
  }
  startSession(req, res, user, 'admin_password');
  res.json({ user: selfUser(user) });
});

api.get('/auth/providers', async (_req, res) => {
  res.json({
    telegram: { enabled: false }, // sign-in with Telegram was retired: login + password only
    phone_code: false,
    password: true,
    email: emailEnabled(), // kept only as a way back into an account whose password is forgotten
  });
});

// ---- sign in with an e-mail code
api.post('/auth/email/request', async (req, res) => {
  if (!emailEnabled()) throw new HttpError(404, 'email_disabled');
  const email = normalizeEmail(req.body?.email);
  if (!rateLimit(`mail-ip:${ip(req)}`, 10, 600_000) || !rateLimit(`mail-to:${email}`, 3, 600_000)) {
    throw new HttpError(429, 'too_many_requests');
  }
  await issueCode(email, 'login');
  res.json({ ok: true, ttl: 600 }); // same answer whether or not the address is known
});

api.post('/auth/email/verify', (req, res) => {
  if (!emailEnabled()) throw new HttpError(404, 'email_disabled');
  if (!rateLimit(`mailv-ip:${ip(req)}`, 30, 600_000)) throw new HttpError(429, 'too_many_requests');
  const email = normalizeEmail(req.body?.email);
  const code = str(req.body?.code, 'code', { min: 6, max: 6 });
  let user = q.get('SELECT * FROM users WHERE email = ?', email);
  if (!user && req.body?.name === undefined) {
    checkCode(email, 'login', code, { consume: false }); // proves ownership before asking for a name
    return res.json({ needs_name: true });
  }
  checkCode(email, 'login', code);
  if (!user) {
    const inv = gateRegistration(req.body?.invite);
    const name = str(req.body.name, 'name', { min: 1, max: LIMITS.NAME_MAX });
    const r = q.run(
      'INSERT INTO users (phone, name, email, email_verified_at, last_seen, created_at) VALUES (?,?,?,?,?,?)',
      `email:${email}`, name, email, now(), now(), now(),
    );
    user = getUser(Number(r.lastInsertRowid));
    consumeInvite(inv);
    aud(req, 'user.register', { actor: user.id, target_type: 'user', target_id: user.id, details: { name, via: 'email' } });
  }
  startSession(req, res, user, 'email');
  res.json({ user: selfUser(user) });
});

api.post('/auth/telegram/start', async (req, res) => {
  throw new HttpError(404, 'telegram_disabled'); // retired
  // eslint-disable-next-line no-unreachable
  if (!telegramEnabled()) throw new HttpError(404, 'telegram_disabled');
  if (!rateLimit(`tgstart:${ip(req)}`, 20, 600_000)) throw new HttpError(429, 'too_many_requests');
  try {
    res.json(await startLogin({ ip: ip(req), device: String(req.headers['user-agent'] || ''), invite: req.body?.invite }));
  } catch (e) {
    throw new HttpError(e.status || 503, e.code || 'telegram_unavailable');
  }
});

api.get('/auth/telegram/poll', (req, res) => {
  if (!rateLimit(`tgpoll:${ip(req)}`, 120, 60_000)) throw new HttpError(429, 'too_many_requests');
  const token = str(String(req.query.token ?? ''), 'token', { min: 10, max: 64 });
  const r = pollLogin(token, (u) => (!u ? 'generic' : u.banned_at ? 'account_banned' : u.is_admin && u.admin_pass ? 'admin_password_required' : null));
  if (r.status === 'approved') {
    startSession(req, res, r.user, 'telegram');
    return res.json({ status: 'approved', user: selfUser(r.user) });
  }
  res.json({ status: r.status, step: r.step, reason: r.reason });
});

api.post('/auth/logout', requireAuth, (req, res) => {
  q.run('UPDATE sessions SET revoked = 1 WHERE id = ?', req.session.id);
  dropSession(req.session.id);
  aud(req, 'auth.logout');
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// ---- public downloads (installers placed in DOWNLOADS_DIR by the operator)
const dlCache = new Map(); // name -> { sig, sha256 }
function platformOf(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.blockmap') || n.endsWith('.part')) return null;
  if (n.endsWith('.apk')) return 'android';
  if (n.endsWith('.ipa')) return 'ios';
  if (n.endsWith('.dmg') || /mac|darwin|osx/.test(n)) return 'macos';
  if (n.endsWith('.appimage') || n.endsWith('.deb') || /linux/.test(n)) return 'linux';
  if (n.endsWith('.exe') || n.endsWith('.msi') || /win/.test(n)) return 'windows';
  return null;
}
export function listDownloads() {
  let names = [];
  try { names = fs.readdirSync(config.downloadsDir); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (name.startsWith('.') || !/^[\w.\- ()]+$/.test(name)) continue;
    const platform = platformOf(name);
    if (!platform) continue;
    const full = path.join(config.downloadsDir, name);
    let st;
    try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile()) continue;
    const sig = `${st.size}:${st.mtimeMs}`;
    let c = dlCache.get(name);
    if (!c || c.sig !== sig) {
      c = { sig, sha256: crypto2.createHash('sha256').update(fs.readFileSync(full)).digest('hex') };
      dlCache.set(name, c);
    }
    out.push({ name, platform, size: st.size, sha256: c.sha256, updated_at: Math.round(st.mtimeMs) });
  }
  return out.sort((x, y) => x.platform.localeCompare(y.platform) || x.name.localeCompare(y.name));
}

// Newest installer version per platform, parsed from the file names in the downloads folder.
function latestVersions() {
  const out = {};
  for (const f of listDownloads()) {
    const m = /(\d+\.\d+\.\d+)/.exec(f.name);
    if (!m) continue;
    const cur = out[f.platform];
    const cmp = (x, y) => x.split('.').map(Number).reduce((r, n, i) => r || n - Number(y.split('.')[i]), 0);
    if (!cur || cmp(m[1], cur.version) > 0) out[f.platform] = { version: m[1], file: f.name, size: f.size };
  }
  return out;
}

api.get('/version', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ build: BUILD_ID, server: SERVER_VERSION, apps: latestVersions() });
});

api.get('/downloads', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.json({ files: listDownloads() });
});

api.get('/config', (_req, res) => {
  res.json({
    max_upload_bytes: config.maxUploadBytes,
    registration_open: registrationMode() !== 'closed',
    registration: registrationMode(),
    dev_otp: config.otpMode === 'dev',
    ice_servers: currentIceServers(),
  });
});

// everything below needs a session
api.use(requireAuth);
api.use('/admin', admin);
api.use('/bots', botsRouter);
api.use(features);
api.use(pushRouter);
api.use(safety);

// ------------------------------------------------------------------ profile

/** Live profile propagation: contacts / group mates get the new public profile, own devices the full one. */
function broadcastProfile(userId) {
  const u = getUser(userId);
  if (!u) return;
  const mates = q.all(
    `SELECT DISTINCT m2.user_id AS id FROM members m1 JOIN members m2 ON m2.chat_id = m1.chat_id AND m2.user_id != m1.user_id
     WHERE m1.user_id = ? AND m1.banned = 0 AND m2.banned = 0`, userId,
  ).map((r) => r.id);
  for (const viewer of mates) emit([viewer], { type: EVENTS.PRESENCE, user: publicUser(u, viewer) });
  emit([userId], { type: EVENTS.ME_UPDATE, user: selfUser(u) });
}

api.get('/me', (req, res) => res.json({ user: selfUser(req.user) }));

api.post('/me/password', (req, res) => {
  const me = getUser(req.user.id);
  if (!rateLimit(`setpw:${me.id}`, 10, 600_000)) throw new HttpError(429, 'too_many_requests');
  if (me.pw_hash && !verifyPassword(String(req.body?.current_password ?? ''), me.pw_hash)) throw new HttpError(403, 'wrong_password');
  const next = goodPassword(req.body?.new_password);
  let username = me.username;
  if (!username) {
    username = String(req.body?.username ?? '').replace(/^@/, '').trim();
    if (!LOGIN_RE.test(username)) throw new HttpError(400, 'invalid_username');
    if (q.get('SELECT 1 AS x FROM users WHERE username = ? COLLATE NOCASE AND id != ?', username, me.id)) throw new HttpError(409, 'username_taken');
    q.run('UPDATE users SET username = ? WHERE id = ?', username, me.id);
  }
  q.run('UPDATE users SET pw_hash = ? WHERE id = ?', hashPassword(next), me.id);
  aud(req, 'auth.password_set');
  res.json({ user: selfUser(getUser(me.id)) });
});

api.patch('/me', (req, res) => {
  const b = req.body || {};
  const sets = [];
  const vals = [];
  const put = (col, v) => { sets.push(`${col} = ?`); vals.push(v); };
  if (b.name !== undefined) put('name', str(b.name, 'name', { min: 1, max: LIMITS.NAME_MAX }));
  if (b.bio !== undefined) put('bio', str(b.bio, 'bio', { max: LIMITS.BIO_MAX }));
  if (b.status !== undefined) put('status', str(b.status, 'status', { max: LIMITS.STATUS_MAX }));
  if (b.birthday !== undefined) {
    const v = String(b.birthday || '').trim();
    if (!v) put('birthday', null);
    else {
      const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
      const noYear = /^--(\d{2})-(\d{2})$/.exec(v);
      const valid = (y, mo, d) => {
        const dt = new Date(Date.UTC(y || 2000, mo - 1, d));
        return dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d && (!y || (y >= 1900 && dt.getTime() <= Date.now()));
      };
      if (full && valid(Number(full[1]), Number(full[2]), Number(full[3]))) put('birthday', v);
      else if (noYear && valid(0, Number(noYear[1]), Number(noYear[2]))) put('birthday', v);
      else throw new HttpError(400, 'invalid_birthday');
    }
  }
  if (b.username !== undefined) {
    const u = str(b.username || '', 'username', { max: LIMITS.USERNAME_MAX }).replace(/^@/, '');
    if (u && !/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(u)) throw new HttpError(400, 'invalid_username');
    put('username', u || null);
  }
  const priv = b.privacy || {};
  for (const f of ['photo', 'status', 'last_seen', 'birthday']) {
    if (priv[f] !== undefined) put(`privacy_${f}`, oneOf(priv[f], `privacy.${f}`, PRIVACY_VALUES));
  }
  if (sets.length) {
    try {
      q.run(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, ...vals, req.user.id);
      const after = getUser(req.user.id);
      const changed = {};
      for (const col of ['name', 'bio', 'status', 'username', 'birthday', 'privacy_photo', 'privacy_status', 'privacy_last_seen', 'privacy_birthday']) {
        if (after[col] !== req.user[col]) changed[col] = [req.user[col], after[col]];
      }
      if (Object.keys(changed).length) aud(req, 'profile.update', { target_type: 'user', target_id: req.user.id, details: { changed } });
    } catch (e) {
      if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'username_taken');
      throw e;
    }
  }
  broadcastProfile(req.user.id);
  res.json({ user: selfUser(getUser(req.user.id)) });
});

api.post('/me/email', async (req, res) => {
  if (!emailEnabled()) throw new HttpError(404, 'email_disabled');
  const email = normalizeEmail(req.body?.email);
  if (q.get('SELECT 1 AS x FROM users WHERE email = ? AND id != ?', email, req.user.id)) throw new HttpError(409, 'email_taken');
  if (!rateLimit(`mail-link:${req.user.id}`, 5, 600_000)) throw new HttpError(429, 'too_many_requests');
  await issueCode(email, `link:${req.user.id}`);
  res.json({ ok: true, ttl: 600 });
});

api.post('/me/email/verify', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const code = str(req.body?.code, 'code', { min: 6, max: 6 });
  checkCode(email, `link:${req.user.id}`, code);
  try {
    q.run('UPDATE users SET email = ?, email_verified_at = ? WHERE id = ?', email, now(), req.user.id);
  } catch (e) {
    if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'email_taken');
    throw e;
  }
  aud(req, 'profile.email_linked', { target_type: 'user', target_id: req.user.id });
  res.json({ user: selfUser(getUser(req.user.id)) });
});

api.delete('/me/email', (req, res) => {
  if (req.user.phone?.startsWith('email:')) throw new HttpError(400, 'last_login_method');
  q.run('UPDATE users SET email = NULL, email_verified_at = NULL WHERE id = ?', req.user.id);
  res.json({ user: selfUser(getUser(req.user.id)) });
});

api.post('/me/avatar', async (req, res) => {
  if (!rateLimit(`avatar:${req.user.id}`, 10, 600_000)) throw new HttpError(429, 'too_many_requests');
  if (q.get('SELECT COUNT(*) AS n FROM profile_photos WHERE user_id = ?', req.user.id).n >= 60) throw new HttpError(400, 'too_many_photos');
  const id = rid(16);
  const dest = filePath(id);
  const size = await receive(req, dest, 5 * 1024 * 1024);
  const type = sniff(readHead(dest));
  if (!type || type.kind !== 'image') {
    removeFile(id);
    throw new HttpError(415, 'image_required');
  }
  q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)',
    id, req.user.id, 'avatar', type.mime, size, now());
  q.run('INSERT INTO profile_photos (user_id, file_id, created_at) VALUES (?, ?, ?)', req.user.id, id, now());
  q.run('UPDATE users SET avatar_file = ? WHERE id = ?', id, req.user.id);
  aud(req, 'profile.avatar_set', { target_type: 'file', target_id: id, details: { size } });
  broadcastProfile(req.user.id);
  res.json({ user: selfUser(getUser(req.user.id)) });
});

/** Remove a photo from the album; if it was the current one, the previous photo becomes the avatar. */
function dropPhoto(userId, photo) {
  q.run('DELETE FROM profile_photos WHERE id = ?', photo.id);
  const still = q.get('SELECT 1 AS x FROM profile_photos WHERE file_id = ?', photo.file_id);
  if (!still) { q.run('DELETE FROM files WHERE id = ?', photo.file_id); removeFile(photo.file_id); }
  const u = getUser(userId);
  if (u.avatar_file === photo.file_id) {
    const prev = q.get('SELECT file_id FROM profile_photos WHERE user_id = ? ORDER BY id DESC LIMIT 1', userId);
    q.run('UPDATE users SET avatar_file = ? WHERE id = ?', prev?.file_id ?? null, userId);
  }
  broadcastProfile(userId);
}

api.delete('/me/avatar', (req, res) => {
  aud(req, 'profile.avatar_remove');
  const cur = req.user.avatar_file;
  const photo = cur ? q.get('SELECT * FROM profile_photos WHERE user_id = ? AND file_id = ? ORDER BY id DESC', req.user.id, cur) : null;
  if (photo) dropPhoto(req.user.id, photo);
  else { q.run('UPDATE users SET avatar_file = NULL WHERE id = ?', req.user.id); broadcastProfile(req.user.id); }
  res.json({ user: selfUser(getUser(req.user.id)) });
});

api.get('/users/:id/photos', (req, res) => {
  const u = getUser(int(req.params.id, 'id'));
  if (!u) throw new HttpError(404, 'not_found');
  const visible = u.id === req.user.id || !!publicUser(u, req.user.id).avatar;
  const rows = visible ? q.all('SELECT id, file_id, created_at FROM profile_photos WHERE user_id = ? ORDER BY id DESC LIMIT 60', u.id) : [];
  res.json({ photos: rows.map((r) => ({ id: r.id, url: `/api/photos/${r.id}`, created_at: r.created_at, current: r.file_id === u.avatar_file })) });
});

api.get('/photos/:id', (req, res) => {
  const p = q.get('SELECT * FROM profile_photos WHERE id = ?', int(req.params.id, 'id'));
  const owner = p ? getUser(p.user_id) : null;
  if (!p || !owner || (owner.id !== req.user.id && !publicUser(owner, req.user.id).avatar)) throw new HttpError(404, 'not_found');
  const f = q.get('SELECT * FROM files WHERE id = ?', p.file_id);
  if (!f) throw new HttpError(404, 'not_found');
  sendFile(res, f);
});

api.post('/me/photos/:id/main', (req, res) => {
  const p = q.get('SELECT * FROM profile_photos WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!p) throw new HttpError(404, 'not_found');
  q.run('UPDATE users SET avatar_file = ? WHERE id = ?', p.file_id, req.user.id);
  broadcastProfile(req.user.id);
  res.json({ user: selfUser(getUser(req.user.id)) });
});

api.delete('/me/photos/:id', (req, res) => {
  const p = q.get('SELECT * FROM profile_photos WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!p) throw new HttpError(404, 'not_found');
  dropPhoto(req.user.id, p);
  res.json({ user: selfUser(getUser(req.user.id)) });
});

api.get('/users/:id/avatar', (req, res) => {
  const u = getUser(int(req.params.id, 'id'));
  const pu = u && publicUser(u, req.user.id);
  if (!pu?.avatar) throw new HttpError(404, 'not_found');
  const f = q.get('SELECT * FROM files WHERE id = ?', u.avatar_file);
  if (!f) throw new HttpError(404, 'not_found');
  sendFile(res, f);
});

api.get('/users/search', (req, res) => {
  if (!rateLimit(`usearch:${req.user.id}`, 40, 60_000)) throw new HttpError(429, 'too_many_requests');
  const term = str(String(req.query.q ?? ''), 'q', { min: 2, max: 64 }).replace(/^@/, '');
  const like = `${escapeLike(term)}%`;
  const rows = q.all(
    `SELECT * FROM users u
     WHERE u.id != ? AND (u.username LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.phone = ?)
       AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = u.id AND b.blocked_id = ?)
     ORDER BY (u.username = ? COLLATE NOCASE) DESC, u.name LIMIT 20`,
    req.user.id, like, `%${escapeLike(term)}%`, /^\+?\d{8,15}$/.test(term) ? (term.startsWith('+') ? term : `+${term}`) : '',
    req.user.id, term,
  );
  res.json({ users: rows.map((u) => publicUser(u, req.user.id)) });
});

api.get('/users/:id', (req, res) => {
  const u = getUser(int(req.params.id, 'id'));
  if (!u) throw new HttpError(404, 'not_found');
  res.json({
    user: publicUser(u, req.user.id),
    blocked: !!q.get('SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?', req.user.id, u.id),
  });
});

// ------------------------------------------------------------------ blocks & sessions

api.get('/blocks', (req, res) => {
  const rows = q.all('SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.user_id = ?', req.user.id);
  res.json({ users: rows.map((u) => publicUser(u, req.user.id)) });
});

function notifyDirect(userA, userB) {
  const c = q.get('SELECT id FROM chats WHERE direct_key = ?', directKey(userA, userB));
  if (!c) return;
  for (const uid of [userA, userB]) emit([uid], { type: EVENTS.CHAT_UPDATE, chat: chatOut(c.id, uid) });
}

api.post('/blocks/:id', (req, res) => {
  const id = int(req.params.id, 'id');
  if (id === req.user.id || !getUser(id)) throw new HttpError(400, 'invalid_input');
  q.run('INSERT OR IGNORE INTO blocks (user_id, blocked_id, created_at) VALUES (?, ?, ?)', req.user.id, id, now());
  aud(req, 'user.block', { target_type: 'user', target_id: id });
  notifyDirect(req.user.id, id);
  res.json({ ok: true });
});

api.delete('/blocks/:id', (req, res) => {
  const id = int(req.params.id, 'id');
  q.run('DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?', req.user.id, id);
  aud(req, 'user.unblock', { target_type: 'user', target_id: id });
  notifyDirect(req.user.id, id);
  res.json({ ok: true });
});

api.get('/sessions', (req, res) => {
  const rows = q.all('SELECT * FROM sessions WHERE user_id = ? AND revoked = 0 ORDER BY last_active DESC', req.user.id);
  res.json({
    sessions: rows.map((s) => ({
      id: s.id, device: s.device, ip: s.ip, created_at: s.created_at, last_active: s.last_active,
      current: s.id === req.session.id,
    })),
  });
});

api.delete('/sessions/:id', (req, res) => {
  const id = int(req.params.id, 'id');
  const s = q.get('SELECT * FROM sessions WHERE id = ? AND user_id = ?', id, req.user.id);
  if (!s) throw new HttpError(404, 'not_found');
  q.run('UPDATE sessions SET revoked = 1 WHERE id = ?', id);
  dropSession(id);
  aud(req, 'session.revoke', { target_type: 'session', target_id: id });
  res.json({ ok: true });
});

api.delete('/sessions', (req, res) => {
  const rows = q.all('SELECT id FROM sessions WHERE user_id = ? AND revoked = 0 AND id != ?', req.user.id, req.session.id);
  q.run('UPDATE sessions SET revoked = 1 WHERE user_id = ? AND id != ?', req.user.id, req.session.id);
  rows.forEach((r) => dropSession(r.id));
  res.json({ ok: true });
});

// ------------------------------------------------------------------ chats

const pushChat = (chatId, ids = memberIds(chatId)) => {
  for (const uid of ids) emit([uid], { type: EVENTS.CHAT_UPDATE, chat: chatOut(chatId, uid) });
};

wireBots({ postMessage, pushChat });
wireNotify({ postMessage, pushChat });
wireFeatures({ postMessage });

api.get('/chats', (req, res) => res.json({ chats: listChats(req.user.id) }));

api.get('/gcalls', (req, res) => res.json({ rooms: activeGroupCalls(req.user.id) }));

api.get('/calls', (req, res) => {
  res.json({ calls: recentCalls(req.user.id).map(messageOut) });
});

api.post('/chats/saved', (req, res) => {
  const key = directKey(req.user.id, req.user.id);
  let c = q.get('SELECT id FROM chats WHERE direct_key = ?', key);
  if (!c) {
    const id = tx(() => {
      const r = q.run("INSERT INTO chats (type, direct_key, last_message_at, created_at) VALUES ('direct', ?, ?, ?)", key, now(), now());
      const cid = Number(r.lastInsertRowid);
      q.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", cid, req.user.id, now());
      return cid;
    });
    c = { id };
  }
  res.json({ chat: chatOut(c.id, req.user.id) });
});

api.post('/chats/direct', (req, res) => {
  const peer = int(req.body?.user_id, 'user_id');
  if (peer === req.user.id || !getUser(peer)) throw new HttpError(400, 'invalid_input');
  const key = directKey(req.user.id, peer);
  let c = q.get('SELECT id FROM chats WHERE direct_key = ?', key);
  if (!c) {
    if (isBlockedEitherWay(req.user.id, peer) && q.get('SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?', peer, req.user.id)) {
      throw new HttpError(403, 'blocked');
    }
    const id = tx(() => {
      const r = q.run(
        "INSERT INTO chats (type, direct_key, last_message_at, created_at) VALUES ('direct', ?, ?, ?)", key, now(), now(),
      );
      const cid = Number(r.lastInsertRowid);
      for (const uid of [req.user.id, peer]) {
        q.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", cid, uid, now());
      }
      return cid;
    });
    c = { id };
    aud(req, 'chat.create', { chat_id: id, target_type: 'chat', target_id: id, details: { type: 'direct', with: peer } });
  }
  res.json({ chat: chatOut(c.id, req.user.id) });
});

api.post('/chats', (req, res) => {
  const b = req.body || {};
  const type = oneOf(b.type, 'type', CHAT_TYPES.filter((t) => t !== 'direct'));
  const title = str(b.title, 'title', { min: 1, max: LIMITS.TITLE_MAX });
  const description = str(b.description ?? '', 'description', { max: LIMITS.DESCRIPTION_MAX });
  const ids = Array.isArray(b.member_ids) ? [...new Set(b.member_ids.map((x) => int(x, 'member_ids')))] : [];
  if (ids.length > LIMITS.GROUP_MAX_MEMBERS) throw new HttpError(400, 'too_many_members');
  if (!rateLimit(`mkchat:${req.user.id}`, config.maxChatsPerHour, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const chatId = tx(() => {
    const r = q.run(
      'INSERT INTO chats (type, title, description, owner_id, invite_code, last_message_at, created_at) VALUES (?,?,?,?,?,?,?)',
      type, title, description, req.user.id, rid(9), now(), now(),
    );
    const cid = Number(r.lastInsertRowid);
    q.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'owner', ?)", cid, req.user.id, now());
    for (const uid of ids) {
      if (uid === req.user.id || !getUser(uid) || isBlockedEitherWay(req.user.id, uid)) continue;
      q.run("INSERT OR IGNORE INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", cid, uid, now());
    }
    return cid;
  });
  aud(req, 'chat.create', { chat_id: chatId, target_type: 'chat', target_id: chatId, details: { type, title, members: ids } });
  pushChat(chatId);
  res.status(201).json({ chat: chatOut(chatId, req.user.id) });
});

api.get('/chats/:id', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const rows = q.all(
    `SELECT m.role, m.can_send, m.banned, u.* FROM members m JOIN users u ON u.id = m.user_id
     WHERE m.chat_id = ? ${isAdmin(me) ? '' : 'AND m.banned = 0'} ORDER BY m.joined_at LIMIT 1000`,
    id,
  );
  res.json({
    chat: chatOut(id, req.user.id),
    members: rows.map((r) => ({
      user: publicUser(r, req.user.id), role: r.role, can_send: !!r.can_send, banned: !!r.banned,
    })),
  });
});

api.patch('/chats/:id', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (c.type === 'direct' || !isAdmin(me)) throw new HttpError(403, 'forbidden');
  const b = req.body || {};
  aud(req, 'chat.update', { chat_id: id, target_type: 'chat', target_id: id, details: { before: { title: c.title, description: c.description }, after: { title: b.title, description: b.description } } });
  if (b.title !== undefined) q.run('UPDATE chats SET title = ? WHERE id = ?', str(b.title, 'title', { min: 1, max: LIMITS.TITLE_MAX }), id);
  if (b.description !== undefined) q.run('UPDATE chats SET description = ? WHERE id = ?', str(b.description, 'description', { max: LIMITS.DESCRIPTION_MAX }), id);
  pushChat(id);
  res.json({ chat: chatOut(id, req.user.id) });
});

// per-user chat settings: mute, draft
api.patch('/chats/:id/me', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const b = req.body || {};
  if (b.muted !== undefined) q.run('UPDATE members SET muted = ? WHERE chat_id = ? AND user_id = ?', b.muted ? 1 : 0, id, req.user.id);
  if (b.muted_until !== undefined) {
    const until = Number(b.muted_until);
    if (!Number.isFinite(until) || until < 0 || until > Date.now() + 400 * 86400_000) throw new HttpError(400, 'invalid_input', 'muted_until invalid');
    q.run('UPDATE members SET muted_until = ? WHERE chat_id = ? AND user_id = ?', Math.round(until), id, req.user.id);
  }
  if (b.archived !== undefined) q.run('UPDATE members SET archived = ? WHERE chat_id = ? AND user_id = ?', b.archived ? 1 : 0, id, req.user.id);
  if (b.draft !== undefined) {
    q.run('UPDATE members SET draft = ? WHERE chat_id = ? AND user_id = ?', str(b.draft, 'draft', { max: LIMITS.DRAFT_MAX }), id, req.user.id);
  }
  const chat = chatOut(id, req.user.id);
  emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat });
  res.json({ chat });
});

api.post('/chats/:id/clear', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const last = q.get('SELECT last_message_id AS n FROM chats WHERE id = ?', id)?.n || 0;
  q.run('UPDATE members SET cleared_before = ?, last_read_id = MAX(last_read_id, ?) WHERE chat_id = ? AND user_id = ?', last, last, id, req.user.id);
  aud(req, 'chat.clear_history', { chat_id: id, details: { up_to: last } });
  const chat = chatOut(id, req.user.id);
  emit([req.user.id], { type: EVENTS.CHAT_UPDATE, chat });
  res.json({ chat });
});

// "Delete chat" for a private chat: clears your copy and hides it until a new message arrives.
api.post('/chats/:id/hide', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const c = q.get('SELECT type FROM chats WHERE id = ?', id);
  if (c?.type !== 'direct') throw new HttpError(400, 'invalid_input', 'use leave for groups and channels');
  const last = q.get('SELECT last_message_id AS n FROM chats WHERE id = ?', id)?.n || 0;
  q.run('UPDATE members SET cleared_before = ?, last_read_id = MAX(last_read_id, ?), hidden = 1 WHERE chat_id = ? AND user_id = ?', last, last, id, req.user.id);
  aud(req, 'chat.delete_for_me', { chat_id: id });
  emit([req.user.id], { type: EVENTS.CHAT_REMOVE, chat_id: id });
  res.json({ ok: true });
});

api.post('/chats/:id/members', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (c.type === 'direct' || !isAdmin(me)) throw new HttpError(403, 'forbidden');
  const uid = int(req.body?.user_id, 'user_id');
  if (!getUser(uid)) throw new HttpError(404, 'not_found');
  if (isBlockedEitherWay(req.user.id, uid)) throw new HttpError(403, 'blocked');
  const ex = q.get('SELECT banned FROM members WHERE chat_id = ? AND user_id = ?', id, uid);
  if (ex?.banned) throw new HttpError(403, 'user_banned');
  if (memberIds(id).length >= LIMITS.GROUP_MAX_MEMBERS) throw new HttpError(400, 'too_many_members');
  q.run("INSERT OR IGNORE INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", id, uid, now());
  aud(req, 'chat.member_add', { chat_id: id, target_type: 'user', target_id: uid });
  pushChat(id);
  res.json({ ok: true });
});

api.patch('/chats/:id/members/:uid', (req, res) => {
  const id = int(req.params.id, 'id');
  const uid = int(req.params.uid, 'uid');
  const me = requireMember(id, req.user.id);
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  const target = q.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ?', id, uid);
  if (c.type === 'direct' || !target || !isAdmin(me)) throw new HttpError(403, 'forbidden');
  if (target.role === 'owner' || uid === req.user.id) throw new HttpError(403, 'forbidden');
  if (target.role === 'admin' && me.role !== 'owner') throw new HttpError(403, 'forbidden');
  const b = req.body || {};
  aud(req, 'chat.member_update', { chat_id: id, target_type: 'user', target_id: uid, details: { role: b.role, can_send: b.can_send, banned: b.banned } });
  if (b.role !== undefined) {
    if (me.role !== 'owner') throw new HttpError(403, 'forbidden');
    q.run('UPDATE members SET role = ? WHERE chat_id = ? AND user_id = ?', oneOf(b.role, 'role', ['admin', 'member']), id, uid);
  }
  if (b.can_send !== undefined) q.run('UPDATE members SET can_send = ? WHERE chat_id = ? AND user_id = ?', b.can_send ? 1 : 0, id, uid);
  if (b.banned === false && target.banned) {
    q.run('DELETE FROM members WHERE chat_id = ? AND user_id = ?', id, uid); // unban = may rejoin by link
  }
  pushChat(id, [...memberIds(id)]);
  res.json({ ok: true });
});

function removeMember(chatId, uid, ban) {
  if (ban) q.run('UPDATE members SET banned = 1 WHERE chat_id = ? AND user_id = ?', chatId, uid);
  else q.run('DELETE FROM members WHERE chat_id = ? AND user_id = ?', chatId, uid);
  emit([uid], { type: EVENTS.CHAT_REMOVE, chat_id: chatId });
}

api.delete('/chats/:id/members/:uid', (req, res) => {
  const id = int(req.params.id, 'id');
  const uid = int(req.params.uid, 'uid');
  const me = requireMember(id, req.user.id);
  const c = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (c.type === 'direct') throw new HttpError(400, 'invalid_input');
  const ban = req.query.ban === '1';
  aud(req, uid === req.user.id ? 'chat.leave' : 'chat.member_remove', { chat_id: id, target_type: 'user', target_id: uid, details: { ban } });
  if (uid === req.user.id) {
    // leaving
    removeMember(id, uid, false);
    if (me.role === 'owner') {
      const next = q.get(
        `SELECT user_id FROM members WHERE chat_id = ? AND banned = 0
         ORDER BY CASE role WHEN 'admin' THEN 0 ELSE 1 END, joined_at LIMIT 1`, id,
      );
      if (next) {
        q.run("UPDATE members SET role = 'owner' WHERE chat_id = ? AND user_id = ?", id, next.user_id);
        q.run('UPDATE chats SET owner_id = ? WHERE id = ?', next.user_id, id);
      } else {
        q.run('DELETE FROM chats WHERE id = ?', id);
        return res.json({ ok: true });
      }
    }
  } else {
    const target = q.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ?', id, uid);
    if (!target || !isAdmin(me) || target.role === 'owner' || (target.role === 'admin' && me.role !== 'owner')) {
      throw new HttpError(403, 'forbidden');
    }
    removeMember(id, uid, ban);
  }
  pushChat(id);
  res.json({ ok: true });
});

api.post('/chats/:id/invite/reset', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  if (!isAdmin(me)) throw new HttpError(403, 'forbidden');
  q.run('UPDATE chats SET invite_code = ? WHERE id = ? AND type != ?', rid(9), id, 'direct');
  aud(req, 'chat.invite_reset', { chat_id: id, target_type: 'chat', target_id: id });
  pushChat(id, [req.user.id]);
  res.json({ chat: chatOut(id, req.user.id) });
});

api.get('/invite/:code', (req, res) => {
  const c = q.get("SELECT * FROM chats WHERE invite_code = ? AND type != 'direct'", str(req.params.code, 'code', { min: 4, max: 40 }));
  if (!c) throw new HttpError(404, 'not_found');
  const mine = q.get('SELECT banned FROM members WHERE chat_id = ? AND user_id = ?', c.id, req.user.id);
  res.json({
    chat: { id: c.id, type: c.type, title: c.title, description: c.description, members_count: memberIds(c.id).length },
    already_member: !!mine && !mine.banned,
    banned: !!mine?.banned,
  });
});

api.post('/invite/:code/join', (req, res) => {
  const c = q.get("SELECT * FROM chats WHERE invite_code = ? AND type != 'direct'", str(req.params.code, 'code', { min: 4, max: 40 }));
  if (!c) throw new HttpError(404, 'not_found');
  const mine = q.get('SELECT banned FROM members WHERE chat_id = ? AND user_id = ?', c.id, req.user.id);
  if (mine?.banned) throw new HttpError(403, 'user_banned');
  if (!mine) {
    if (memberIds(c.id).length >= LIMITS.GROUP_MAX_MEMBERS) throw new HttpError(400, 'too_many_members');
    q.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", c.id, req.user.id, now());
    aud(req, 'chat.join_by_link', { chat_id: c.id, target_type: 'chat', target_id: c.id });
    pushChat(c.id);
  }
  res.json({ chat: chatOut(c.id, req.user.id) });
});

// ------------------------------------------------------------------ messages

api.get('/chats/:id/messages', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const limit = int(req.query.limit, 'limit', { min: 1, max: 100, optional: true }) ?? LIMITS.PAGE_SIZE;
  const before = int(req.query.before, 'before', { optional: true });
  const after = int(req.query.after, 'after', { optional: true });
  let rows;
  let hasMore = false;
  const floor = Math.max(0, requireMember(id, req.user.id).cleared_before || 0); // "clear history" watermark
  if (after !== undefined) {
    rows = q.all('SELECT * FROM messages WHERE chat_id = ? AND id > ? ORDER BY id ASC LIMIT ?', id, Math.max(after, floor), limit + 1);
    hasMore = rows.length > limit;
    rows = rows.slice(0, limit);
  } else {
    rows = q.all(
      'SELECT * FROM messages WHERE chat_id = ? AND id < ? AND id > ? ORDER BY id DESC LIMIT ?', id, before ?? Number.MAX_SAFE_INTEGER, floor, limit + 1,
    );
    hasMore = rows.length > limit;
    rows = rows.slice(0, limit).reverse();
  }
  res.json({ messages: rows.map(messageOut), has_more: hasMore });
});

function assertCanPost(chat, me, userId) {
  if (chat.type === 'channel' && me.role === 'member') throw new HttpError(403, 'channel_readonly');
  if (me.role === 'member' && !me.can_send) throw new HttpError(403, 'restricted');
  if (chat.type === 'direct') {
    const peer = directPeerId(chat.id, userId);
    if (isBlockedEitherWay(userId, peer)) throw new HttpError(403, 'blocked');
  }
}

/** Insert + fan out one message. Idempotent on (chat, sender, client_id). */
export function postMessage({ chat, user, text = '', kind = 'text', fileId = null, duration = null, replyTo = null, forwardFrom = null, clientId = null, waveform = null, markup = null, silent = false }) {
  if (clientId) {
    const dup = q.get('SELECT * FROM messages WHERE chat_id = ? AND sender_id = ? AND client_id = ?', chat.id, user.id, clientId);
    if (dup) return { message: messageOut(dup), duplicate: true };
  }
  if (replyTo && !q.get('SELECT 1 AS x FROM messages WHERE id = ? AND chat_id = ?', replyTo, chat.id)) replyTo = null;
  const t = now();
  const r = q.run(
    `INSERT INTO messages (chat_id, sender_id, client_id, kind, text, reply_to, forward_from, file_id, duration, waveform, markup, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    chat.id, user.id, clientId, kind, text, replyTo, forwardFrom, fileId, duration, waveform, markup, t,
  );
  const id = Number(r.lastInsertRowid);
  q.run('UPDATE chats SET last_message_id = ?, last_message_at = ? WHERE id = ?', id, t, chat.id);
  q.run('UPDATE members SET hidden = 0 WHERE chat_id = ? AND hidden = 1', chat.id); // a deleted chat comes back with a new message
  q.run(
    'UPDATE members SET last_read_id = ?, last_delivered_id = ?, draft = ? WHERE chat_id = ? AND user_id = ?',
    id, id, '', chat.id, user.id,
  );
  const message = messageOut(getMessage(id));
  audit(user.id, 'message.send', {
    chat_id: chat.id, target_type: 'message', target_id: id,
    details: { kind, reply_to: replyTo, forwarded_from: forwardFrom, file: message.file ? { id: message.file.id, name: message.file.name, size: message.file.size, mime: message.file.mime } : null, length: text.length },
  });
  const ids = memberIds(chat.id);
  // "send without sound": the flag only travels with the live event, nobody is notified or beeped
  emit(ids, { type: EVENTS.MESSAGE_NEW, message: silent ? { ...message, silent: true } : message });
  // recipients with a live socket have received it: advance their delivered marker
  for (const uid of ids) {
    if (uid === user.id || !isOnline(uid)) continue;
    q.run('UPDATE members SET last_delivered_id = MAX(last_delivered_id, ?) WHERE chat_id = ? AND user_id = ?', id, chat.id, uid);
    emit([user.id], { type: EVENTS.DELIVERED, chat_id: chat.id, user_id: uid, message_id: id });
  }
  try { notifyBots(chat, getMessage(id)); } catch (e) { log('error', 'notifyBots', { err: e.message }); }
  try { handleFatherMessage(chat, getMessage(id)); } catch (e) { log('error', 'botfather', { err: e.message }); }
  if (!silent) { try { pushNewMessage(chat, getMessage(id)); } catch (e) { log('error', 'push', { err: e.message }); } }
  try { checkSpam(user, chat, text); } catch (e) { log('error', 'spam', { err: e.message }); }
  return { message, duplicate: false };
}

api.post('/chats/:id/messages', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  assertCanPost(chat, me, req.user.id);
  if (!rateLimit(`msg:${req.user.id}`, 30, 10_000)) throw new HttpError(429, 'slow_down');
  const b = req.body || {};
  const clientId = b.client_id !== undefined ? str(b.client_id, 'client_id', { min: 8, max: 64 }) : null;
  const replyTo = int(b.reply_to, 'reply_to', { optional: true }) ?? null;
  let text;
  let kind = 'text';
  let fileId = null;
  let duration = null;
  let forwardFrom = null;
  if (b.forward_of !== undefined) {
    const src = getMessage(int(b.forward_of, 'forward_of'));
    if (!src || !membership(src.chat_id, req.user.id)) throw new HttpError(404, 'not_found');
    if (isSecretChat(src.chat_id) || isSecretChat(chat.id)) throw new HttpError(403, 'secret_no_forward');
    const sender = src.sender_id ? getUser(src.sender_id)?.name : null;
    text = src.text;
    kind = src.kind === 'poll' ? 'text' : src.kind;
    fileId = src.file_id;
    duration = src.duration;
    forwardFrom = src.forward_from || sender || '';
  } else {
    text = str(b.text, 'text', { min: 1, max: LIMITS.TEXT_MAX * 2 });
    if (isSecretChat(chat.id)) {
      // end-to-end encrypted chat: only ciphertext envelopes are accepted
      if (b.kind !== 'secret') throw new HttpError(400, 'secret_requires_encryption');
      if (!q.get('SELECT peer_pub FROM secret_chats WHERE chat_id = ?', chat.id)?.peer_pub) throw new HttpError(409, 'secret_not_ready');
      text = checkEnvelope(text);
      kind = 'secret';
    } else if (b.kind === 'secret') {
      throw new HttpError(400, 'invalid_input');
    } else if (b.kind === 'location') {
      const g = /^geo:(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/.exec(text);
      if (!g || Math.abs(Number(g[1])) > 90 || Math.abs(Number(g[2])) > 180) throw new HttpError(400, 'invalid_input');
      kind = 'location';
    } else if (b.kind === 'contact') {
      let c;
      try { c = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_input'); }
      const name = String(c?.name ?? '').trim().slice(0, 64);
      const phone = String(c?.phone ?? '').trim();
      if (!name || (phone && !/^\+?[\d\s().-]{5,20}$/.test(phone))) throw new HttpError(400, 'invalid_input');
      const uid = Number.isInteger(c?.user_id) && getUser(c.user_id) ? c.user_id : null;
      // somebody else's number is never revealed here: a shared Suhbat-dosh user carries only the name and id
      const own = uid === req.user.id;
      text = JSON.stringify({ name, ...(phone && (!uid || own) ? { phone } : {}), ...(uid ? { user_id: uid } : {}) });
      kind = 'contact';
    }
  }
  const out = postMessage({ chat, user: req.user, text, kind, fileId, duration, replyTo, forwardFrom, clientId, silent: b.silent === true });
  res.status(out.duplicate ? 200 : 201).json({ message: out.message, duplicate: out.duplicate });
});

// ------------------------------------------------------------------ secret (end-to-end encrypted) chats
const PUB_RE = /^[A-Za-z0-9+/=_-]{80,140}$/;
const isSecretChat = (chatId) => !!q.get('SELECT 1 AS x FROM secret_chats WHERE chat_id = ?', chatId);

/** The text of an encrypted message is an envelope {v:1, iv, ct}; the server cannot read it, only check its shape. */
function checkEnvelope(text) {
  let e;
  try { e = JSON.parse(text); } catch { throw new HttpError(400, 'invalid_input'); }
  if (e?.v !== 1 || typeof e.iv !== 'string' || typeof e.ct !== 'string' || e.iv.length > 40 || e.ct.length > LIMITS.TEXT_MAX * 2) throw new HttpError(400, 'invalid_input');
  return JSON.stringify({ v: 1, iv: e.iv, ct: e.ct });
}

api.post('/secret/start', (req, res) => {
  const peer = int(req.body?.user_id, 'user_id');
  const pub = String(req.body?.pub ?? '');
  if (!PUB_RE.test(pub)) throw new HttpError(400, 'invalid_input');
  const peerUser = getUser(peer);
  if (peer === req.user.id || !peerUser || peerUser.is_bot) throw new HttpError(400, 'invalid_input');
  if (isBlockedEitherWay(req.user.id, peer)) throw new HttpError(403, 'blocked');
  if (!rateLimit(`secretstart:${req.user.id}`, 20, 3600_000)) throw new HttpError(429, 'too_many_requests');
  const id = tx(() => {
    const key = `s:${Math.min(req.user.id, peer)}:${Math.max(req.user.id, peer)}:${rid(6)}`;
    const r = q.run("INSERT INTO chats (type, direct_key, last_message_at, created_at) VALUES ('direct', ?, ?, ?)", key, now(), now());
    const cid = Number(r.lastInsertRowid);
    for (const uid of [req.user.id, peer]) q.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", cid, uid, now());
    q.run('INSERT INTO secret_chats (chat_id, initiator_id, peer_id, init_pub, created_at) VALUES (?,?,?,?,?)', cid, req.user.id, peer, pub, now());
    return cid;
  });
  aud(req, 'chat.create', { chat_id: id, target_type: 'chat', target_id: id, details: { type: 'secret', with: peer } });
  pushChat(id);
  res.status(201).json({ chat: chatOut(id, req.user.id) });
});

api.post('/secret/:id/accept', (req, res) => {
  const id = int(req.params.id, 'id');
  const sc = q.get('SELECT * FROM secret_chats WHERE chat_id = ?', id);
  const pub = String(req.body?.pub ?? '');
  if (!sc || sc.peer_id !== req.user.id) throw new HttpError(404, 'not_found');
  if (sc.peer_pub) throw new HttpError(409, 'already_accepted');
  if (!PUB_RE.test(pub)) throw new HttpError(400, 'invalid_input');
  q.run('UPDATE secret_chats SET peer_pub = ?, accepted_at = ? WHERE chat_id = ?', pub, now(), id);
  pushChat(id);
  res.json({ chat: chatOut(id, req.user.id) });
});

// ------------------------------------------------------------------ stickers and animated emoji
const ANIM_EMOJI = ['1f600', '1f602', '1f923', '1f60d', '1f970', '1f618', '1f60e', '1f914', '1f973', '1f62d', '1f621', '1f631', '1f917', '1f44d', '1f44f', '1f64f', '1f525', '2764_fe0f', '1f389', '1f4af', '2728', '1f680', '1f440', '1f64c', '1f60a', '1f609', '1f622', '1f634', '1f92f', '1f4aa', '1f648', '1f340'];
const CP_RE = /^[0-9a-f]{4,6}(_[0-9a-f]{4,6}){0,3}$/;
const animDir = path.join(config.dataDir, 'anim');
fs.mkdirSync(animDir, { recursive: true });
const animMiss = new Map(); // cp -> time of the last miss (do not hammer the source)

/** Animated emoji (Noto, CC BY 4.0) fetched once and kept on the server's disk. */
async function animEmoji(cp) {
  const file = path.join(animDir, `${cp}.json`);
  if (fs.existsSync(file)) return file;
  if (now() - (animMiss.get(cp) || 0) < 3600_000) return null;
  try {
    const r = await fetch(`https://fonts.gstatic.com/s/e/notoemoji/latest/${cp}/lottie.json`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(String(r.status));
    const txt = await r.text();
    const j = JSON.parse(txt);
    if (!Array.isArray(j.layers)) throw new Error('not lottie');
    fs.writeFileSync(file, txt);
    return file;
  } catch {
    animMiss.set(cp, now());
    return null;
  }
}

api.get('/anim/:cp', async (req, res) => {
  const cp = String(req.params.cp);
  if (!CP_RE.test(cp)) throw new HttpError(400, 'invalid_input');
  const file = await animEmoji(cp);
  if (!file) throw new HttpError(404, 'not_found');
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.type('application/json').sendFile(file, { dotfiles: 'allow' });
});

function stickerType(buf) {
  const t = sniff(buf, false);
  if (t?.kind === 'image' && /^image\/(webp|png)$/.test(t.mime)) return { mime: t.mime };
  const gz = buf[0] === 0x1f && buf[1] === 0x8b;
  let text;
  try { text = gz ? zlib.gunzipSync(buf, { maxOutputLength: 4 * 1024 * 1024 }).toString('utf8') : buf.toString('utf8'); } catch { return null; }
  try {
    const j = JSON.parse(text);
    if (j && Array.isArray(j.layers) && j.layers.length <= 400 && typeof j.fr === 'number' && j.w > 0 && j.w <= 2048 && j.h > 0 && j.h <= 2048) {
      return { mime: gz ? 'application/x-tgsticker' : 'application/json' };
    }
  } catch { /* not an animation */ }
  return null;
}

const stickerOut = (s) => {
  const f = q.get('SELECT * FROM files WHERE id = ?', s.file_id);
  return { id: s.id, emoji: s.emoji, file: f ? { id: f.id, url: `/api/files/${f.id}`, mime: f.mime, name: f.name, size: f.size } : null };
};

api.get('/stickers', (req, res) => {
  const rows = q.all('SELECT * FROM stickers WHERE user_id = ? ORDER BY id DESC LIMIT 200', req.user.id);
  res.json({ mine: rows.map(stickerOut).filter((s) => s.file), anim: ANIM_EMOJI });
});

api.post('/stickers', async (req, res) => {
  if (!rateLimit(`stk:${req.user.id}`, 30, 600_000)) throw new HttpError(429, 'slow_down');
  const chunks = [];
  let total = 0;
  const ok = await new Promise((resolve) => {
    req.on('data', (c) => { total += c.length; if (total > 1024 * 1024) { resolve(false); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(true));
    req.on('error', () => resolve(false));
  });
  if (!ok) throw new HttpError(413, 'file_too_large');
  const buf = Buffer.concat(chunks);
  const type = buf.length ? stickerType(buf) : null;
  if (!type) throw new HttpError(415, 'sticker_invalid');
  const own = q.get('SELECT COUNT(*) AS n FROM stickers WHERE user_id = ?', req.user.id).n;
  if (own >= 200) throw new HttpError(400, 'too_many_stickers');
  const fid = rid(16);
  fs.writeFileSync(filePath(fid), buf);
  const ext = type.mime === 'application/x-tgsticker' ? 'tgs' : type.mime === 'application/json' ? 'json' : type.mime.split('/')[1];
  q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', fid, req.user.id, null, `sticker.${ext}`, type.mime, buf.length, now());
  const emoji = String(req.query.emoji ?? '').slice(0, 16);
  const r = q.run('INSERT INTO stickers (user_id, file_id, emoji, created_at) VALUES (?,?,?,?)', req.user.id, fid, emoji, now());
  res.status(201).json({ sticker: stickerOut(q.get('SELECT * FROM stickers WHERE id = ?', Number(r.lastInsertRowid))) });
});

api.delete('/stickers/:id', (req, res) => {
  const s = q.get('SELECT * FROM stickers WHERE id = ? AND user_id = ?', int(req.params.id, 'id'), req.user.id);
  if (!s) throw new HttpError(404, 'not_found');
  q.run('DELETE FROM stickers WHERE id = ?', s.id);
  // the file stays while some message still shows it
  res.json({ ok: true });
});

api.post('/chats/:id/stickers', async (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  assertCanPost(chat, me, req.user.id);
  if (!rateLimit(`stkmsg:${req.user.id}`, 40, 60_000)) throw new HttpError(429, 'slow_down');
  const b = req.body || {};
  const clientId = b.client_id ? str(String(b.client_id), 'client_id', { min: 8, max: 64 }) : null;
  let fileId;
  let emoji = '';
  if (b.anim !== undefined) {
    const cp = String(b.anim);
    if (!CP_RE.test(cp)) throw new HttpError(400, 'invalid_input');
    const src = await animEmoji(cp);
    if (!src) throw new HttpError(404, 'not_found');
    let row = q.get('SELECT file_id FROM anim_files WHERE cp = ?', cp);
    if (!row || !fs.existsSync(filePath(row.file_id))) {
      const fid = rid(16);
      fs.copyFileSync(src, filePath(fid));
      q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', fid, req.user.id, null, `${cp}.json`, 'application/json', fs.statSync(src).size, now());
      q.run('INSERT INTO anim_files (cp, file_id) VALUES (?, ?) ON CONFLICT(cp) DO UPDATE SET file_id = excluded.file_id', cp, fid);
      row = { file_id: fid };
    }
    fileId = row.file_id;
    emoji = String.fromCodePoint(...cp.split('_').map((x) => parseInt(x, 16)));
  } else {
    const s = q.get('SELECT * FROM stickers WHERE id = ?', int(b.sticker_id, 'sticker_id'));
    if (!s) throw new HttpError(404, 'not_found');
    fileId = s.file_id;
    emoji = s.emoji;
  }
  const out = postMessage({ chat, user: req.user, text: emoji, kind: 'sticker', fileId, clientId });
  res.status(out.duplicate ? 200 : 201).json(out);
});

// ---- resumable chunked upload: init -> PUT chunks (sequential offsets) -> complete; a dropped connection resumes from `received`
const CHUNK_MAX = 8 * 1024 * 1024;
const partPath = (id) => path.join(config.filesDir, `.part-${id}`);
const uploadOut = (u) => ({ upload_id: u.id, size: u.size, received: (() => { try { return fs.statSync(partPath(u.id)).size; } catch { return 0; } })() });

function ownUpload(req) {
  const u = q.get('SELECT * FROM uploads WHERE id = ? AND user_id = ?', String(req.params.id), req.user.id);
  if (!u) throw new HttpError(404, 'not_found');
  return u;
}

api.post('/chats/:id/uploads', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  assertCanPost(chat, me, req.user.id);
  if (!rateLimit(`upinit:${req.user.id}`, 60, 60_000)) throw new HttpError(429, 'slow_down');
  const b = req.body || {};
  const name = checkName(str(String(b.name ?? 'file'), 'name', { min: 1, max: 200 }));
  const size = int(b.size, 'size', { min: 1, max: config.maxUploadBytes });
  const clientId = str(String(b.client_id ?? ''), 'client_id', { min: 8, max: 64 });
  const dup = q.get('SELECT * FROM messages WHERE chat_id = ? AND sender_id = ? AND client_id = ?', id, req.user.id, clientId);
  if (dup) return res.json({ done: true, message: messageOut(dup), duplicate: true });
  const existing = q.get('SELECT * FROM uploads WHERE user_id = ? AND client_id = ?', req.user.id, clientId);
  if (existing) return res.json(uploadOut(existing));
  assertQuota(req.user, size);
  const wf = typeof b.waveform === 'string' && /^[A-Za-z0-9_-]{8,140}$/.test(b.waveform) ? b.waveform : null;
  const uid = rid(16);
  q.run(
    'INSERT INTO uploads (id, user_id, chat_id, client_id, name, size, caption, voice, duration, reply_to, waveform, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    uid, req.user.id, id, clientId, name, size, str(String(b.caption ?? ''), 'caption', { max: LIMITS.TEXT_MAX }), b.voice ? 1 : 0,
    int(b.duration, 'duration', { min: 0, max: 24 * 3600, optional: true }) ?? null, int(b.reply_to, 'reply_to', { optional: true }) ?? null, wf, now(), now(),
  );
  fs.writeFileSync(partPath(uid), '');
  res.status(201).json({ ...uploadOut(q.get('SELECT * FROM uploads WHERE id = ?', uid)), chunk: 1024 * 1024 });
});

api.get('/uploads', (req, res) => {
  const rows = q.all('SELECT * FROM uploads WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100', req.user.id);
  res.json({ uploads: rows.map((u) => ({ ...uploadOut(u), name: u.name, chat_id: u.chat_id, updated_at: u.updated_at })) });
});

api.get('/uploads/:id', (req, res) => res.json(uploadOut(ownUpload(req))));

api.put('/uploads/:id', async (req, res) => {
  const u = ownUpload(req);
  if (!rateLimit(`upchunk:${req.user.id}`, 1200, 60_000)) throw new HttpError(429, 'slow_down');
  const have = uploadOut(u).received;
  const offset = int(req.query.offset, 'offset', { min: 0 });
  if (offset !== have) {
    req.resume();
    return res.status(409).json({ error: 'offset_mismatch', received: have });
  }
  const chunks = [];
  let total = 0;
  await new Promise((resolve, reject) => {
    req.on('data', (c) => {
      total += c.length;
      if (total > CHUNK_MAX) { reject(new HttpError(413, 'chunk_too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(true));
    req.on('error', () => resolve(false)); // the client went away mid-chunk (pause, lost network): nothing to answer
    req.on('aborted', () => resolve(false));
  }).then((complete) => { if (!complete) throw Object.assign(new Error('client_gone'), { gone: true }); }).catch((e) => { if (e.gone) return 'gone'; throw e; });
  if (res.destroyed || !req.complete) return;
  const buf = Buffer.concat(chunks);
  if (!buf.length || have + buf.length > u.size) throw new HttpError(400, 'invalid_chunk');
  const want = req.headers['x-chunk-sha256'];
  if (want && crypto.createHash('sha256').update(buf).digest('hex') !== String(want).toLowerCase()) throw new HttpError(422, 'chunk_corrupted');
  fs.appendFileSync(partPath(u.id), buf);
  q.run('UPDATE uploads SET updated_at = ? WHERE id = ?', now(), u.id);
  res.json({ received: have + buf.length, size: u.size });
});

api.post('/uploads/:id/complete', (req, res) => {
  const u = ownUpload(req);
  const part = partPath(u.id);
  const got = uploadOut(u).received;
  if (got !== u.size) return res.status(409).json({ error: 'incomplete', received: got, size: u.size });
  const chat = q.get('SELECT * FROM chats WHERE id = ?', u.chat_id);
  const me = requireMember(u.chat_id, req.user.id);
  assertCanPost(chat, me, req.user.id);
  const fid = rid(16);
  const dest = filePath(fid);
  fs.renameSync(part, dest);
  const secretChat = isSecretChat(u.chat_id);
  let capt = u.caption;
  if (secretChat) {
    if (!q.get('SELECT peer_pub FROM secret_chats WHERE chat_id = ?', u.chat_id)?.peer_pub) { fs.renameSync(dest, part); throw new HttpError(409, 'secret_not_ready'); }
    try { capt = checkEnvelope(u.caption); } catch (e) { fs.renameSync(dest, part); throw e; }
  }
  const type = secretChat ? null : sniff(readHead(dest), !!u.voice);
  const mime = type?.mime ?? 'application/octet-stream';
  const kind = secretChat ? 'secret' : (type?.kind ?? 'file');
  q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)', fid, req.user.id, u.chat_id, secretChat ? 'secret.bin' : u.name, mime, u.size, now());
  const out = postMessage({
    chat, user: req.user, text: capt, kind, fileId: fid,
    duration: kind === 'voice' || kind === 'audio' || kind === 'video' ? u.duration : null,
    replyTo: u.reply_to, clientId: u.client_id, waveform: kind === 'voice' ? u.waveform : null,
  });
  q.run('DELETE FROM uploads WHERE id = ?', u.id);
  res.status(201).json(out);
});

api.delete('/uploads/:id', (req, res) => {
  const u = ownUpload(req);
  fs.unlink(partPath(u.id), () => {});
  q.run('DELETE FROM uploads WHERE id = ?', u.id);
  res.json({ ok: true });
});

// raw body upload: POST /chats/:id/files?name=...&voice=1&caption=...&duration=...&client_id=...
api.post('/chats/:id/files', async (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  assertCanPost(chat, me, req.user.id);
  if (!rateLimit(`upload:${req.user.id}`, 20, 60_000)) throw new HttpError(429, 'slow_down');
  const name = checkName(str(String(req.query.name ?? 'file'), 'name', { min: 1, max: 200 }));
  const caption = str(String(req.query.caption ?? ''), 'caption', { max: LIMITS.TEXT_MAX });
  const clientId = req.query.client_id ? str(String(req.query.client_id), 'client_id', { min: 8, max: 64 }) : null;
  const voice = req.query.voice === '1';
  const duration = int(req.query.duration, 'duration', { min: 0, max: 24 * 3600, optional: true }) ?? null;
  const replyTo = int(req.query.reply_to, 'reply_to', { optional: true }) ?? null;
  const wf = typeof req.query.waveform === 'string' && /^[A-Za-z0-9_-]{8,140}$/.test(req.query.waveform) ? req.query.waveform : null;
  if (clientId) {
    const dup = q.get('SELECT * FROM messages WHERE chat_id = ? AND sender_id = ? AND client_id = ?', id, req.user.id, clientId);
    if (dup) { req.resume(); return res.json({ message: messageOut(dup), duplicate: true }); }
  }
  const fid = rid(16);
  const dest = filePath(fid);
  const size = await receive(req, dest, config.maxUploadBytes);
  if (size === 0) { removeFile(fid); throw new HttpError(400, 'empty_file'); }
  try { assertQuota(req.user, size); } catch (e) { removeFile(fid); throw e; }
  const secretChat = isSecretChat(id);
  let capt = caption;
  if (secretChat) {
    if (!q.get('SELECT peer_pub FROM secret_chats WHERE chat_id = ?', id)?.peer_pub) { removeFile(fid); throw new HttpError(409, 'secret_not_ready'); }
    try { capt = checkEnvelope(caption); } catch (e) { removeFile(fid); throw e; }
  }
  const type = secretChat ? null : sniff(readHead(dest), voice);
  // Unknown content is stored as an opaque download — it is never rendered inline.
  const mime = type?.mime ?? 'application/octet-stream';
  const kind = secretChat ? 'secret' : (type?.kind ?? 'file');
  q.run('INSERT INTO files (id, owner_id, chat_id, name, mime, size, created_at) VALUES (?,?,?,?,?,?,?)',
    fid, req.user.id, id, secretChat ? 'secret.bin' : name, mime, size, now());
  const out = postMessage({
    chat, user: req.user, text: capt, kind, fileId: fid, duration: kind === 'voice' || kind === 'audio' || kind === 'video' ? duration : null,
    replyTo, clientId, waveform: kind === 'voice' ? wf : null,
  });
  res.status(201).json(out);
});

/** Serve a stored file. Ranges (video/audio seeking, PDF page streaming) are handled by sendFile. */
function sendFile(res, f, { download = false, pdfInline = false, thumb = false } = {}) {
  const mediaOk = /^(image\/(jpeg|png|gif|webp)|audio\/|video\/)/.test(f.mime);
  const pdf = f.mime === 'application/pdf' && pdfInline && !download;
  const inline = !download && (mediaOk || pdf);
  res.setHeader('Content-Type', inline ? f.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (pdf) {
    // the built-in PDF viewer may only be framed by our own pages
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'");
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  } else {
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  }
  // file ids never change content: let the device keep what it has opened (private cache only)
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
  res.setHeader('Accept-Ranges', 'bytes');
  const full = thumb ? thumbPath(f.id) : filePath(f.id);
  res.sendFile(full, { dotfiles: 'allow', cacheControl: false, lastModified: false }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'not_found' });
  });
}

function canAccessFile(userId, fid) {
  if (q.get('SELECT 1 AS x FROM stickers WHERE file_id = ? AND user_id = ?', fid, userId)) return true;
  return !!q.get(
    `SELECT 1 AS x FROM messages m JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0
     WHERE m.file_id = ? LIMIT 1`,
    userId, fid,
  );
}

api.get('/files/:id', (req, res) => {
  const fid = str(req.params.id, 'id', { min: 8, max: 40 });
  const f = q.get('SELECT * FROM files WHERE id = ?', fid);
  if (!f || !canAccessFile(req.user.id, fid) || !fs.existsSync(filePath(fid))) throw new HttpError(404, 'not_found');
  sendFile(res, f, { download: req.query.dl === '1', pdfInline: req.query.inline === '1' });
});

// thumbnail / poster, produced by the sender's device while uploading
api.get('/files/:id/thumb', (req, res) => {
  const fid = str(req.params.id, 'id', { min: 8, max: 40 });
  const f = q.get('SELECT * FROM files WHERE id = ?', fid);
  if (!f || !canAccessFile(req.user.id, fid) || !fs.existsSync(thumbPath(fid))) throw new HttpError(404, 'not_found');
  sendFile(res, { ...f, mime: 'image/jpeg', name: 'thumb.jpg', id: fid }, { thumb: true });
});

api.post('/files/:id/thumb', async (req, res) => {
  const fid = str(req.params.id, 'id', { min: 8, max: 40 });
  const f = q.get('SELECT * FROM files WHERE id = ?', fid);
  if (!f || f.owner_id !== req.user.id) throw new HttpError(404, 'not_found');
  if (!rateLimit(`thumb:${req.user.id}`, 120, 60_000)) throw new HttpError(429, 'slow_down');
  const tmp = `${thumbPath(fid)}.tmp`;
  await receive(req, tmp, 400 * 1024);
  const type = sniff(readHead(tmp));
  if (!type || type.kind !== 'image') {
    fs.unlink(tmp, () => {});
    throw new HttpError(415, 'image_required');
  }
  fs.renameSync(tmp, thumbPath(fid));
  const w = int(req.query.w, 'w', { min: 1, max: 20000, optional: true });
  const hgt = int(req.query.h, 'h', { min: 1, max: 20000, optional: true });
  if (w && hgt) q.run('UPDATE files SET width = ?, height = ? WHERE id = ?', w, hgt, fid);
  // everybody who sees the message gets the new preview immediately
  for (const mrow of q.all('SELECT * FROM messages WHERE file_id = ?', fid)) {
    emit(memberIds(mrow.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(mrow) });
  }
  res.json({ ok: true });
});

// shared media / files / links of a chat (the "Media & files" panel)
api.get('/chats/:id/media', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const kind = oneOf(String(req.query.kind || 'media'), 'kind', ['media', 'files', 'links']);
  const before = int(req.query.before, 'before', { optional: true }) ?? Number.MAX_SAFE_INTEGER;
  const limit = int(req.query.limit, 'limit', { min: 1, max: 100, optional: true }) ?? 60;
  const where = kind === 'media' ? "kind IN ('image','video')"
    : kind === 'files' ? "kind IN ('file','audio')"
      : "kind = 'text' AND text LIKE '%http%'";
  const rows = q.all(
    `SELECT * FROM messages WHERE chat_id = ? AND id < ? AND ${where} ORDER BY id DESC LIMIT ?`, id, before, limit + 1,
  );
  const page = rows.slice(0, limit).map((r) => {
    const m = messageOut(r);
    if (kind === 'links') m.links = [...new Set(r.text.match(/https?:\/\/[^\s<>"']+/gi) || [])].slice(0, 5);
    return m;
  });
  res.json({ messages: page, has_more: rows.length > limit });
});

api.get('/chats/:id/media/counts', (req, res) => {
  const id = int(req.params.id, 'id');
  const floor = requireMember(id, req.user.id).cleared_before || 0;
  const n = (where) => q.get(`SELECT COUNT(*) n FROM messages WHERE chat_id = ? AND id > ? AND ${where}`, id, floor).n;
  res.json({
    photos: n("kind = 'image'"), videos: n("kind = 'video'"), files: n("kind = 'file'"), audio: n("kind = 'audio'"),
    voice: n("kind = 'voice'"), links: n("kind = 'text' AND text LIKE '%http%'"),
  });
});

api.patch('/messages/:id', (req, res) => {
  const m = getMessage(int(req.params.id, 'id'));
  if (!m) throw new HttpError(404, 'not_found');
  requireMember(m.chat_id, req.user.id);
  if (m.sender_id !== req.user.id) throw new HttpError(403, 'forbidden');
  if (isSecretChat(m.chat_id)) throw new HttpError(403, 'secret_no_edit'); // the server cannot re-encrypt
  const text = str(req.body?.text, 'text', { min: m.file_id ? 0 : 1, max: LIMITS.TEXT_MAX });
  aud(req, 'message.edit', { chat_id: m.chat_id, target_type: 'message', target_id: m.id, details: { old: m.text, new: text } });
  q.run('UPDATE messages SET text = ?, edited_at = ? WHERE id = ?', text, now(), m.id);
  const message = messageOut(getMessage(m.id));
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message });
  res.json({ message });
});

api.delete('/messages/:id', (req, res) => {
  const m = getMessage(int(req.params.id, 'id'));
  if (!m) throw new HttpError(404, 'not_found');
  const me = requireMember(m.chat_id, req.user.id);
  if (m.sender_id !== req.user.id) {
    const chat = q.get('SELECT type FROM chats WHERE id = ?', m.chat_id);
    const senderRole = membership(m.chat_id, m.sender_id)?.role ?? 'member';
    const ok = chat.type !== 'direct' && (me.role === 'owner' || (me.role === 'admin' && senderRole === 'member'));
    if (!ok) throw new HttpError(403, 'forbidden');
  }
  {
    const f = m.file_id ? q.get('SELECT name, size, mime FROM files WHERE id = ?', m.file_id) : null;
    aud(req, 'message.delete', {
      chat_id: m.chat_id, target_type: 'message', target_id: m.id,
      details: { author: m.sender_id, text: m.text, kind: m.kind, file: f, sent_at: m.created_at, deleted_by_author: m.sender_id === req.user.id },
    });
  }
  q.run('UPDATE chats SET pinned_message_id = NULL WHERE pinned_message_id = ?', m.id);
  q.run('DELETE FROM messages WHERE id = ?', m.id);
  if (m.file_id && !q.get('SELECT 1 AS x FROM messages WHERE file_id = ?', m.file_id)
    && !q.get('SELECT 1 AS x FROM stickers WHERE file_id = ?', m.file_id) && !q.get('SELECT 1 AS x FROM anim_files WHERE file_id = ?', m.file_id)) {
    q.run('DELETE FROM files WHERE id = ?', m.file_id);
    removeFile(m.file_id);
  }
  refreshLastMessage(m.chat_id);
  const ids = memberIds(m.chat_id);
  emit(ids, { type: EVENTS.MESSAGE_DELETE, chat_id: m.chat_id, message_id: m.id });
  pushChat(m.chat_id, ids);
  res.json({ ok: true });
});

api.post('/messages/:id/reactions', (req, res) => {
  const m = getMessage(int(req.params.id, 'id'));
  if (!m) throw new HttpError(404, 'not_found');
  requireMember(m.chat_id, req.user.id);
  const emoji = oneOf(req.body?.emoji, 'emoji', REACTIONS);
  const has = q.get('SELECT 1 AS x FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, req.user.id, emoji);
  if (has) q.run('DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?', m.id, req.user.id, emoji);
  else q.run('INSERT INTO reactions (message_id, user_id, emoji) VALUES (?,?,?)', m.id, req.user.id, emoji);
  const message = messageOut(getMessage(m.id));
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message });
  res.json({ message });
});

api.post('/chats/:id/pin', (req, res) => {
  const id = int(req.params.id, 'id');
  const me = requireMember(id, req.user.id);
  const chat = q.get('SELECT * FROM chats WHERE id = ?', id);
  if (chat.type !== 'direct' && !isAdmin(me)) throw new HttpError(403, 'forbidden');
  const mid = req.body?.message_id === null ? null : int(req.body?.message_id, 'message_id');
  if (mid !== null && !q.get('SELECT 1 AS x FROM messages WHERE id = ? AND chat_id = ?', mid, id)) throw new HttpError(404, 'not_found');
  q.run('UPDATE chats SET pinned_message_id = ? WHERE id = ?', mid, id);
  aud(req, mid === null ? 'chat.unpin' : 'chat.pin', { chat_id: id, target_type: 'message', target_id: mid });
  pushChat(id);
  res.json({ chat: chatOut(id, req.user.id) });
});

api.post('/chats/:id/read', (req, res) => {
  const id = int(req.params.id, 'id');
  requireMember(id, req.user.id);
  const chat = q.get('SELECT last_message_id FROM chats WHERE id = ?', id);
  const upTo = Math.min(int(req.body?.message_id, 'message_id', { min: 0 }), chat.last_message_id ?? 0);
  q.run(
    `UPDATE members SET last_read_id = MAX(last_read_id, ?), last_delivered_id = MAX(last_delivered_id, ?)
     WHERE chat_id = ? AND user_id = ?`, upTo, upTo, id, req.user.id,
  );
  const m = membership(id, req.user.id);
  emit(memberIds(id), { type: EVENTS.READ, chat_id: id, user_id: req.user.id, message_id: m.last_read_id });
  res.json({ ok: true, last_read_id: m.last_read_id });
});

api.get('/search/messages', (req, res) => {
  if (!rateLimit(`msearch:${req.user.id}`, 30, 60_000)) throw new HttpError(429, 'too_many_requests');
  const term = str(String(req.query.q ?? ''), 'q', { min: 2, max: 100 });
  const chatId = int(req.query.chat_id, 'chat_id', { optional: true });
  const params = [req.user.id, `%${escapeLike(term)}%`];
  let sql = `SELECT m.* FROM messages m JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0
             WHERE m.text LIKE ? ESCAPE '\\'`;
  if (chatId !== undefined) { sql += ' AND m.chat_id = ?'; params.push(chatId); }
  sql += ' ORDER BY m.id DESC LIMIT 40';
  res.json({ messages: db.prepare(sql).all(...params).map(messageOut) });
});
