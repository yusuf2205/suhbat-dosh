import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const env = process.env;
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

const nodeEnv = env.NODE_ENV || 'development';
const production = nodeEnv === 'production';
const dataDir = path.resolve(env.DATA_DIR || './data');
fs.mkdirSync(path.join(dataDir, 'files'), { recursive: true });

// Server secret: from env, otherwise generated once and persisted next to the data (0600).
function loadSecret() {
  if (env.APP_SECRET) {
    if (env.APP_SECRET.length < 32) throw new Error('APP_SECRET must be at least 32 characters');
    return env.APP_SECRET;
  }
  if (production) throw new Error('APP_SECRET is required in production');
  const file = path.join(dataDir, 'secret.key');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const s = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(file, s, { mode: 0o600 });
  return s;
}

// OTP delivery modes:
//   dev     - code is returned in the API response. FORBIDDEN when NODE_ENV=production.
//   log     - code is written to the server log (private installs where the admin relays codes).
//   webhook - code is POSTed to SMS_WEBHOOK_URL (your SMS gateway adapter).
//   off     - phone+code sign-in disabled (use Telegram).
const otpMode = env.OTP_MODE || (production ? 'log' : 'dev');
if (!['dev', 'log', 'webhook', 'off'].includes(otpMode)) throw new Error(`Unknown OTP_MODE: ${otpMode}`);
if (production && otpMode === 'dev') {
  throw new Error('OTP_MODE=dev is not allowed when NODE_ENV=production');
}
if (otpMode === 'webhook' && !env.SMS_WEBHOOK_URL) throw new Error('SMS_WEBHOOK_URL is required for OTP_MODE=webhook');

export const config = {
  production,
  port: Number(env.PORT) || 3000,
  host: env.HOST || '0.0.0.0',
  dataDir,
  filesDir: path.join(dataDir, 'files'),
  downloadsDir: path.resolve(env.DOWNLOADS_DIR || path.join(dataDir, '..', 'downloads')),
  dbFile: path.join(dataDir, 'suhbat.db'),
  // database snapshots made from the admin console (persistent volume on the NAS)
  backupDir: path.resolve(env.BACKUP_DIR || (fs.existsSync('/backups') ? '/backups' : path.join(dataDir, 'backups'))),
  secret: loadSecret(),
  otpMode,
  smsWebhookUrl: env.SMS_WEBHOOK_URL || '',
  smsWebhookToken: env.SMS_WEBHOOK_TOKEN || '',
  otpTtlMs: 5 * 60 * 1000,
  otpMaxAttempts: 5,
  registrationOpen: bool(env.REGISTRATION_OPEN, true),
  maxUploadBytes: (Number(env.MAX_UPLOAD_MB) || 50) * 1024 * 1024,
  cookieSecure: bool(env.COOKIE_SECURE, production),
  trustProxy: bool(env.TRUST_PROXY, false),
  sessionTtlMs: 365 * 24 * 3600 * 1000,
  logLevel: env.LOG_LEVEL || 'info',
  telegramToken: env.TELEGRAM_BOT_TOKEN || '',
  telegramApiBase: (env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/$/, ''),
  telegramBotUsername: (env.TELEGRAM_BOT_USERNAME || '').replace(/^@/, ''),
  iceServers: (() => {
    const list = [{ urls: (env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',').map((s) => s.trim()).filter(Boolean) }];
    if (env.TURN_URLS) {
      list.push({
        urls: env.TURN_URLS.split(',').map((s) => s.trim()).filter(Boolean),
        username: env.TURN_USERNAME || '',
        credential: env.TURN_CREDENTIAL || '',
      });
    }
    return list;
  })(),
  resendApiKey: env.RESEND_API_KEY || '',
  resendApiBase: (env.RESEND_API_BASE || 'https://api.resend.com').replace(/\/$/, ''),
  emailFrom: env.EMAIL_FROM || 'Suhbat-dosh <no-reply@suhbat-dosh.uz>',
  superAdminPhones: (env.SUPERADMIN_PHONES || '').split(',').map((s) => s.trim()).filter(Boolean),
  otpPerIp: Number(env.OTP_REQUESTS_PER_IP) || 10,
  maxChatsPerHour: Number(env.MAX_CHATS_PER_HOUR) || 10,
};
