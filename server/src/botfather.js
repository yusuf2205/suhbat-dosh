// BotGrandFather (BotFather): a built-in bot that creates and configures bots from an ordinary chat (commands + inline buttons).
// It is handled inside the server (no token, no external process).
import { q } from './db.js';
import { EVENTS } from '../../shared/contracts.js';
import { emit } from './realtime.js';
import { getMessage, getUser, memberIds, messageOut } from './service.js';
import { HttpError, now } from './util.js';
import {
  cleanMarkup, createBotAccount, deleteBotAccount, getHost, listOwnBots, ownBot, resetBotToken, updateBotAccount, wireBotFatherCallbacks,
} from './bots.js';

const PHONE = 'system:botfather';
const COMMANDS = [
  { command: 'newbot', description: 'Создать нового бота' },
  { command: 'mybots', description: 'Мои боты и их настройки' },
  { command: 'cancel', description: 'Отменить текущее действие' },
  { command: 'help', description: 'Помощь' },
];

export function ensureBotFather() {
  let u = q.get('SELECT * FROM users WHERE phone = ?', PHONE);
  if (u && (u.username !== 'botgrandfather' || u.name !== 'BotGrandFather')) {
    q.run("UPDATE users SET username = 'botgrandfather', name = 'BotGrandFather' WHERE id = ?", u.id);
    u = q.get('SELECT * FROM users WHERE phone = ?', PHONE);
  }
  if (!u) {
    q.run(
      'INSERT INTO users (phone, username, name, bio, last_seen, created_at, is_bot, bot_commands) VALUES (?,?,?,?,?,?,1,?)',
      PHONE, 'botgrandfather', 'BotGrandFather', 'Создаёт ботов и управляет ими / Botlarni yaratadi va boshqaradi', now(), now(), JSON.stringify(COMMANDS),
    );
    u = q.get('SELECT * FROM users WHERE phone = ?', PHONE);
  }
  return u;
}

const father = () => ensureBotFather();
const state = new Map(); // userId -> { step, botId?, name?, at }
setInterval(() => {
  for (const [k, v] of state) if (Date.now() - v.at > 30 * 60_000) state.delete(k);
}, 60_000).unref();

const kb = (rows) => cleanMarkup({ inline_keyboard: rows });
const btn = (text, data) => ({ text, callback_data: data });

function say(chat, text, rows = null) {
  const out = getHost().postMessage({ chat, user: father(), text, markup: rows ? kb(rows) : null });
  return out.message.id;
}

function edit(messageId, text, rows = null) {
  const m = getMessage(messageId);
  if (!m) return;
  q.run('UPDATE messages SET text = ?, markup = ?, edited_at = ? WHERE id = ?', text, rows ? kb(rows) : null, now(), m.id);
  emit(memberIds(m.chat_id), { type: EVENTS.MESSAGE_UPDATE, message: messageOut(getMessage(m.id)) });
}

const MENU_ROWS = [[btn('➕ Создать бота', 'new'), btn('🤖 Мои боты', 'list')]];

const HELP = 'Я BotGrandFather — создаю ботов и помогаю ими управлять.\n'
  + 'Men botlarni yaratish va boshqarishda yordam beraman.\n\n'
  + '/newbot — создать бота\n/mybots — мои боты\n/cancel — отмена';

function botsListRows(userId) {
  const bots = listOwnBots(userId);
  return {
    text: bots.length ? 'Выберите бота:' : 'У вас пока нет ботов. Нажмите «Создать бота».',
    rows: [...bots.map((b) => [btn(`@${b.username}`, `b:${b.id}`)]), [btn('➕ Создать бота', 'new')]],
  };
}

function botMenu(bot) {
  const cmds = JSON.parse(bot.bot_commands || '[]');
  return {
    text: `🤖 ${bot.name} (@${bot.username})\n`
      + `Описание: ${bot.bio || '—'}\nКоманды: ${cmds.length ? cmds.map((c) => `/${c.command}`).join(' ') : '—'}\n`
      + `Вебхук: ${bot.bot_webhook || 'не задан (используется getUpdates)'}`,
    rows: [
      [btn('🔑 Новый токен', `t:${bot.id}`), btn('📝 Описание', `d:${bot.id}`)],
      [btn('⌨️ Команды', `c:${bot.id}`), btn('🌐 Вебхук', `w:${bot.id}`)],
      [btn('🗑 Удалить бота', `x:${bot.id}`)],
      [btn('‹ Назад', 'list')],
    ],
  };
}

const API_HELP = (token) => `Токен (храните в секрете, он показывается один раз):\n${token}\n\n`
  + 'API: https://suhbat-dosh.uz/bot' + '<TOKEN>' + '/getMe\nДокументация: docs/BOTS.md';

const ERR = {
  invalid_bot_username: 'Username должен оканчиваться на bot, содержать латиницу, цифры и _ (от 5 символов). Попробуйте ещё раз.',
  username_taken: 'Такой username уже занят. Придумайте другой.',
  too_many_bots: 'Достигнут лимит ботов.',
  slow_down: 'Слишком часто. Подождите немного.',
  invalid_input: 'Недопустимое значение. Попробуйте ещё раз.',
  bad_commands: 'Формат: по одной команде в строке — «команда - описание».',
  bad_url: 'Нужен адрес вида https://… (или «-» чтобы убрать).',
};
const errText = (e) => ERR[e.code] || 'Не получилось. Попробуйте ещё раз.';

function parseCommands(text) {
  return text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const m = /^\/?([A-Za-z0-9_]+)\s*[-–—:]\s*(.+)$/.exec(l);
    return m ? { command: m[1], description: m[2] } : { command: l.replace(/^\//, ''), description: '' };
  });
}

/** Called for every message posted in a direct chat: reacts only when the other side is BotFather. */
export function handleFatherMessage(chat, row) {
  if (chat.type !== 'direct') return;
  const f = father();
  if (!row.sender_id || row.sender_id === f.id) return;
  if (!q.get('SELECT 1 AS x FROM members WHERE chat_id = ? AND user_id = ?', chat.id, f.id)) return;
  const user = getUser(row.sender_id);
  if (!user || user.is_bot) return;
  const text = (row.text || '').trim();
  const st = state.get(user.id);

  try {
    if (text.startsWith('/')) {
      const cmd = text.split(/\s|@/)[0].toLowerCase();
      if (cmd === '/cancel') { state.delete(user.id); say(chat, 'Отменено.', MENU_ROWS); return; }
      if (cmd === '/newbot') { state.set(user.id, { step: 'name', at: Date.now() }); say(chat, 'Как назвать бота? Отправьте имя, например «Мой помощник».'); return; }
      if (cmd === '/mybots') { const l = botsListRows(user.id); say(chat, l.text, l.rows); return; }
      say(chat, HELP, MENU_ROWS);
      return;
    }
    if (!st) { say(chat, HELP, MENU_ROWS); return; }
    st.at = Date.now();
    if (st.step === 'name') {
      if (text.length < 1 || text.length > 64) { say(chat, 'Имя должно быть от 1 до 64 символов.'); return; }
      st.name = text;
      st.step = 'username';
      say(chat, 'Теперь придумайте username. Он должен оканчиваться на «bot», например my_shop_bot.');
      return;
    }
    if (st.step === 'username') {
      try {
        const r = createBotAccount(user, st.name, text);
        state.delete(user.id);
        say(chat, `✅ Бот @${r.bot.username} создан!\n\n${API_HELP(r.token)}`, [[btn('⚙️ Настроить бота', `b:${r.bot.id}`)]]);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        if (e.code === 'too_many_bots') state.delete(user.id);
        say(chat, e.code === 'invalid_input' ? ERR.invalid_bot_username : errText(e));
      }
      return;
    }
    const bot = ownBot(user.id, st.botId);
    const back = [[btn('‹ К боту', `b:${bot.id}`)]];
    if (st.step === 'commands') {
      updateBotAccount(user, bot.id, { commands: text === '-' || text === '/empty' ? [] : parseCommands(text) });
      state.delete(user.id);
      say(chat, '✅ Команды обновлены. Пользователи увидят их по кнопке «/» в чате с ботом.', back);
    } else if (st.step === 'desc') {
      updateBotAccount(user, bot.id, { description: text === '-' ? '' : text });
      state.delete(user.id);
      say(chat, '✅ Описание обновлено.', back);
    } else if (st.step === 'hook') {
      updateBotAccount(user, bot.id, { webhook: text === '-' ? '' : text });
      state.delete(user.id);
      say(chat, text === '-' ? '✅ Вебхук отключён.' : '✅ Вебхук сохранён.', back);
    }
  } catch (e) {
    if (e instanceof HttpError) say(chat, errText(e));
    else throw e;
  }
}

async function onCallback(user, message, data) {
  const chat = q.get('SELECT * FROM chats WHERE id = ?', message.chat_id);
  const [op, rawId] = data.split(':');
  const id = rawId ? Number(rawId) : null;
  try {
    switch (op) {
      case 'new':
        state.set(user.id, { step: 'name', at: Date.now() });
        say(chat, 'Как назвать бота? Отправьте имя, например «Мой помощник».');
        return;
      case 'list': {
        const l = botsListRows(user.id);
        edit(message.id, l.text, l.rows);
        return;
      }
      case 'b': {
        const m = botMenu(ownBot(user.id, id));
        edit(message.id, m.text, m.rows);
        return;
      }
      case 't':
        edit(message.id, 'Выпустить новый токен? Старый перестанет работать сразу.', [[btn('Да, выпустить', `tok:${id}`), btn('Отмена', `b:${id}`)]]);
        return;
      case 'tok': {
        const bot = ownBot(user.id, id);
        const token = resetBotToken(user, id);
        edit(message.id, `🔑 Новый токен для @${bot.username} выпущен.`, [[btn('‹ К боту', `b:${id}`)]]);
        say(chat, API_HELP(token));
        return;
      }
      case 'c': {
        const bot = ownBot(user.id, id);
        state.set(user.id, { step: 'commands', botId: id, at: Date.now() });
        const cur = JSON.parse(bot.bot_commands || '[]').map((c) => `${c.command} - ${c.description}`).join('\n');
        say(chat, `Отправьте список команд, по одной в строке:\nstart - Запустить бота\nhelp - Помощь\n\nЧтобы очистить — отправьте «-».${cur ? `\n\nСейчас:\n${cur}` : ''}`);
        return;
      }
      case 'd':
        ownBot(user.id, id);
        state.set(user.id, { step: 'desc', botId: id, at: Date.now() });
        say(chat, 'Отправьте новое описание бота (до 200 символов) или «-», чтобы убрать.');
        return;
      case 'w':
        ownBot(user.id, id);
        state.set(user.id, { step: 'hook', botId: id, at: Date.now() });
        say(chat, 'Отправьте адрес вебхука (https://…) или «-», чтобы отключить. Бот будет получать обновления POST-запросами на этот адрес.');
        return;
      case 'x':
        edit(message.id, `Удалить бота @${ownBot(user.id, id).username} и все его чаты? Это нельзя отменить.`, [[btn('Да, удалить', `xok:${id}`), btn('Отмена', `b:${id}`)]]);
        return;
      case 'xok': {
        const bot = ownBot(user.id, id);
        deleteBotAccount(user, id);
        edit(message.id, `🗑 Бот @${bot.username} удалён.`, [[btn('🤖 Мои боты', 'list')]]);
        return;
      }
      default:
    }
  } catch (e) {
    if (e instanceof HttpError) say(chat, errText(e));
    else throw e;
  }
}
wireBotFatherCallbacks({ callback: onCallback });
