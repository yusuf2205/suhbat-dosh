// Who may do what in the console. The main administrator may do everything and hands out rights to the others, one by one.
// Anything not listed here belongs to the main administrator alone, so a new route is closed until somebody decides otherwise.
import { q } from './db.js';
import { HttpError } from './util.js';

export const ADMIN_PERMS = [
  { id: 'overview', label: 'Обзор и статистика', hint: 'Счётчики и графики активности' },
  { id: 'users_view', label: 'Видеть пользователей', hint: 'Список, профили, сессии' },
  { id: 'users_manage', label: 'Управлять пользователями', hint: 'Блокировка, завершение сессий, лимиты', needs: ['users_view'] },
  { id: 'users_delete', label: 'Удалять аккаунты', hint: 'Безвозвратно', needs: ['users_view'], danger: true },
  { id: 'chats_read', label: 'Читать переписку', hint: 'Сообщения и файлы людей; каждый просмотр идёт в журнал', danger: true },
  { id: 'chats_export', label: 'Выгружать переписку', hint: 'Скачивание и ссылки наружу', needs: ['chats_read'], danger: true },
  { id: 'journal', label: 'Журнал действий', hint: 'Кто, что и когда сделал' },
  { id: 'access', label: 'Регистрация и рассылка', hint: 'Приглашения, настройки регистрации, сообщение всем', danger: true },
  { id: 'bridge', label: 'Мост Telegram', hint: 'Кому разрешён и какие чаты копируются', danger: true },
  { id: 'server', label: 'Сервер и резервные копии', hint: 'Нагрузка, диск, создание копий. Восстановление только у главного админа' },
  { id: 'quality', label: 'Качество звонков', hint: 'Показатели связи' },
  { id: 'reports', label: 'Жалобы', hint: 'Просмотр и решение' },
];
const KNOWN = new Set(ADMIN_PERMS.map((p) => p.id));

const RULES = [
  ['GET', /^\/(overview|stats)$/, 'overview'],
  ['GET', /^\/users$/, 'users_view'],
  ['GET', /^\/users\/\d+$/, 'users_view'],
  ['POST', /^\/users\/\d+\/(ban|logout)$/, 'users_manage'],
  ['PUT', /^\/users\/\d+\/quota$/, 'users_manage'],
  ['DELETE', /^\/users\/\d+$/, 'users_delete'],
  ['GET', /^\/chats$/, 'chats_read'],
  ['GET', /^\/chats\/\d+(\/(messages|stats|find))?$/, 'chats_read'],
  ['GET', /^\/search$/, 'chats_read'],
  ['GET', /^\/files\/[^/]+$/, 'chats_read'],
  ['POST', /^\/messages\/\d+\/mark$/, 'chats_read'],
  ['DELETE', /^\/messages\/\d+\/mark$/, 'chats_read'],
  ['GET', /^\/chats\/\d+\/export$/, 'chats_export'],
  ['GET', /^\/exports(\/now)?$/, 'chats_export'],
  ['POST', /^\/exports$/, 'chats_export'],
  ['PATCH', /^\/exports\/\d+$/, 'chats_export'],
  ['DELETE', /^\/exports\/\d+$/, 'chats_export'],
  ['GET', /^\/audit$/, 'journal'],
  ['GET', /^\/settings$/, 'access'],
  ['PUT', /^\/settings$/, 'access'],
  ['GET', /^\/invites$/, 'access'],
  ['POST', /^\/invites$/, 'access'],
  ['DELETE', /^\/invites\/[^/]+$/, 'access'],
  ['POST', /^\/broadcast$/, 'access'],
  ['*', /^\/bridge(\/|$)/, 'bridge'],
  ['GET', /^\/(system|storage|integrity|backups|speed)$/, 'server'],
  ['POST', /^\/integrity\/run$/, 'server'],
  ['POST', /^\/backups$/, 'server'],
  ['POST', /^\/backups\/[^/]+\/verify$/, 'server'],
  ['GET', /^\/call-quality$/, 'quality'],
  ['GET', /^\/reports$/, 'reports'],
  ['POST', /^\/reports\/\d+\/resolve$/, 'reports'],
];

/** With nobody marked yet (the first administrator made by a script), the administrator is the main one. */
export function isOwner(u) {
  if (!u?.is_admin) return false;
  return !!u.admin_owner || !q.get('SELECT 1 AS x FROM users WHERE is_admin = 1 AND admin_owner = 1');
}

export function permsOf(u) {
  if (!u?.is_admin) return [];
  if (isOwner(u)) return ADMIN_PERMS.map((p) => p.id);
  try {
    const list = JSON.parse(u.admin_perms || '[]');
    return Array.isArray(list) ? list.filter((p) => KNOWN.has(p)) : [];
  } catch { return []; }
}

/** What was ticked, with what those rights cannot work without. */
export function cleanPerms(list) {
  if (!Array.isArray(list)) throw new HttpError(400, 'invalid_input');
  const out = new Set(list.filter((p) => KNOWN.has(p)));
  for (const p of ADMIN_PERMS) if (out.has(p.id)) for (const n of p.needs || []) out.add(n);
  return ADMIN_PERMS.map((p) => p.id).filter((id) => out.has(id));
}

export function adminGate(req, _res, next) {
  const u = req.user;
  if (!u?.is_admin) return next(new HttpError(403, 'forbidden'));
  if (isOwner(u) || req.path === '/me') return next();
  const rule = RULES.find(([method, re]) => (method === '*' || method === req.method) && re.test(req.path));
  if (!rule || !permsOf(u).includes(rule[2])) return next(new HttpError(403, 'no_permission'));
  // what the bridge copied from the main administrator's own Telegram stays closed too
  const bridged = /^\/bridge\/(\d+)/.exec(req.path);
  if (bridged && personHiddenFrom(Number(bridged[1]), u)) return next(new HttpError(403, 'no_permission'));
  return next();
}

export const READ_MODES = ['all', 'except', 'only'];
const PEOPLE = 'SELECT user_id FROM admin_read_people WHERE admin_id = ?';

/**
 * The chats closed to this administrator, as a condition on `chats c`.
 * The main administrator's personal conversations are always closed. "Except": a closed person closes every chat they are in or wrote in, so a group never shows what they said.
 * "Only": a chat opens when a listed person is in it. A deleted account or a former administrator sees nothing.
 */
export function hiddenChatSql(u) {
  if (!u?.is_admin) return { sql: '1', params: [] };
  if (isOwner(u)) return { sql: '0', params: [] };
  const main = `(c.type = 'direct' AND EXISTS (SELECT 1 FROM members x JOIN users o ON o.id = x.user_id WHERE x.chat_id = c.id AND o.admin_owner = 1))
    OR (c.imported_from IS NOT NULL AND COALESCE(c.owner_id, 0) IN (SELECT id FROM users WHERE admin_owner = 1))`;
  const inside = `EXISTS (SELECT 1 FROM members x WHERE x.chat_id = c.id AND x.user_id IN (${PEOPLE})) OR COALESCE(c.owner_id, 0) IN (${PEOPLE})`;
  if (u.admin_read_mode === 'only') return { sql: `(${main} OR NOT (${inside}))`, params: [u.id, u.id] };
  if (u.admin_read_mode === 'except') return { sql: `(${main} OR ${inside} OR EXISTS (SELECT 1 FROM messages x WHERE x.chat_id = c.id AND x.sender_id IN (${PEOPLE})))`, params: [u.id, u.id, u.id] };
  return { sql: `(${main})`, params: [] };
}

export function chatHiddenFrom(chatId, u) {
  const { sql, params } = hiddenChatSql(u);
  return !!q.get(`SELECT 1 AS x FROM chats c WHERE c.id = ? AND ${sql}`, chatId, ...params);
}

/** May this administrator take everything one person wrote? */
export function personHiddenFrom(personId, u) {
  if (isOwner(u)) return false;
  if (!u?.is_admin || q.get('SELECT 1 AS x FROM users WHERE id = ? AND admin_owner = 1', personId)) return true;
  const listed = !!q.get('SELECT 1 AS x FROM admin_read_people WHERE admin_id = ? AND user_id = ?', u.id, personId);
  return u.admin_read_mode === 'only' ? !listed : u.admin_read_mode === 'except' && listed;
}

/** Another administrator's account is out of reach for anybody but the main administrator. */
export function assertMayTouch(actor, target) {
  if (target.is_admin && !isOwner(actor) && target.id !== actor.id) throw new HttpError(403, 'no_permission');
}
