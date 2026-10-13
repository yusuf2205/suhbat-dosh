import { config } from './config.js';
import { q } from './db.js';
import { audit, getUser } from './service.js';
import { consumeInvite, gateRegistration } from './access.js';
import { log, now, rid, sha256 } from './util.js';
import { LIMITS } from '../../shared/contracts.js';
import fs from 'node:fs';
import path from 'node:path';

// Sign in with Telegram:
//   1. the app asks the server for a one-time login link  (startLogin)
//   2. the user opens the bot via that link, shares their phone (Telegram verifies it is their own),
//      and confirms the sign-in on the shown device/IP
//   3. the app, polling pollLogin(), receives a session.
// The bot talks to Telegram with long polling (outbound only), so no public URL is needed.

const TTL = 5 * 60 * 1000;
export const telegramEnabled = () => !!config.telegramToken;

async function tg(method, body = {}, signal) {
  const r = await fetch(`${config.telegramApiBase}/bot${config.telegramToken}/${method}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
  });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram ${method}: ${j.description || r.status}`); // never include the URL (token)
  return j.result;
}

let botUsername = config.telegramBotUsername || null;
export async function getBotUsername() {
  if (botUsername) return botUsername;
  try { botUsername = (await tg('getMe')).username; } catch (e) { log('warn', 'telegram getMe failed', { err: e.message }); }
  return botUsername;
}

// ---------------------------------------------------------------- app-facing API
export async function startLogin({ ip, device, invite = null }) {
  const username = await getBotUsername();
  if (!username) throw Object.assign(new Error('bot unavailable'), { status: 503, code: 'telegram_unavailable' });
  const token = rid(16);
  q.run(
    'INSERT INTO login_tokens (token_hash, created_at, expires_at, ip, device, invite) VALUES (?,?,?,?,?,?)',
    sha256(token), now(), now() + TTL, ip || '', (device || '').slice(0, 160), invite ? String(invite).slice(0, 64) : null,
  );
  return {
    token,
    bot: username,
    url: `https://t.me/${username}?start=${token}`,
    app_url: `tg://resolve?domain=${username}&start=${token}`,
    expires_in: TTL / 1000,
  };
}

/** Returns { status: 'pending' } | { status: 'approved', user } | { status: 'rejected' | 'expired' } */
export function pollLogin(token, precheck) {
  const row = q.get('SELECT * FROM login_tokens WHERE token_hash = ?', sha256(token));
  if (!row || row.expires_at < now() || row.status === 'consumed') return { status: 'expired' };
  if (row.status === 'rejected') return { status: 'rejected' };
  if (row.status !== 'approved') return { status: 'pending', step: row.status };
  // the account may not be allowed to sign in this way (e.g. an administrator with a password): say so, do not burn the link silently
  const why = precheck?.(getUser(row.user_id));
  if (why) {
    q.run("UPDATE login_tokens SET status = 'consumed' WHERE id = ?", row.id);
    return { status: 'rejected', reason: why };
  }
  q.run("UPDATE login_tokens SET status = 'consumed' WHERE id = ? AND status = 'approved'", row.id);
  return { status: 'approved', user: getUser(row.user_id) };
}

// ---------------------------------------------------------------- bot
const T = {
  help: 'Suhbat-dosh\nОткройте приложение и нажмите «Войти через Telegram».\nIlovani oching va «Telegram orqali kirish» tugmasini bosing.',
  expired: 'Ссылка для входа устарела. Вернитесь в приложение и начните заново.\nHavola eskirgan. Ilovaga qaytib, qaytadan boshlang.',
  share: 'Чтобы войти, поделитесь своим номером телефона кнопкой ниже.\nKirish uchun pastdagi tugma orqali telefon raqamingizni yuboring.',
  shareBtn: '📱 Поделиться номером / Raqamni yuborish',
  notOwn: 'Нужен именно ваш номер — используйте кнопку.\nFaqat o‘zingizning raqamingiz kerak — tugmadan foydalaning.',
  closed: 'Регистрация закрыта.\nRo‘yxatdan o‘tish yopiq.',
  ok: '✅ Вход подтверждён. Вернитесь в приложение.\nKirish tasdiqlandi. Ilovaga qaytishingiz mumkin.',
  no: '❌ Вход отклонён.\nKirish rad etildi.',
};

const send = (chat_id, text, extra = {}) => tg('sendMessage', { chat_id, text, ...extra });

function confirmText(row) {
  return `Подтвердить вход в Suhbat-dosh? / Suhbat-dosh’ga kirishni tasdiqlaysizmi?\n\n` +
    `Устройство: ${row.device || '—'}\nIP: ${row.ip || '—'}\nВремя: ${new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 19)} UTC\n\n` +
    'Если это не вы — нажмите «Не я». / Agar bu siz bo‘lmasangiz — «Men emas».';
}

async function askConfirm(chatId, row) {
  q.run("UPDATE login_tokens SET status = 'awaiting_confirm' WHERE id = ?", row.id);
  await send(chatId, confirmText(row), {
    reply_markup: { inline_keyboard: [[
      { text: '✅ Это я / Bu men', callback_data: `y:${row.id}` },
      { text: '❌ Не я / Men emas', callback_data: `n:${row.id}` },
    ]] },
  });
}

function findOrCreateUser(from, phone, invite = null) {
  const tgId = String(from.id);
  let user = q.get('SELECT * FROM users WHERE telegram_id = ?', tgId);
  if (user) return user;
  user = q.get('SELECT * FROM users WHERE phone = ?', phone);
  if (user) {
    q.run('UPDATE users SET telegram_id = ?, telegram_username = ? WHERE id = ?', tgId, from.username || null, user.id);
    return getUser(user.id);
  }
  let inv = null;
  try { inv = gateRegistration(invite); } catch { return null; }
  const name = [from.first_name, from.last_name].filter(Boolean).join(' ').slice(0, LIMITS.NAME_MAX) || 'User';
  const r = q.run(
    'INSERT INTO users (phone, name, telegram_id, telegram_username, last_seen, created_at, is_admin) VALUES (?,?,?,?,?,?,?)',
    phone, name, tgId, from.username || null, now(), now(), config.superAdminPhones.includes(phone) ? 1 : 0,
  );
  const created = getUser(Number(r.lastInsertRowid));
  consumeInvite(inv);
  audit(created.id, 'user.register', { target_type: 'user', target_id: created.id, details: { name, via: 'telegram' } });
  return created;
}

// ---- app update by Telegram: for installed apps that cannot download an update by themselves (older Android builds)
let apkCache = { name: '', size: 0, fileId: '' };

function newestApk() {
  let best = null;
  try {
    for (const n of fs.readdirSync(config.downloadsDir)) {
      const m = /-(\d+)\.(\d+)\.(\d+)-android\.apk$/.exec(n);
      if (!m) continue;
      const v = Number(m[1]) * 1e6 + Number(m[2]) * 1e3 + Number(m[3]);
      if (!best || v > best.v) best = { n, v, version: `${m[1]}.${m[2]}.${m[3]}` };
    }
  } catch { /* no downloads folder */ }
  return best;
}

async function sendUpdate(chatId) {
  const apk = newestApk();
  if (!apk) return void send(chatId, 'Файл обновления сейчас недоступен. Откройте suhbat-dosh.uz/download в браузере.\nYangilanish fayli hozir mavjud emas. suhbat-dosh.uz/download sahifasini brauzerda oching.');
  const file = path.join(config.downloadsDir, apk.n);
  const size = fs.statSync(file).size;
  const caption = `Suhbat-dosh ${apk.version}\nНажмите на файл → «Установить». / Faylni bosing → «O‘rnatish».`;
  if (apkCache.name === apk.n && apkCache.size === size && apkCache.fileId) {
    try { await tg('sendDocument', { chat_id: chatId, document: apkCache.fileId, caption }); return; } catch { /* re-upload below */ }
  }
  const form = new FormData();
  form.append('chat_id', chatId);
  form.append('caption', caption);
  form.append('document', new Blob([fs.readFileSync(file)], { type: 'application/vnd.android.package-archive' }), apk.n);
  const r = await fetch(`${config.telegramApiBase}/bot${config.telegramToken}/sendDocument`, { method: 'POST', body: form });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`telegram sendDocument: ${j.description || r.status}`);
  apkCache = { name: apk.n, size, fileId: j.result?.document?.file_id || '' };
}

async function onMessage(m) {
  if (m.chat?.type !== 'private' || !m.from) return;
  const chatId = String(m.chat.id);

  if (m.contact) {
    if (m.contact.user_id !== m.from.id) return void send(chatId, T.notOwn);
    const row = q.get(
      "SELECT * FROM login_tokens WHERE chat_id = ? AND status = 'awaiting_contact' AND expires_at > ? ORDER BY id DESC LIMIT 1", chatId, now(),
    );
    if (!row) return void send(chatId, T.expired, { reply_markup: { remove_keyboard: true } });
    const phone = `+${String(m.contact.phone_number).replace(/\D/g, '')}`;
    if (!/^\+[1-9]\d{7,14}$/.test(phone)) return void send(chatId, T.notOwn);
    const user = findOrCreateUser(m.from, phone, row.invite);
    if (!user) return void send(chatId, T.closed, { reply_markup: { remove_keyboard: true } });
    q.run('UPDATE login_tokens SET user_id = ?, telegram_id = ? WHERE id = ?', user.id, String(m.from.id), row.id);
    await send(chatId, '👍', { reply_markup: { remove_keyboard: true } });
    return askConfirm(chatId, row);
  }

  if (/^\/start\s+update\b/i.test(m.text || '') || /^\/update\b/i.test(m.text || '')) {
    try { await sendUpdate(chatId); } catch (e) { log('warn', 'update send failed', { err: String(e.message).slice(0, 100) }); await send(chatId, 'Не удалось отправить файл. Откройте suhbat-dosh.uz/download в браузере.'); }
    return undefined;
  }
  const start = /^\/start(?:\s+([A-Za-z0-9_-]{10,64}))?/.exec(m.text || '');
  if (!start) return void send(chatId, T.help);
  if (!start[1]) return void send(chatId, T.help);

  const row = q.get('SELECT * FROM login_tokens WHERE token_hash = ?', sha256(start[1]));
  if (!row || row.status !== 'pending' || row.expires_at < now()) return void send(chatId, T.expired);

  q.run('UPDATE login_tokens SET chat_id = ?, telegram_id = ? WHERE id = ?', chatId, String(m.from.id), row.id);
  const known = q.get('SELECT * FROM users WHERE telegram_id = ?', String(m.from.id));
  if (known) {
    q.run('UPDATE login_tokens SET user_id = ? WHERE id = ?', known.id, row.id);
    return askConfirm(chatId, row);
  }
  q.run("UPDATE login_tokens SET status = 'awaiting_contact' WHERE id = ?", row.id);
  return send(chatId, T.share, {
    reply_markup: { keyboard: [[{ text: T.shareBtn, request_contact: true }]], resize_keyboard: true, one_time_keyboard: true },
  });
}

async function onCallback(cb) {
  const m = /^([yn]):(\d+)$/.exec(cb.data || '');
  if (!m) return;
  const row = q.get('SELECT * FROM login_tokens WHERE id = ?', Number(m[2]));
  // only the Telegram account that opened the link may confirm it
  if (!row || row.telegram_id !== String(cb.from.id) || row.status !== 'awaiting_confirm' || row.expires_at < now()) {
    return void tg('answerCallbackQuery', { callback_query_id: cb.id, text: '⌛' });
  }
  const approve = m[1] === 'y';
  q.run('UPDATE login_tokens SET status = ? WHERE id = ?', approve ? 'approved' : 'rejected', row.id);
  await tg('answerCallbackQuery', { callback_query_id: cb.id });
  if (cb.message) {
    await tg('editMessageText', { chat_id: cb.message.chat.id, message_id: cb.message.message_id, text: approve ? T.ok : T.no }).catch(() => {});
  }
}

let running = false;
export function startBot() {
  if (!telegramEnabled() || running) return;
  running = true;
  let offset = 0;
  let backoff = 1000;
  (async () => {
    await tg('deleteWebhook').catch(() => {});
    const name = await getBotUsername();
    log('info', 'telegram bot started', { bot: name });
    while (running) {
      try {
        const updates = await tg('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, AbortSignal.timeout(40000));
        backoff = 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            if (u.message) await onMessage(u.message);
            else if (u.callback_query) await onCallback(u.callback_query);
          } catch (e) {
            log('warn', 'telegram update failed', { err: e.message });
          }
        }
      } catch (e) {
        log('warn', 'telegram poll error', { err: e.message });
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 30000);
      }
    }
  })();
}

export function stopBot() {
  running = false;
}
