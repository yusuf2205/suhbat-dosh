import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { db, migrate, q } from './db.js';
import { HttpError, log, now } from './util.js';
import { api, authenticate, listDownloads } from './api.js';
import { botApi } from './bots.js';
import { counters, setWsCounter, startMonitors } from './ops.js';
import { startScheduler } from './features.js';
import { startSafetyJobs } from './safety.js';
import { handleGroupSignal, leave as leaveGroupCall } from './groupcalls.js';
import { ensureBotFather } from './botfather.js';
import { startTurn } from './turn.js';
import { attach, connectionCount, emit } from './realtime.js';
import { EVENTS } from '../../shared/contracts.js';
import { chatOut, getUser, memberIds, membership, publicUser } from './service.js';
import { startBot, stopBot } from './telegram.js';
import { BUILD_ID } from './build.js';
import { handleOffline, handleOnline, handleSignal } from './calls.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(here, '../../web');
const sharedDir = path.resolve(here, '../../shared');

migrate();
ensureBotFather();

// SUPERADMIN_PHONES (comma-separated, E.164) marks existing accounts as super admins at startup;
// accounts created later with those numbers are promoted at registration.
for (const p of config.superAdminPhones) q.run('UPDATE users SET is_admin = 1 WHERE phone = ?', p);

const app = express();
app.disable('x-powered-by');
if (config.trustProxy) app.set('trust proxy', true);

// ---- security headers
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(self), fullscreen=(self)');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' ws: wss:; " +
      "style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  );
  if (config.cookieSecure || req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});

// ---- request log: method, route, status, duration. Never bodies, queries, cookies or phone numbers.
app.use((req, res, next) => {
  const t = process.hrtime.bigint();
  res.on('finish', () => {
    counters.requests++;
    if (res.statusCode >= 500) counters.errors++;
    if (req.path === '/healthz') return;
    log('info', 'http', {
      m: req.method,
      p: req.path.replace(/\/bot[^/]+/g, '/bot:token').replace(/\/[A-Za-z0-9_-]{16,}/g, '/:id'),
      s: res.statusCode,
      ms: Number((process.hrtime.bigint() - t) / 1_000_000n),
    });
  });
  next();
});

const hostOf = (req) => (config.trustProxy && req.headers['x-forwarded-host']) || req.headers.host;
const originOk = (req) => {
  const o = req.headers.origin;
  if (!o) return true; // non-browser clients; cookies are SameSite=Strict anyway
  try {
    return new URL(o).host === hostOf(req);
  } catch {
    return false;
  }
};

app.get('/healthz', (_req, res) => {
  try {
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', uptime: Math.round(process.uptime()) });
  } catch {
    res.status(503).json({ status: 'error' });
  }
});

app.use(botApi); // Telegram-style Bot API: /bot<token>/<method>
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !originOk(req)) {
    return next(new HttpError(403, 'bad_origin'));
  }
  next();
});
app.use('/api', express.json({ limit: '32kb' }));
app.use('/api', api);
app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found')));

// ---- entry pages and ES modules are served with the build id appended to every module URL, so a new
// release is never mixed with modules a browser or CDN cached earlier (cache busting without a bundler).
const NO_CACHE = 'private, no-cache, max-age=0, must-revalidate';
const versionedCache = new Map();
function versioned(file, kind) {
  const st = fs.statSync(file);
  const key = `${file}:${st.mtimeMs}:${BUILD_ID}`;
  let out = versionedCache.get(key);
  if (out === undefined) {
    let s = fs.readFileSync(file, 'utf8').replace(/\?v=\d+/g, `?v=${BUILD_ID}`);
    if (kind === 'js') {
      // static and dynamic imports of our own modules: ./x.js, ../x.js, /shared/x.js
      s = s.replace(/((?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"])((?:\.{1,2}\/|\/shared\/)[^'"?]+\.js)(['"])/g, (_m, a, b, c) => `${a}${b}?v=${BUILD_ID}${c}`);
    }
    versionedCache.set(key, s);
    out = s;
  }
  return out;
}
const sendVersioned = (res, file, type, kind) => { res.type(type).setHeader('Cache-Control', NO_CACHE); res.send(versioned(file, kind)); };
const page = (name) => (_req, res) => sendVersioned(res, path.join(webDir, name), 'text/html; charset=utf-8', 'html');
app.get(['/', '/index.html'], page('index.html'));
app.get('/admin', page('admin.html'));
app.get('/download', page('download.html'));
app.get('/sw.js', (_req, res) => sendVersioned(res, path.join(webDir, 'sw.js'), 'application/javascript; charset=utf-8', 'html'));
const moduleRoute = (dir) => (req, res, next) => {
  const f = path.basename(req.params.f || '');
  const file = path.join(dir, f);
  if (!f.endsWith('.js') || !fs.existsSync(file)) return next();
  return sendVersioned(res, file, 'application/javascript; charset=utf-8', 'js');
};
app.get('/js/:f', moduleRoute(path.join(webDir, 'js')));
app.get('/shared/:f', moduleRoute(sharedDir));
app.get('/downloads/:name', (req, res, next) => {
  // only files that appear in the listing (no path traversal, no stray files)
  const name = req.params.name;
  const isMeta = /^(latest(-mac|-linux)?\.yml|[\w.\- ()]+\.blockmap)$/.test(name);
  const f = isMeta ? { name } : listDownloads().find((x) => x.name === name);
  if (!f || (isMeta && !fs.existsSync(path.join(config.downloadsDir, name)))) return next();
  if (isMeta) res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', 'application/octet-stream');
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.sendFile(path.join(config.downloadsDir, f.name), { dotfiles: 'deny', cacheControl: false });
});
app.use('/shared', express.static(sharedDir, { maxAge: 0, setHeaders: (res) => res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate') }));
app.use(express.static(webDir, { maxAge: 0, etag: true, index: 'index.html', setHeaders: (res) => res.setHeader('Cache-Control', 'private, no-cache, max-age=0, must-revalidate') }));

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.code, message: err.message });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large' });
  if (err instanceof SyntaxError) return res.status(400).json({ error: 'invalid_json' });
  log('error', 'unhandled', { err: err?.message, stack: String(err?.stack || '').split('\n').slice(0, 4).join(' | ') });
  res.status(500).json({ error: 'internal_error' });
});

// ---- realtime
const server = http.createServer(app);

function contactIds(userId) {
  return q.all(
    `SELECT m2.user_id FROM members m1 JOIN chats c ON c.id = m1.chat_id AND c.type = 'direct'
     JOIN members m2 ON m2.chat_id = c.id AND m2.user_id != m1.user_id WHERE m1.user_id = ?`,
    userId,
  ).map((r) => r.user_id);
}

function broadcastPresence(userId) {
  const u = getUser(userId);
  if (!u) return;
  for (const viewer of contactIds(userId)) {
    emit([viewer], { type: EVENTS.PRESENCE, user: publicUser(u, viewer) });
  }
}

attach(server, {
  authenticate,
  originOk,
  onOnline(userId) {
    handleOnline(userId);
    q.run('UPDATE users SET last_seen = ? WHERE id = ?', now(), userId);
    // everything waiting for this user is now delivered
    const pending = q.all(
      `SELECT m.chat_id, c.last_message_id FROM members m JOIN chats c ON c.id = m.chat_id
       WHERE m.user_id = ? AND m.banned = 0 AND c.last_message_id IS NOT NULL AND m.last_delivered_id < c.last_message_id`,
      userId,
    );
    for (const p of pending) {
      q.run('UPDATE members SET last_delivered_id = ? WHERE chat_id = ? AND user_id = ?', p.last_message_id, p.chat_id, userId);
      emit(memberIds(p.chat_id).filter((x) => x !== userId), {
        type: EVENTS.DELIVERED, chat_id: p.chat_id, user_id: userId, message_id: p.last_message_id,
      });
    }
    broadcastPresence(userId);
  },
  onSignal(userId, m) {
    handleSignal(userId, m);
  },
  onGroupSignal(userId, m) {
    handleGroupSignal(userId, m);
  },
  onOffline(userId) {
    handleOffline(userId);
    leaveGroupCall(userId);
    q.run('UPDATE users SET last_seen = ? WHERE id = ?', now(), userId);
    broadcastPresence(userId);
  },
  onTyping(userId, chatId) {
    if (!membership(chatId, userId)) return;
    emit(memberIds(chatId).filter((x) => x !== userId), { type: EVENTS.TYPING, chat_id: chatId, user_id: userId });
  },
});

// ---- housekeeping: expired OTPs, stale sessions, orphaned uploads
function sweep() {
  const t = now();
  q.run('DELETE FROM otp_codes WHERE expires_at < ?', t);
  q.run('DELETE FROM login_tokens WHERE expires_at < ?', t - 3600_000);
  q.run('DELETE FROM email_codes WHERE expires_at < ?', t);
  q.run('DELETE FROM sessions WHERE revoked = 1 OR last_active < ?', t - config.sessionTtlMs);
  const orphans = q.all(
    `SELECT id FROM files f WHERE f.created_at < ? AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM users u WHERE u.avatar_file = f.id)
       AND NOT EXISTS (SELECT 1 FROM profile_photos p WHERE p.file_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM stories st WHERE st.file_id = f.id)`,
    t - 3600_000,
  );
  // never delete anything people uploaded: an unattached file is only reported
  if (orphans.length) log('info', 'unattached uploads kept', { count: orphans.length });
}
sweep();
setInterval(sweep, 3600_000).unref();

server.listen(config.port, config.host, () => {
  log('info', 'suhbat started', { port: config.port, otp_mode: config.otpMode, telegram: !!config.telegramToken, production: config.production });
  startBot();
  setWsCounter(connectionCount);
  startMonitors();
  startScheduler();
  startSafetyJobs();
  startTurn();
});

function shutdown() {
  log('info', 'shutting down');
  stopBot();
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { /* ignore */ }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
