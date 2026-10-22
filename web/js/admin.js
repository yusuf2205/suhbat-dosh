// Super-admin console (separate window). All data comes from /api/admin/*, which the server restricts to admins.
import { h, clear } from './dom.js';
import './ripple.js';
import { icon } from './icons.js';

const root = document.getElementById('admin-root');
const fmtDT = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
const fmtBytes = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} МБ` : `${(n / 1073741824).toFixed(2)} ГБ`);

async function get(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(r.status);
  return r.json();
}

async function send(method, url, body) {
  const r = await fetch(url, {
    method, credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || r.status);
  return data;
}
const ERR = {
  cannot_self: 'Нельзя применить к самому себе', cannot_ban_admin: 'Нельзя применить к администратору', last_admin: 'Нельзя убрать последнего администратора',
  confirm_required: 'Нужно подтверждение',
};
const errMsg = (e) => ERR[e.message] || ('Ошибка: ' + e.message);
const state = { tab: 'overview', users: new Map(), chats: new Map(), live: null };

const uname = (id) => {
  if (id === null || id === undefined) return 'система';
  const u = state.users.get(Number(id));
  return u ? `${u.name}${u.username ? ` (@${u.username})` : ''}` : `#${id}`;
};
const chatName = (id) => {
  const c = state.chats.get(Number(id));
  return c ? c.title || `чат #${id}` : `чат #${id}`;
};
const userLink = (id) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); openUser(Number(id)); } }, uname(id));
const chatLink = (id) => h('a', { href: '#', onclick: (e) => { e.preventDefault(); openChat(Number(id)); } }, chatName(id));

// ---------------------------------------------------------------- event wording
const LABELS = {
  'auth.login': 'вошёл в систему', 'auth.logout': 'вышел из системы', 'user.register': 'зарегистрировался',
  'profile.update': 'изменил профиль', 'profile.avatar_set': 'сменил фото профиля', 'profile.avatar_remove': 'удалил фото профиля',
  'user.block': 'заблокировал пользователя', 'user.unblock': 'разблокировал пользователя', 'session.revoke': 'завершил сессию',
  'chat.create': 'создал чат', 'chat.update': 'изменил чат', 'chat.member_add': 'добавил участника', 'chat.member_remove': 'удалил участника',
  'chat.member_update': 'изменил права участника', 'chat.leave': 'покинул чат', 'chat.invite_reset': 'сбросил ссылку-приглашение',
  'chat.join_by_link': 'вступил по ссылке', 'message.send': 'отправил сообщение', 'message.edit': 'изменил сообщение',
  'message.delete': 'удалил сообщение', 'chat.pin': 'закрепил сообщение', 'chat.unpin': 'открепил сообщение',
  'admin.view_user': 'открыл профиль пользователя (админ)', 'admin.view_chat': 'открыл переписку (админ)',
  'call.start': 'начал звонок', 'call.end': 'завершил звонок', 'call.quality': 'показатели качества звонка',
  'admin.ban_user': 'заблокировал аккаунт (админ)', 'admin.unban_user': 'разблокировал аккаунт (админ)', 'admin.delete_user': 'удалил аккаунт (админ)',
  'admin.logout_user': 'завершил все сессии (админ)', 'admin.grant_admin': 'выдал права администратора', 'admin.revoke_admin': 'снял права администратора',
  'admin.settings': 'изменил настройки сервера', 'admin.invite_create': 'создал приглашение', 'admin.broadcast': 'сделал рассылку',
  'admin.backup_create': 'создал резервную копию', 'admin.backup_restore': 'восстановил из резервной копии', 'admin.backup_delete': 'удалил резервную копию',
  'admin.backup_download': 'скачал резервную копию',
  'admin.view_file': 'открыл файл (админ)', 'admin.grant': 'выдано право администратора', 'admin.revoke': 'отозвано право администратора',
};
const FIELD = { name: 'имя', bio: 'о себе', status: 'статус', username: 'username', privacy_photo: 'приватность фото', privacy_status: 'приватность статуса', privacy_last_seen: 'приватность «был(а)»' };

function diff(a, b) {
  return h('span', { class: 'diff' }, h('del', null, a === null || a === '' ? '∅' : String(a)), ' → ', h('ins', null, b === null || b === '' ? '∅' : String(b)));
}

function describe(ev) {
  const d = ev.details || {};
  const out = [];
  switch (ev.action) {
    case 'profile.update':
      for (const [k, [a, b]] of Object.entries(d.changed || {})) out.push(h('div', null, `${FIELD[k] || k}: `, diff(a, b)));
      break;
    case 'message.edit':
      out.push(h('div', null, diff(d.old, d.new)));
      break;
    case 'message.delete':
      out.push(h('div', null, h('span', { class: 'pill warn' }, d.deleted_by_author ? 'автором' : 'администратором чата'), ' ',
        'текст: ', h('b', null, d.text || (d.file ? `[файл ${d.file.name}]` : '[пусто]'))));
      break;
    case 'message.send':
      out.push(h('div', null, d.file ? `файл «${d.file.name}» (${fmtBytes(d.file.size)}) ` : '', d.kind && d.kind !== 'text' ? h('span', { class: 'pill' }, d.kind) : '',
        d.forwarded_from ? ` переслано от ${d.forwarded_from}` : '', d.length ? ` · ${d.length} симв.` : ''));
      break;
    case 'chat.create':
      out.push(h('div', null, `${d.type === 'direct' ? 'личный' : d.type === 'channel' ? 'канал' : 'группа'}${d.title ? ` «${d.title}»` : ''}`,
        d.with ? [' с ', userLink(d.with)] : ''));
      break;
    case 'chat.update':
      out.push(h('div', null, d.before?.title !== d.after?.title && d.after?.title !== undefined ? ['название: ', diff(d.before.title, d.after.title), ' '] : '',
        d.after?.description !== undefined && d.before?.description !== d.after.description ? ['описание: ', diff(d.before.description, d.after.description)] : ''));
      break;
    case 'chat.member_update':
      out.push(h('div', null, Object.entries(d).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => `${k}=${v} `)));
      break;
    case 'chat.member_remove':
      if (d.ban) out.push(h('span', { class: 'pill warn' }, 'с блокировкой'));
      break;
    case 'admin.view_file': out.push(h('div', null, d.name || '')); break;
    case 'call.quality':
      out.push(h('div', null, `RTT ${d.rtt_ms ?? '—'} мс (макс ${d.rtt_max_ms ?? '—'}) · потери ${d.loss_pct ?? '—'}% · джиттер ${d.jitter_ms ?? '—'} мс · ${d.width ?? '?'}×${d.height ?? '?'}@${d.fps ?? '?'} · ${d.kbps_in ?? '—'}/${d.kbps_out ?? '—'} кбит/с · ${d.codec || '?'}${d.relay ? ' · через TURN' : ' · напрямую'} · режим ${d.quality_mode || '—'} · переподключений ${d.reconnects ?? 0}`));
      break;
    case 'call.end': out.push(h('div', null, `${d.video ? 'видео' : 'аудио'} · ${d.status}${d.duration ? ` · ${d.duration} с` : ''}`)); break;
    default:
  }
  return out;
}

function targetOf(ev) {
  if (ev.target_type === 'user' && ev.target_id) return [' → ', userLink(ev.target_id)];
  return '';
}

function eventRow(ev, { showChat = true } = {}) {
  return h('tr', null,
    h('td', { class: 'ev-time' }, fmtDT(ev.ts)),
    h('td', null, ev.actor ? userLink(ev.actor.id) : 'система'),
    h('td', null, LABELS[ev.action] || ev.action, targetOf(ev)),
    h('td', null, showChat && ev.chat_id ? chatLink(ev.chat_id) : '', describe(ev)),
    h('td', { class: 'mono' }, ev.ip || ''));
}

function eventsTable(events, opts) {
  return h('div', { class: 'tablewrap' }, h('table', { class: 't' },
    h('thead', null, h('tr', null, ['Когда', 'Кто', 'Что сделал', 'Где / подробности', 'IP'].map((x) => h('th', null, x)))),
    h('tbody', null, events.length ? events.map((e) => eventRow(e, opts)) : h('tr', null, h('td', { colSpan: 5, class: 'muted' }, 'Событий нет')))));
}

// ---------------------------------------------------------------- views
function setView(...nodes) {
  stopLive();
  clear(view).append(...nodes.flat());
  window.scrollTo(0, 0);
}

async function loadDirectories() {
  const [u, c] = await Promise.all([get('/api/admin/users'), get('/api/admin/chats')]);
  state.users = new Map(u.users.map((x) => [x.id, x]));
  state.chats = new Map(c.chats.map((x) => [x.id, x]));
  return { users: u.users, chats: c.chats };
}

// ---- small SVG chart helpers (no libraries; presentation attributes only, so CSP stays strict)
const NS = 'http://www.w3.org/2000/svg';
function svgEl(name, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, name);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const k of kids) if (k) el.append(k);
  return el;
}
const fmtDay = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

function areaChart(days, values, label) {
  const W = 720, H = 240, L = 36, R = 14, T = 16, B = 28;
  const max = Math.max(4, ...values);
  const niceMax = Math.ceil(max / 4) * 4;
  const x = (i) => L + (i * (W - L - R)) / Math.max(1, values.length - 1);
  const y = (v) => T + (1 - v / niceMax) * (H - T - B);
  const pts = values.map((v, i) => [x(i), y(v)]);
  let line = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1]; const [x1, y1] = pts[i]; const cx = (x0 + x1) / 2;
    line += ` C${cx},${y0} ${cx},${y1} ${x1},${y1}`;
  }
  const area = `${line} L${pts[pts.length - 1][0]},${H - B} L${pts[0][0]},${H - B} Z`;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img', 'aria-label': label });
  const grad = svgEl('linearGradient', { id: 'ag', x1: 0, y1: 0, x2: 0, y2: 1 },
    svgEl('stop', { offset: 0, 'stop-color': '#fbc700', 'stop-opacity': '.45' }), svgEl('stop', { offset: 1, 'stop-color': '#fbc700', 'stop-opacity': '0' }));
  svg.append(svgEl('defs', {}, grad));
  for (let i = 0; i <= 4; i++) {
    const gy = T + (i * (H - T - B)) / 4;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: gy, y2: gy, class: 'grid' }));
    const t = svgEl('text', { x: L - 8, y: gy + 4, class: 'axis', 'text-anchor': 'end' }); t.textContent = String(Math.round(niceMax - (i * niceMax) / 4));
    svg.append(t);
  }
  const step = Math.ceil(values.length / 7);
  days.forEach((d, i) => {
    if (i % step && i !== values.length - 1) return;
    const t = svgEl('text', { x: x(i), y: H - 8, class: 'axis', 'text-anchor': 'middle' }); t.textContent = fmtDay(d);
    svg.append(t);
  });
  svg.append(svgEl('path', { d: area, fill: 'url(#ag)' }), svgEl('path', { d: line, class: 'line', fill: 'none' }));
  const dot = svgEl('circle', { r: 5, class: 'dot', cx: pts[pts.length - 1][0], cy: pts[pts.length - 1][1] });
  const vline = svgEl('line', { class: 'vline', y1: T, y2: H - B, x1: -10, x2: -10 });
  svg.append(vline, dot);
  const wrap = h('div', { class: 'chart-wrap' }, svg);
  const tip = h('div', { class: 'chart-tip', hidden: true });
  wrap.append(tip);
  wrap.addEventListener('mousemove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    let i = Math.round(((px - L) / (W - L - R)) * (values.length - 1));
    i = Math.max(0, Math.min(values.length - 1, i));
    vline.setAttribute('x1', String(pts[i][0])); vline.setAttribute('x2', String(pts[i][0]));
    dot.setAttribute('cx', String(pts[i][0])); dot.setAttribute('cy', String(pts[i][1]));
    tip.hidden = false; tip.textContent = `${fmtDay(days[i])} · ${values[i]}`;
    tip.style.left = `${(pts[i][0] / W) * r.width}px`; tip.style.top = `${(pts[i][1] / H) * r.height - 34}px`;
  });
  wrap.addEventListener('mouseleave', () => { tip.hidden = true; });
  return wrap;
}

function donut(parts, centerBig, centerSmall) {
  const total = parts.reduce((a, p) => a + p.v, 0) || 1;
  const R = 52, C = 2 * Math.PI * R;
  const svg = svgEl('svg', { viewBox: '0 0 140 140', class: 'donut', role: 'img' });
  svg.append(svgEl('circle', { cx: 70, cy: 70, r: R, fill: 'none', class: 'donut-bg', 'stroke-width': 18 }));
  let off = 0;
  for (const p of parts) {
    const len = (p.v / total) * C;
    const dash = Math.max(0, len - 2);
    if (len > 0) svg.append(svgEl('circle', {
      cx: 70, cy: 70, r: R, fill: 'none', stroke: p.c, 'stroke-width': 18, 'stroke-dasharray': `${dash} ${C - dash}`,
      'stroke-dashoffset': -off, transform: 'rotate(-90 70 70)',
    }));
    off += len;
  }
  const t1 = svgEl('text', { x: 70, y: 68, 'text-anchor': 'middle', class: 'donut-big' }); t1.textContent = centerBig;
  const t2 = svgEl('text', { x: 70, y: 86, 'text-anchor': 'middle', class: 'donut-small' }); t2.textContent = centerSmall;
  svg.append(t1, t2);
  return svg;
}

const KIND_NAMES = { text: 'Текст', image: 'Фото', video: 'Видео', audio: 'Аудио', voice: 'Голосовые', file: 'Файлы', call: 'Звонки', system: 'Служебные' };
const KIND_COLORS = ['#fbc700', '#2b2b2e', '#22b573', '#3b82f6', '#f97316', '#a855f7', '#ef4444', '#94a3b8'];
const SERIES = [
  ['messages', 'Сообщения'], ['events', 'Все события'], ['logins', 'Входы'], ['calls', 'Звонки'], ['users', 'Новые пользователи'],
];

function kpi(ico, tone, value, label, hint, go) {
  return h('button', { class: 'kpi', type: 'button', onclick: go, 'aria-label': `${label}: ${value}` },
    h('span', { class: `kpi-ico ${tone}` }, icon(ico, 22)),
    h('div', { class: 'kpi-body' }, h('span', { class: 'kpi-label' }, label), h('b', { class: 'kpi-val' }, String(value)),
      hint ? h('span', { class: 'kpi-hint' }, hint) : null));
}

const sum = (a) => a.reduce((x, y) => x + y, 0);
function initials(name) { return (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || '').join(''); }

// CSP forbids style attributes in markup, so widths/colours are applied through the CSSOM after rendering.
function applyDynamicStyles() {
  document.querySelectorAll('[data-w]').forEach((el) => { el.style.width = `${el.dataset.w}%`; });
  document.querySelectorAll('.sw[data-c]').forEach((el) => { el.style.background = el.dataset.c; });
}

const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 60 ? `${m} мин назад` : m < 2880 ? `${Math.round(m / 60)} ч назад` : `${Math.round(m / 1440)} дн. назад`;
};
const upFor = (sec) => (sec < 3600 ? `${Math.round(sec / 60)} мин` : sec < 172800 ? `${Math.round(sec / 3600)} ч` : `${Math.round(sec / 86400)} дн.`);

/** The dark top card: greeting, the three numbers that matter now, and the date. */
function heroCard(o, st) {
  const hr = new Date().getHours();
  const hello = hr < 5 ? 'Доброй ночи' : hr < 12 ? 'Доброе утро' : hr < 18 ? 'Добрый день' : 'Добрый вечер';
  const big = (v, l) => h('div', { class: 'hero-num' }, h('b', null, String(v)), h('span', null, l));
  return h('section', { class: 'adm-hero' },
    h('div', { class: 'hero-text' }, h('span', { class: 'hero-hi' }, hello), h('h2', null, 'Вот что происходит на сервере'),
      h('span', { class: 'hero-date' }, new Date().toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' }))),
    h('div', { class: 'hero-nums' }, big(st.online, 'в сети сейчас'), big(o.messages_24h, 'сообщений за сутки'), big(`+${o.new_users_7d}`, 'новых за неделю')));
}

/** What needs a look (only real problems are highlighted) and which parts of the server are running. */
function attentionPanels(o) {
  const a = o.attention;
  const items = [];
  const add = (tone, ico, text, hint, go) => items.push(h('button', { class: `att-row ${tone}`, type: 'button', onclick: go }, h('span', { class: 'att-ico' }, icon(ico, 18)), h('span', { class: 'att-text' }, h('b', null, text), hint ? h('small', null, hint) : null), icon('chevron', 16)));
  if (a.reports_open) add('warn', 'shield', `Жалоб без ответа: ${a.reports_open}`, 'Нужно посмотреть и решить', () => setTab('reports'));
  const diskPct = a.disk_total ? Math.round((a.disk_free / a.disk_total) * 100) : 100;
  if (diskPct < 15) add('bad', 'disk', `Мало места: свободно ${diskPct}%`, `${fmtBytes(a.disk_free)} из ${fmtBytes(a.disk_total)}`, () => setTab('server'));
  if (!a.last_backup_at) add('bad', 'disk', 'Резервных копий нет', 'Сделайте первую копию', () => setTab('server'));
  else if (Date.now() - a.last_backup_at > 2 * 86400_000) add('warn', 'disk', 'Давно не было резервной копии', ago(a.last_backup_at), () => setTab('server'));
  if (a.failed_logins_24h >= 10) add('warn', 'lock', `Неудачных входов за сутки: ${a.failed_logins_24h}`, 'Возможен подбор пароля', () => { state.preset = { action: 'auth.login_failed' }; setTab('journal'); });
  if (a.banned) add('info', 'block', `Заблокировано аккаунтов: ${a.banned}`, null, () => setTab('users'));
  if (o.registration === 'open') add('info', 'users', 'Регистрация открыта для всех', 'Можно ограничить по приглашениям', () => setTab('access'));
  const ok = !items.some((x) => /warn|bad/.test(x.className));
  const svc = (name, on, hint) => h('div', { class: 'svc' }, h('span', { class: `svc-dot ${on ? 'on' : 'off'}` }), h('span', null, name), h('small', { class: 'muted' }, on ? 'работает' : hint));
  const bar = (label, v) => h('div', { class: 'mtr' }, h('span', null, label), h('i', null, h('u', { dataset: { w: String(Math.min(100, Math.round(v))) } })), h('b', null, `${Math.round(v)}%`));
  return h('div', { class: 'row-2 even' },
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Требует внимания'), h('span', { class: `att-badge ${ok ? 'ok' : 'warn'}` }, ok ? 'всё в порядке' : 'есть что проверить')),
      items.length ? h('div', { class: 'att-list' }, items) : h('p', { class: 'muted' }, 'Жалоб, проблем с диском и копиями нет.')),
    h('section', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Службы и нагрузка'), h('span', { class: 'muted' }, `работает ${upFor(a.uptime)}`)),
      h('div', { class: 'svc-grid' },
        svc('Звонки (TURN)', a.services.calls, 'не настроено'), svc('Расшифровка речи', a.services.speech, 'выключена'),
        svc('Перевод', a.services.translate, 'выключен'), svc('Поиск по смыслу', a.services.search, 'выключен')),
      h('div', { class: 'mtrs' }, bar('Процессор', a.cpu), bar('Память', a.mem), bar('Диск занят', 100 - diskPct))));
}

async function viewOverview() {
  const tz = -new Date().getTimezoneOffset();
  const [o, st, , ev] = await Promise.all([get('/api/admin/overview'), get(`/api/admin/stats?tz=${tz}&days=14`), loadDirectories(), get('/api/admin/audit?limit=12')]);
  let series = 'messages';
  const chartHolder = h('div');
  const totalLabel = h('span', { class: 'muted' });
  const tabs = h('div', { class: 'chips' }, SERIES.map(([k, l]) => h('button', {
    class: 'chip', type: 'button', 'aria-pressed': String(k === series),
    onclick: (e) => { series = k; tabs.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); drawChart(); },
  }, l)));
  function drawChart() {
    const vals = st.series[series];
    clear(chartHolder).append(areaChart(st.days, vals, SERIES.find((x) => x[0] === series)[1]));
    totalLabel.textContent = `за 14 дней: ${sum(vals)}`;
  }
  drawChart();

  const kinds = Object.entries(st.kinds).sort((a, b) => b[1] - a[1]);
  const parts = kinds.map(([k, v], i) => ({ k, v, c: KIND_COLORS[i % KIND_COLORS.length] }));
  const totalWeek = sum(parts.map((p) => p.v));
  const maxTop = Math.max(1, ...st.top_users.map((u) => u.n));
  const feed = h('div', { class: 'feed' });
  const drawFeed = (events) => clear(feed).append(...(events.length ? events.map((e) => h('div', { class: 'feed-row' },
    h('span', { class: 'feed-dot' }),
    h('div', { class: 'feed-body' },
      h('div', null, h('b', null, e.actor ? userLink(e.actor.id) : 'система'), ' ', LABELS[e.action] || e.action, targetOf(e), e.chat_id ? [' · ', chatLink(e.chat_id)] : ''),
      h('span', { class: 'muted' }, fmtDT(e.ts))))) : [h('p', { class: 'muted' }, 'Событий пока нет')]));
  drawFeed(ev.events);

  const today = st.series.messages[st.series.messages.length - 1];
  setView(
    heroCard(o, st),
    attentionPanels(o),
    h('div', { class: 'kpis' },
      kpi('users', 'tone-gold', o.users, 'Пользователи', `+${o.new_users_7d} за 7 дней`, () => setTab('users')),
      kpi('bolt', 'tone-green', st.online, 'В сети сейчас', `${o.active_sessions} активных сессий`, () => { state.preset = { onlineOnly: true }; setTab('users'); }),
      kpi('chat', 'tone-blue', o.messages, 'Сообщений всего', `сегодня ${today} · за 24 ч ${o.messages_24h}`, () => { state.preset = { action: 'message' }; setTab('journal'); }),
      kpi('grid', 'tone-violet', o.chats, 'Чатов', `${st.chat_types.direct || 0} личных · ${st.chat_types.group || 0} групп · ${st.chat_types.channel || 0} каналов`, () => setTab('chats')),
      kpi('disk', 'tone-orange', fmtBytes(o.storage_bytes), 'Хранилище', `${o.files} файлов · открыть чаты`, () => setTab('chats')),
      kpi('shield', 'tone-red', o.events_24h, 'Событий за 24 ч', `${o.admins} админ${o.admins === 1 ? '' : 'ов'}`, () => { state.preset = {}; setTab('journal'); })),
    h('div', { class: 'row-2' },
      h('section', { class: 'panel wide' },
        h('div', { class: 'panel-head' }, h('h2', null, icon('trend', 18), 'Активность'), totalLabel), tabs, chartHolder),
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Состав сообщений'), h('span', { class: 'muted' }, '7 дней')),
        totalWeek ? h('div', { class: 'donut-box' }, donut(parts, String(totalWeek), 'сообщений'),
          h('ul', { class: 'legend' }, parts.map((p) => h('li', null, h('span', { class: 'sw', dataset: { c: p.c } }), h('span', null, KIND_NAMES[p.k] || p.k), h('b', null, String(p.v)))))) :
          h('p', { class: 'muted' }, 'За неделю сообщений ещё не было'))),
    h('div', { class: 'row-3' },
      h('section', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Самые активные'), h('span', { class: 'muted' }, '7 дней')),
        st.top_users.length ? h('div', { class: 'toplist' }, st.top_users.map((u, i) => h('a', { class: 'top-row', href: '#', onclick: (e) => { e.preventDefault(); openUser(u.id); } },
          h('span', { class: 'rank' }, String(i + 1)),
          h('span', { class: 'av' }, u.avatar ? h('img', { src: u.avatar, alt: '' }) : initials(u.name)),
          h('span', { class: 'top-main' }, h('b', null, u.name), h('span', { class: 'bar' }, h('i', { dataset: { w: String(Math.round((u.n / maxTop) * 100)) } }))),
          h('b', { class: 'top-n' }, String(u.n))))) : h('p', { class: 'muted' }, 'Нет данных')),
      h('section', { class: 'panel span-2' },
        h('div', { class: 'panel-head' }, h('h2', null, icon('list', 18), 'Последние события'),
          h('a', { href: '#', class: 'link-more', onclick: (e) => { e.preventDefault(); setTab('journal'); } }, 'Весь журнал →')),
        feed)),
    h('div', { class: 'note' }, icon('shield', 18), h('span', null, 'Журнал фиксирует вход и выход, изменения профилей и чатов, отправку, правку и удаление сообщений (с прежним текстом). Просмотр переписки администратором тоже записывается.')),
  );
  applyDynamicStyles();
  startLive(async () => { drawFeed((await get('/api/admin/audit?limit=12')).events); }, 8000);
}

async function viewUsers() {
  const { users } = await loadDirectories();
  const body = h('tbody');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Имя, @username или телефон' });
  let onlineOnly = !!state.preset?.onlineOnly;
  state.preset = null;
  const onlineChip = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(onlineOnly), onclick: () => { onlineOnly = !onlineOnly; onlineChip.setAttribute('aria-pressed', String(onlineOnly)); draw(); } }, 'Только в сети');
  const draw = () => {
    const t = search.value.trim().toLowerCase();
    clear(body).append(...users.filter((u) => (!onlineOnly || u.online) && (!t || [u.name, u.username, u.phone].some((x) => (x || '').toLowerCase().includes(t)))).map((u) =>
      h('tr', { class: 'click', onclick: () => openUser(u.id) },
        h('td', null, h('b', null, u.name), u.is_admin ? [' ', h('span', { class: 'pill ok' }, 'админ')] : '', u.is_bot ? [' ', h('span', { class: 'pill' }, 'бот')] : '', u.banned ? [' ', h('span', { class: 'pill warn' }, 'заблокирован')] : ''),
        h('td', null, u.username ? `@${u.username}` : ''), h('td', { class: 'mono' }, u.phone),
        h('td', null, u.online ? h('span', { class: 'pill ok' }, 'в сети') : fmtDT(u.last_seen)),
        h('td', null, String(u.messages)), h('td', null, String(u.chats)), h('td', null, String(u.sessions)), h('td', { class: 'ev-time' }, u.quota ? `${fmtBytes(u.storage || 0)} / ${fmtBytes(u.quota)}` : fmtBytes(u.storage || 0)), h('td', { class: 'ev-time' }, fmtDT(u.created_at)))));
  };
  search.addEventListener('input', draw);
  draw();
  setView(h('div', { class: 'toolbar' }, search, onlineChip),
    h('div', { class: 'panel tablewrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Имя', 'Username', 'Телефон', 'Был(а) / в сети', 'Сообщений', 'Чатов', 'Сессий', 'Файлы', 'Регистрация'].map((x) => h('th', null, x)))), body)));
}

async function openUser(id) {
  setTab('users', false);
  const [d, ev] = await Promise.all([get(`/api/admin/users/${id}`), get(`/api/admin/audit?actor=${id}&limit=100`)]);
  const u = d.user;
  const run = (label, fn, after) => async () => {
    if (label && !confirm(label)) return;
    try { await fn(); await (after ? after() : openUser(id)); } catch (e) { alert(errMsg(e)); }
  };
  const reasonBox = h('input', { class: 'input', placeholder: 'Причина блокировки (необязательно)', maxLength: 200 });
  const actions = h('div', { class: 'panel' }, h('h2', null, 'Управление аккаунтом'),
    u.banned_at ? h('p', null, h('span', { class: 'pill warn' }, 'Заблокирован'), ' ', fmtDT(u.banned_at), u.ban_reason ? ` · ${u.ban_reason}` : '') : '',
    h('div', { class: 'toolbar' },
      u.banned_at
        ? h('button', { class: 'btn', type: 'button', onclick: run(null, () => send('POST', `/api/admin/users/${id}/ban`, { banned: false })) }, 'Разблокировать')
        : [reasonBox, h('button', { class: 'btn danger', type: 'button', onclick: run('Заблокировать аккаунт? Все сессии будут завершены.', () => send('POST', `/api/admin/users/${id}/ban`, { banned: true, reason: reasonBox.value })) }, 'Заблокировать')],
      h('button', { class: 'btn secondary', type: 'button', onclick: run('Завершить все сессии пользователя?', () => send('POST', `/api/admin/users/${id}/logout`)) }, 'Завершить все сессии'),
      u.is_bot ? '' : h('button', { class: 'btn secondary', type: 'button', onclick: run(u.is_admin ? 'Снять права администратора?' : 'Выдать права администратора?', () => send('POST', `/api/admin/users/${id}/admin`, { is_admin: !u.is_admin })) }, u.is_admin ? 'Снять админа' : 'Сделать админом'),
      h('button', { class: 'btn danger', type: 'button', onclick: run('Удалить аккаунт навсегда? Личные чаты будут удалены, сообщения в группах останутся.', () => send('DELETE', `/api/admin/users/${id}`), () => setTab('users')) }, 'Удалить аккаунт')));
  const dir = state.users.get(id) || {};
  const qIn = h('input', { class: 'input', type: 'number', min: 0, placeholder: 'МБ (пусто — как у всех, 0 — без лимита)', 'aria-label': 'Лимит хранилища, МБ',
    value: dir.quota ? Math.round(dir.quota / 1048576) : '' });
  const quotaPanel = h('div', { class: 'panel' }, h('h2', null, icon('disk', 18), 'Хранилище пользователя'),
    h('p', null, `Занято файлами в чатах: ${fmtBytes(dir.storage || 0)}${dir.quota ? ` из ${fmtBytes(dir.quota)}` : ' (без лимита)'}`),
    h('div', { class: 'toolbar' }, qIn, h('button', { class: 'btn', type: 'button', onclick: run(null, () => send('PUT', `/api/admin/users/${id}/quota`, { mb: qIn.value === '' ? null : Number(qIn.value) })) }, 'Сохранить лимит')));
  setView(
    h('div', { class: 'crumb' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); setTab('users'); } }, '← Пользователи')),
    h('div', { class: 'grid2' },
      h('div', { class: 'panel' }, h('h2', null, u.name, u.is_admin ? [' ', h('span', { class: 'pill ok' }, 'админ')] : ''),
        u.avatar ? h('img', { src: u.avatar, alt: '', style: { width: '96px', height: '96px', borderRadius: '50%', objectFit: 'cover' } }) : '',
        h('p', null, 'Телефон: ', h('b', { class: 'mono' }, u.phone)), h('p', null, 'Username: ', u.username ? `@${u.username}` : '—'),
        h('p', null, 'Статус: ', u.status || '—'), h('p', null, 'О себе: ', u.bio || '—'),
        h('p', null, 'Регистрация: ', fmtDT(u.created_at)), h('p', null, 'Последний визит: ', u.online ? 'в сети' : fmtDT(u.last_seen)),
        h('p', { class: 'muted' }, `Приватность: фото — ${u.privacy.photo}, статус — ${u.privacy.status}, был(а) — ${u.privacy.last_seen}`),
        d.blocks.length ? h('p', null, 'Заблокировал: ', d.blocks.map((b) => b.name).join(', ')) : ''),
      h('div', { class: 'panel' }, h('h2', null, `Сессии (${d.sessions.length})`),
        h('div', { class: 'tablewrap' }, h('table', { class: 't' },
          h('thead', null, h('tr', null, ['Устройство', 'IP', 'Создана', 'Активность', ''].map((x) => h('th', null, x)))),
          h('tbody', null, d.sessions.map((s) => h('tr', null, h('td', null, s.device.slice(0, 70) || '—'), h('td', { class: 'mono' }, s.ip),
            h('td', { class: 'ev-time' }, fmtDT(s.created_at)), h('td', { class: 'ev-time' }, fmtDT(s.last_active)),
            h('td', null, s.revoked ? h('span', { class: 'pill' }, 'завершена') : h('span', { class: 'pill ok' }, 'активна')))))))),
    ),
    actions,
    quotaPanel,
    h('div', { class: 'panel' }, h('h2', null, `Чаты (${d.chats.length})`),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Чат', 'Тип', 'Роль', 'Написал сообщений', 'Вступил'].map((x) => h('th', null, x)))),
        h('tbody', null, d.chats.map((c) => h('tr', { class: 'click', onclick: () => openChat(c.id) },
          h('td', null, c.title || `#${c.id}`, c.banned ? [' ', h('span', { class: 'pill warn' }, 'заблокирован')] : ''),
          h('td', null, c.type), h('td', null, c.role), h('td', null, String(c.sent)), h('td', { class: 'ev-time' }, fmtDT(c.joined_at)))))))),
    h('div', { class: 'panel' }, h('h2', null, 'Журнал действий пользователя'), eventsTable(ev.events)),
  );
}

async function viewChats() {
  const { chats } = await loadDirectories();
  const body = h('tbody');
  const search = h('input', { class: 'input', type: 'search', placeholder: 'Название чата или имя собеседника' });
  const draw = () => {
    const t = search.value.trim().toLowerCase();
    clear(body).append(...chats.filter((c) => !t || (c.title || '').toLowerCase().includes(t)).map((c) =>
      h('tr', { class: 'click', onclick: () => openChat(c.id) },
        h('td', null, h('b', null, c.title || `#${c.id}`)),
        h('td', null, c.type === 'direct' ? 'личный' : c.type === 'channel' ? 'канал' : 'группа'),
        h('td', null, String(c.members)), h('td', null, String(c.messages)),
        h('td', null, c.owner ? c.owner.name : '—'), h('td', { class: 'ev-time' }, fmtDT(c.last_message_at)))));
  };
  search.addEventListener('input', draw);
  draw();
  setView(h('div', { class: 'toolbar' }, search),
    h('div', { class: 'panel tablewrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Чат', 'Тип', 'Участников', 'Сообщений', 'Владелец', 'Последняя активность'].map((x) => h('th', null, x)))), body)));
}

function messageNode(m) {
  const kindIcon = { image: '🖼', video: '🎬', audio: '🎵', voice: '🎤', file: '' }[m.kind] || '';
  return h('div', { class: 'amsg' },
    h('div', null, h('div', { class: 'who' }, m.sender ? userLink(m.sender.id) : '—'),
      h('div', { class: 'when' }, fmtDT(m.created_at), m.edited_at ? ` · изм. ${fmtDT(m.edited_at)}` : '')),
    h('div', null,
      m.forward_from ? h('div', { class: 'muted' }, `Переслано от ${m.forward_from}`) : '',
      m.reply_to ? h('div', { class: 'muted' }, `↩ ${m.reply_to.sender_name || ''}: ${m.reply_to.text}`) : '',
      m.kind === 'call' ? h('div', { class: 'body' }, `📞 Звонок: ${m.text.replace(':video', ' (видео)')}${m.duration ? `, ${m.duration} с` : ''}`) : '',
      m.text && m.kind !== 'call' ? h('div', { class: 'body' }, m.text) : '',
      m.file ? h('div', null, kindIcon, ' ', h('a', { href: `/api/admin/files/${m.file.id}`, target: '_blank', rel: 'noopener' }, m.file.name), ` (${fmtBytes(m.file.size)})`,
        m.kind === 'image' ? h('img', { src: `/api/admin/files/${m.file.id}`, alt: '', loading: 'lazy' }) : '') : '',
      m.edits.length ? h('div', { class: 'edits' }, h('b', null, 'История изменений:'),
        m.edits.map((e) => h('div', null, fmtDT(e.ts), ': ', diff(e.old, e.new)))) : ''));
}

async function openChat(id) {
  setTab('chats', false);
  const [info, hist] = await Promise.all([get(`/api/admin/chats/${id}`), get(`/api/admin/chats/${id}/messages?limit=100`)]);
  const list = h('div');
  let oldest = hist.messages[0]?.id;
  let more = hist.has_more;
  const moreBtn = h('button', { class: 'btn secondary', type: 'button', hidden: !more }, 'Загрузить более ранние');
  list.append(...hist.messages.map(messageNode));
  moreBtn.onclick = async () => {
    const r = await get(`/api/admin/chats/${id}/messages?limit=100&before=${oldest}`);
    list.prepend(...r.messages.map(messageNode));
    oldest = r.messages[0]?.id ?? oldest;
    moreBtn.hidden = !r.has_more;
  };
  const c = info.chat;
  setView(
    h('div', { class: 'crumb' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); setTab('chats'); } }, '← Чаты')),
    h('div', { class: 'panel' }, h('h2', null, c.title || state.chats.get(id)?.title || `Чат #${id}`),
      h('p', { class: 'muted' }, `${c.type} · создан ${fmtDT(c.created_at)}${c.description ? ` · ${c.description}` : ''}`),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Участник', 'Телефон', 'Роль', 'Вступил', ''].map((x) => h('th', null, x)))),
        h('tbody', null, info.members.map((m) => h('tr', null, h('td', null, userLink(m.id)), h('td', { class: 'mono' }, m.phone), h('td', null, m.role),
          h('td', { class: 'ev-time' }, fmtDT(m.joined_at)), h('td', null, m.banned ? h('span', { class: 'pill warn' }, 'заблокирован') : m.can_send ? '' : h('span', { class: 'pill' }, 'без права писать')))))))),
    h('div', { class: 'panel' }, h('h2', null, `Переписка (${hist.messages.length}${more ? '+' : ''})`), moreBtn, list),
    hist.deleted.length ? h('div', { class: 'panel' }, h('h2', null, `Удалённые сообщения (${hist.deleted.length})`),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Удалено', 'Кто удалил', 'Автор', 'Отправлено', 'Содержимое'].map((x) => h('th', null, x)))),
        h('tbody', null, hist.deleted.map((e) => h('tr', { class: 'delrow' },
          h('td', { class: 'ev-time' }, fmtDT(e.ts)), h('td', null, e.actor ? userLink(e.actor.id) : '—'),
          h('td', null, e.details?.author ? userLink(e.details.author) : '—'), h('td', { class: 'ev-time' }, fmtDT(e.details?.sent_at)),
          h('td', null, e.details?.text || (e.details?.file ? `[файл ${e.details.file.name}]` : '')))))))) : '',
  );
}

async function viewJournal() {
  await loadDirectories();
  const actor = h('select', { class: 'input' }, h('option', { value: '' }, 'Все пользователи'),
    [...state.users.values()].map((u) => h('option', { value: u.id }, uname(u.id))));
  const action = h('select', { class: 'input' }, h('option', { value: '' }, 'Все действия'),
    [['message', 'Сообщения'], ['profile', 'Профиль'], ['auth', 'Вход/выход'], ['chat', 'Чаты'], ['user', 'Блокировки/регистрации'], ['session', 'Сессии'], ['admin', 'Действия админа']]
      .map(([v, l]) => h('option', { value: v }, l)));
  if (state.preset?.action) action.value = state.preset.action;
  state.preset = null;
  const since = h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'С' });
  const until = h('input', { class: 'input', type: 'datetime-local', 'aria-label': 'По' });
  const holder = h('div');
  const moreBtn = h('button', { class: 'btn secondary', type: 'button', hidden: true }, 'Загрузить ещё');
  let events = [];
  let hasMore = false;
  const qs = (extra = '') => {
    const p = new URLSearchParams({ limit: '100' });
    if (actor.value) p.set('actor', actor.value);
    if (action.value) p.set('action', action.value);
    if (since.value) p.set('since', String(new Date(since.value).getTime()));
    if (until.value) p.set('until', String(new Date(until.value).getTime()));
    return `/api/admin/audit?${p}${extra}`;
  };
  const draw = () => { clear(holder).append(eventsTable(events)); moreBtn.hidden = !hasMore; };
  const reload = async () => { const r = await get(qs()); events = r.events; hasMore = r.has_more; draw(); };
  moreBtn.onclick = async () => { const r = await get(qs(`&before=${events[events.length - 1].id}`)); events = events.concat(r.events); hasMore = r.has_more; draw(); };
  for (const el of [actor, action, since, until]) el.addEventListener('change', reload);
  const live = h('input', { type: 'checkbox', id: 'live' });
  live.addEventListener('change', () => (live.checked ? startLive(reload, 4000) : stopLive()));
  await reload();
  setView(h('div', { class: 'toolbar' }, actor, action, since, until, h('label', { class: 'row', for: 'live' }, live, 'обновлять сам')),
    h('div', { class: 'panel' }, holder, moreBtn));
}

// ---------------------------------------------------------------- access: registration, invitations, broadcast
/** Who may link a Telegram account to their messenger; the copies are readable in "Чаты и переписка". */
function bridgePanel(data) {
  const body = h('tbody');
  const draw = (users) => clear(body).append(...users.map((u) => h('tr', null,
    h('td', null, h('b', null, u.name), u.username ? h('span', { class: 'muted' }, ` @${u.username}`) : null, u.is_admin ? [' ', h('span', { class: 'pill ok' }, 'админ')] : ''),
    h('td', null, u.linked
      ? [h('span', { class: 'pill ok' }, 'подключён'), ` ${u.tg_name}${u.tg_username ? ` @${u.tg_username}` : ''} · чатов ${u.chats} · сообщений ${u.messages} `,
          h('button', { class: 'btn secondary', type: 'button', title: 'Копировать ли личные чаты этого человека (видит только админ)', onclick: async () => { try { await send('PUT', `/api/admin/bridge/${u.id}/personal`, { auto_private: !u.auto_private }); const fresh = await get('/api/admin/bridge'); draw(fresh.users); } catch (e) { alert(errMsg(e)); } } }, u.auto_private ? 'Личные чаты: копируются' : 'Личные чаты: не копируются')]
      : h('span', { class: 'muted' }, 'не подключён')),
    h('td', null, u.is_admin ? h('span', { class: 'muted' }, 'всегда можно') : [h('button', {
      class: `btn ${u.allowed ? 'secondary' : 'danger'}`, type: 'button',
      onclick: async () => {
        if (u.allowed && u.linked && !confirm(`Запретить ${u.name}? Подключённый Телеграм будет отключён, копии останутся.`)) return;
        try { await send('PUT', `/api/admin/bridge/${u.id}`, { allowed: !u.allowed }); const fresh = await get('/api/admin/bridge'); draw(fresh.users); } catch (e) { alert(errMsg(e)); }
      },
    }, u.allowed ? 'Запретить' : 'Разрешить'), u.linked ? [' ', h('button', {
      class: 'btn danger', type: 'button', title: 'Отключить Телеграм этого человека и удалить скопированные чаты',
      onclick: async () => {
        if (!confirm(`Удалить мост ${u.name}? Телеграм будет отключён, ВСЕ скопированные чаты удалены. Это нельзя отменить.`)) return;
        try { await send('DELETE', `/api/admin/bridge/${u.id}`); const fresh = await get('/api/admin/bridge'); draw(fresh.users); } catch (e) { alert(errMsg(e)); }
      },
    }, 'Удалить')] : '']))));
  draw(data.users);
  return h('div', { class: 'panel' }, h('h2', null, icon('chat', 18), 'Мост с Телеграмом'),
    h('p', { class: 'muted' }, data.configured
      ? 'Подключить свой Телеграм может любой пользователь, пока вы не запретите. «Запретить» отключает его Телеграм (копии остаются), «Удалить» отключает и стирает все скопированные чаты. Все личные чаты такого человека копируются сюда тихо, без уведомлений; человек видит их и может отвечать из приложения, но не может их удалять, очищать или остановить копирование: это можете только вы. Вы видите эти копии во вкладке «Чаты и переписка»; каждый просмотр записывается в журнал. Человек знает об этом заранее.'
      : 'Мост не включён на сервере: нужны BRIDGE_TOKEN и контейнер tgbridge (см. docs/tgbridge.md).'),
    data.configured ? h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Пользователь', 'Телеграм', 'Доступ'].map((x) => h('th', null, x)))), body)) : null);
}

async function viewAccess() {
  const [st, inv, br] = await Promise.all([get('/api/admin/settings'), get('/api/admin/invites'), get('/api/admin/bridge').catch(() => ({ configured: false, users: [] }))]);
  const MODES = {
    open: ['Открыта', 'Любой может зарегистрироваться'],
    invite: ['По приглашениям', 'Только по ссылке-приглашению'],
    closed: ['Закрыта', 'Новые аккаунты не создаются'],
  };
  const modeMsg = h('span', { class: 'muted' });
  let curMode = st.registration;
  const cards = h('div', { class: 'mode-cards', role: 'radiogroup', 'aria-label': 'Регистрация' });
  const drawModes = () => {
    clear(cards).append(...Object.entries(MODES).map(([k, [title, hint]]) => h('button', {
      class: `mode-card${curMode === k ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(curMode === k),
      onclick: async () => {
        if (curMode === k) return;
        try { await send('PUT', '/api/admin/settings', { registration: k }); curMode = k; modeMsg.textContent = 'Сохранено'; drawModes(); } catch (e) { modeMsg.textContent = errMsg(e); }
      },
    }, h('span', { class: 'mc-dot' }), h('span', { class: 'mc-text' }, h('b', null, title), h('small', null, hint)))));
  };
  drawModes();
  const mode = cards;

  const note = h('input', { class: 'input', placeholder: 'Для кого (заметка)', maxLength: 120 });
  const uses = h('input', { class: 'input', type: 'number', min: 1, max: 1000, value: 1, 'aria-label': 'Сколько раз можно использовать' });
  const days = h('input', { class: 'input', type: 'number', min: 0, max: 365, value: 7, 'aria-label': 'Срок в днях (0 — бессрочно)' });
  const link = (code) => `${location.origin}/?invite=${code}`;
  const body = h('tbody');
  const drawInv = (list) => {
    clear(body).append(...(list.length ? list.map((i) => h('tr', null,
      h('td', null, h('span', { class: i.active ? 'pill ok' : 'pill' }, i.active ? 'активно' : 'использовано / истекло'), ' ', i.note || ''),
      h('td', { class: 'mono' }, link(i.code)),
      h('td', null, `${i.uses} / ${i.max_uses}`),
      h('td', { class: 'ev-time' }, i.expires_at ? fmtDT(i.expires_at) : 'бессрочно'),
      h('td', null,
        h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link(i.code)); } catch { prompt('Скопируйте ссылку', link(i.code)); } } }, 'Копировать'), ' ',
        h('button', { class: 'btn danger', type: 'button', onclick: async () => { await send('DELETE', `/api/admin/invites/${i.id}`); viewAccess().then(applyDynamicStyles); } }, 'Удалить'))))
      : [h('tr', null, h('td', { colSpan: 5, class: 'muted' }, 'Приглашений пока нет')) ]));
  };
  drawInv(inv.invites);
  const create = h('button', { class: 'btn', type: 'button' }, 'Создать приглашение');
  create.onclick = async () => {
    try {
      await send('POST', '/api/admin/invites', { note: note.value, max_uses: Number(uses.value) || 1, ttl_days: Number(days.value) || 0 });
      viewAccess().then(applyDynamicStyles);
    } catch (e) { alert(errMsg(e)); }
  };

  const text = h('textarea', { class: 'input', rows: 4, maxLength: 2000, placeholder: 'Текст сообщения всем пользователям — придёт в чат «Suhbat-dosh»' });
  const sendBtn = h('button', { class: 'btn', type: 'button' }, 'Отправить всем');
  const sendMsg = h('span', { class: 'muted' });
  sendBtn.onclick = async () => {
    const v = text.value.trim();
    if (!v || !confirm('Отправить это сообщение всем пользователям?')) return;
    sendBtn.disabled = true;
    try { const r = await send('POST', '/api/admin/broadcast', { text: v }); sendMsg.textContent = `Отправлено: ${r.sent}`; text.value = ''; } catch (e) { sendMsg.textContent = errMsg(e); }
    sendBtn.disabled = false;
  };

  const quotaIn = h('input', { class: 'input', type: 'number', min: 0, value: st.quota_default_mb ?? 0, 'aria-label': 'МБ на пользователя' });
  const quotaMsg = h('span', { class: 'muted' });
  const quotaSave = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { await send('PUT', '/api/admin/settings', { quota_default_mb: Number(quotaIn.value) || 0 }); quotaMsg.textContent = 'Сохранено'; } catch (e) { quotaMsg.textContent = errMsg(e); }
  } }, 'Сохранить');
  const gcIn = h('input', { class: 'input', type: 'number', min: 2, max: st.gcall_max_top ?? 25, value: st.gcall_max ?? 6, 'aria-label': 'Участников в групповом звонке' });
  const gcMsg = h('span', { class: 'muted' });
  const gcSave = h('button', { class: 'btn', type: 'button', onclick: async () => {
    try { const r = await send('PUT', '/api/admin/settings', { gcall_max: Number(gcIn.value) }); gcIn.value = r.gcall_max; gcMsg.textContent = 'Сохранено'; } catch (e) { gcMsg.textContent = errMsg(e); }
  } }, 'Сохранить');
  const cred = await get('/api/admin/credentials').catch(() => ({ login: null, has_password: false }));
  const cLogin = h('input', { class: 'input', value: cred.login || '', autocomplete: 'username', autocapitalize: 'none', placeholder: 'Логин (латиница, от 4 символов)', 'aria-label': 'Логин' });
  const cNew = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: 'Новый пароль (от 10 символов)', 'aria-label': 'Новый пароль' });
  const cOld = cred.has_password ? h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Текущий пароль', 'aria-label': 'Текущий пароль' }) : null;
  const cMsg = h('div', { class: 'muted', role: 'status' });
  const cSave = h('button', { class: 'btn', type: 'button' }, cred.has_password ? 'Сменить пароль' : 'Включить вход по паролю');
  cSave.onclick = async () => {
    cMsg.textContent = '';
    try {
      await send('PUT', '/api/admin/credentials', { login: cLogin.value.trim(), password: cNew.value, ...(cOld ? { current_password: cOld.value } : {}) });
      cMsg.textContent = 'Сохранено. Теперь вход в аккаунт администратора — только по логину и паролю.';
      cNew.value = '';
    } catch (e) {
      const M = { wrong_password: 'Текущий пароль неверный', login_taken: 'Этот логин занят', invalid_login: 'Логин: латиница, цифры, . _ - (от 4 символов)', invalid_input: 'Пароль — не короче 10 символов' };
      cMsg.textContent = M[e.message] || errMsg(e);
    }
  };
  setView(
    h('div', { class: 'panel' }, h('h2', null, icon('disk', 18), 'Лимит хранилища по умолчанию'),
      h('p', { class: 'muted' }, 'Сколько файлов в чатах может хранить один пользователь. 0 — без ограничений. Для отдельного человека лимит меняется на его странице.'),
      h('div', { class: 'toolbar' }, quotaIn, quotaSave, quotaMsg)),
    h('div', { class: 'panel' }, h('h2', null, icon('phone', 18), 'Групповые звонки и голосовые комнаты'),
      h('p', { class: 'muted' }, `Сколько человек может быть в одном звонке или комнате (от 2 до ${st.gcall_max_top ?? 25}). Каждый участник отправляет своё видео всем остальным, поэтому при больших значениях нужен быстрый интернет у людей и на сервере TURN. Действует для новых входов, идущие звонки не прерываются.`),
      h('div', { class: 'toolbar' }, gcIn, gcSave, gcMsg)),
    bridgePanel(br),
    h('div', { class: 'panel' }, h('h2', null, icon('lock', 18), 'Вход администратора'),
      h('p', { class: 'muted' }, cred.has_password
        ? `Включён вход по логину «${cred.login}» и паролю. Код из SMS для этого аккаунта больше не принимается.`
        : 'Сейчас вход по коду. Задайте логин и пароль: после этого аккаунт администратора будет открываться только ими.'),
      h('div', { class: 'toolbar' }, cLogin, cOld, cNew, cSave), cMsg),
    h('div', { class: 'panel' }, h('h2', null, icon('key', 18), 'Регистрация'), h('div', { class: 'toolbar' }, mode, modeMsg),
      h('p', { class: 'muted' }, 'Уже существующие аккаунты входят всегда. Режим «по приглашениям» требует ссылку вида /?invite=КОД при первой регистрации (телефон, e-mail или Telegram).')),
    h('div', { class: 'panel' }, h('h2', null, icon('users', 18), 'Приглашения'),
      h('div', { class: 'toolbar' }, note, uses, days, create),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Приглашение', 'Ссылка', 'Использовано', 'Действует до', ''].map((x) => h('th', null, x)))), body))),
    h('div', { class: 'panel' }, h('h2', null, icon('bell', 18), 'Рассылка'), text, h('div', { class: 'toolbar' }, sendBtn, sendMsg),
      h('p', { class: 'muted' }, 'Сообщение приходит каждому пользователю в отдельный чат от имени сервиса «Suhbat-dosh». Ответить на него нельзя.')),
  );
}

// ---------------------------------------------------------------- server health, backups
function spark(values, { max = null, unit = '', color = '#fbc700', fmt = (v) => String(v) } = {}) {
  const W = 360, H = 96;
  const top = max ?? Math.max(1, ...values);
  const pts = values.map((v, i) => [(i * W) / Math.max(1, values.length - 1), H - 6 - (Math.min(v, top) / top) * (H - 14)]);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ');
  const area = pts.length ? `${line} L${W} ${H} L0 ${H} Z` : '';
  const last = values[values.length - 1] ?? 0;
  return h('div', { class: 'spark' },
    svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: '100%', height: H, preserveAspectRatio: 'none', role: 'img', 'aria-label': 'график' },
      svgEl('path', { d: area, fill: color, 'fill-opacity': '.18' }), svgEl('path', { d: line, fill: 'none', stroke: color, 'stroke-width': 2, 'stroke-linejoin': 'round' })),
    h('div', { class: 'spark-val' }, `${fmt(last)}${unit}`));
}

function mirrorLine(m) {
  if (!m?.configured) return 'Внешняя копия не настроена: задайте BACKUP_MIRROR_DIR (второй диск / папка) и/или BACKUP_WEBDAV_URL (+ BACKUP_WEBDAV_USER, BACKUP_WEBDAV_PASS) в .env — каждая копия базы будет дублироваться туда.';
  const parts = [];
  if (m.dir) parts.push(`папка ${m.dir}`);
  if (m.webdav) parts.push(`WebDAV ${m.webdav}`);
  const last = m.last ? ` Последняя отправка ${fmtDT(m.last.at)}: ${[m.last.dir && `папка — ${m.last.dir}`, m.last.webdav && `WebDAV — ${m.last.webdav}`].filter(Boolean).join(', ')}.` : ' Ещё не отправлялась.';
  return `Копии дублируются: ${parts.join(' и ')}.${last}`;
}

async function viewServer() {
  const [sys, bk] = await Promise.all([get('/api/admin/system'), get('/api/admin/backups')]);
  const n = sys.now;
  const fmtUp = (s) => (s >= 86400 ? `${Math.floor(s / 86400)} д ${Math.floor((s % 86400) / 3600)} ч` : `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин`);
  const used = n.disk_total ? Math.round(((n.disk_total - n.disk_free) / n.disk_total) * 100) : 0;
  const S = sys.series;
  const kpis = h('div', { class: 'kpis' },
    kpi('bolt', 'tone-gold', `${n.cpu}%`, 'Процессор', `${n.cpus} ядер · нагрузка ${n.load.join(' / ')}`),
    kpi('grid', 'tone-blue', `${n.mem}%`, 'Память', `процесс: ${fmtBytes(n.rss)} из ${fmtBytes(n.mem_total)}`),
    kpi('disk', used > 90 ? 'tone-red' : 'tone-green', fmtBytes(n.disk_free), 'Свободно на диске', `занято ${used}% из ${fmtBytes(n.disk_total)}`),
    kpi('list', 'tone-violet', fmtBytes(n.db_bytes), 'База данных', `файлы: ${fmtBytes(n.files_bytes)}`),
    kpi('trend', 'tone-green', fmtUp(n.uptime), 'Работает без перезапуска', `Node ${n.node}`));

  const names = { auto: 'авто', manual: 'вручную', 'pre-restore': 'перед восстановлением' };
  const rows = bk.backups.map((b) => h('tr', null,
    h('td', null, b.name), h('td', null, h('span', { class: 'pill' }, names[b.kind] || b.kind)),
    h('td', null, fmtBytes(b.size)), h('td', { class: 'ev-time' }, fmtDT(b.created_at)),
    h('td', null,
      h('a', { class: 'btn secondary', href: `/api/admin/backups/${encodeURIComponent(b.name)}` }, 'Скачать'), ' ',
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        if (!confirm(`Восстановить базу из «${b.name}»? Сервер перезапустится, изменения после этой копии будут потеряны (перед этим создаётся ещё одна копия).`)) return;
        try { await send('POST', `/api/admin/backups/${encodeURIComponent(b.name)}/restore`, { confirm: true }); alert('Перезапуск… обновите страницу через несколько секунд.'); } catch (e) { alert(errMsg(e)); }
      } }, 'Восстановить'), ' ',
      h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('Удалить копию?')) { await send('DELETE', `/api/admin/backups/${encodeURIComponent(b.name)}`); viewServer().then(applyDynamicStyles); } } }, 'Удалить'))));
  const make = h('button', { class: 'btn', type: 'button' }, 'Создать копию сейчас');
  make.onclick = async () => {
    make.disabled = true;
    try { await send('POST', '/api/admin/backups', {}); viewServer().then(applyDynamicStyles); } catch (e) { alert(errMsg(e)); make.disabled = false; }
  };

  const turn = n.turn || {};
  const turnPanel = h('div', { class: 'panel' }, h('h2', null, icon('phone', 18), 'Звонки: сквозное соединение (TURN)'),
    turn.configured
      ? h('p', null, h('span', { class: 'pill ok' }, 'подключён'), ` источник: ${turn.source === 'cloudflare' ? 'Cloudflare' : 'свой coturn'}. Звонки проходят даже через строгие мобильные сети.`)
      : h('p', null, h('span', { class: 'pill warn' }, 'не настроен'), ' Без TURN звонки (особенно видео) между мобильными сетями и за строгим NAT часто не соединяются. ',
        turn.error ? `Ошибка Cloudflare: ${turn.error}. ` : '',
        'Самый простой путь: Cloudflare → Realtime → TURN → создать ключ, затем указать CF_TURN_KEY_ID и CF_TURN_API_TOKEN в .env на NAS и перезапустить контейнер.'));
  // one glance: is everything fine?
  const age = bk.backups[0] ? Date.now() - bk.backups[0].created_at : Infinity;
  const fm = bk.files_mirror;
  const mark = (ok, warn) => h('span', { class: `pill ${ok ? 'ok' : warn ? 'warn' : 'bad'}` }, ok ? 'в порядке' : warn ? 'внимание' : 'проблема');
  const ago = (ms) => (ms === Infinity ? 'нет копий' : ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} мин назад` : ms < 86400e3 ? `${Math.round(ms / 3600e3)} ч назад` : `${Math.round(ms / 86400e3)} д назад`);
  const healthRows = [
    ['Копия базы', mark(age < 8 * 3600e3, age < 36 * 3600e3), `последняя: ${ago(age)}`],
    ['Копия файлов пользователей', fm ? mark(!fm.error, false) : mark(false, true), fm ? (fm.error ? fm.error : `проверка ${ago(Date.now() - fm.at)}, добавлено: ${fm.copied} (${fmtBytes(fm.bytes)})`) : 'ещё не запускалась (первый запуск через минуту после старта)'],
    ['Место на диске', mark(used < 85, used < 93), `свободно ${fmtBytes(n.disk_free)} из ${fmtBytes(n.disk_total)}`],
    ['Звонки (TURN)', mark(!!(n.turn && n.turn.configured), false), n.turn && n.turn.configured ? 'подключён' : 'не настроен: видеозвонки через мобильные сети могут не соединяться'],
    ['Работа без перезапуска', mark(true, false), fmtUp(n.uptime)],
  ];
  const healthPanel = h('div', { class: 'panel' }, h('h2', null, icon('shield', 18), 'Состояние сервера'),
    h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('tbody', null,
      ...healthRows.map(([name, pill, text]) => h('tr', null, h('td', null, name), h('td', null, pill), h('td', { class: 'muted' }, text)))))));
  setView(healthPanel, kpis, turnPanel,
    h('div', { class: 'grid2' },
      h('div', { class: 'panel' }, h('h2', null, 'Процессор, % (последние сутки)'), spark(S.map((x) => x.cpu), { max: 100, unit: '%' })),
      h('div', { class: 'panel' }, h('h2', null, 'Память, %'), spark(S.map((x) => x.mem), { max: 100, unit: '%', color: '#3b82f6' }))),
    h('div', { class: 'grid2' },
      h('div', { class: 'panel' }, h('h2', null, 'Запросов в минуту'), spark(S.map((x) => x.req), { color: '#22c55e' })),
      h('div', { class: 'panel' }, h('h2', null, 'Подключений в реальном времени'), spark(S.map((x) => x.ws), { color: '#a855f7' }))),
    h('div', { class: 'panel' }, h('h2', null, icon('disk', 18), 'Резервные копии базы'),
      h('p', { class: 'muted' }, 'Копия базы (пользователи, чаты, сообщения) делается автоматически каждые 6 часов и хранится в папке backups на NAS; последние 40 сохраняются. Загруженные файлы копируются в backups/files: копируются только новые, ничего не удаляется.'),
      h('div', { class: 'toolbar' }, make),
      h('p', { class: 'muted' }, mirrorLine(bk.mirror)),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Файл', 'Тип', 'Размер', 'Создана', ''].map((x) => h('th', null, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colSpan: 5, class: 'muted' }, 'Копий пока нет')))))));
}

// ---------------------------------------------------------------- abuse reports
async function viewReports() {
  let status = state.reportStatus || 'open';
  const holder = h('div');
  const draw = async () => {
    const r = await get(`/api/admin/reports?status=${status}`);
    clear(holder).append(h('div', { class: 'tablewrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Когда', 'Автор', 'Пожаловался', 'Сообщение', 'Причина', ''].map((x) => h('th', null, x)))),
      h('tbody', null, r.reports.length ? r.reports.map((x) => h('tr', null,
        h('td', { class: 'ev-time' }, fmtDT(x.created_at)),
        h('td', null, x.sender ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); openUser(x.sender.id); } }, x.sender.name) : '—'),
        h('td', null, x.reporter ? x.reporter.name : '—'),
        h('td', null, x.snapshot || '—'),
        h('td', null, h('span', { class: 'pill' }, x.reason)),
        h('td', null, status === 'open' ? [
          h('button', { class: 'btn secondary', type: 'button', onclick: async () => { await send('POST', `/api/admin/reports/${x.id}/resolve`, { action: 'dismiss' }); draw(); } }, 'Отклонить'), ' ',
          h('button', { class: 'btn secondary', type: 'button', onclick: async () => { await send('POST', `/api/admin/reports/${x.id}/resolve`, { action: 'delete' }); draw(); } }, 'Удалить сообщение'), ' ',
          h('button', { class: 'btn danger', type: 'button', onclick: async () => { if (confirm('Заблокировать автора?')) { await send('POST', `/api/admin/reports/${x.id}/resolve`, { action: 'ban' }); draw(); } } }, 'Заблокировать'),
        ] : h('span', { class: 'muted' }, { dismiss: 'отклонена', delete: 'сообщение удалено', ban: 'автор заблокирован' }[x.resolution] || x.resolution || ''))))
      : h('tr', null, h('td', { colSpan: 6, class: 'muted' }, status === 'open' ? 'Новых жалоб нет' : 'Обработанных жалоб нет'))))));
  };
  const open = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(status === 'open'), onclick: () => { status = 'open'; state.reportStatus = status; open.setAttribute('aria-pressed', 'true'); done.setAttribute('aria-pressed', 'false'); draw(); } }, 'Новые');
  const done = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(status === 'resolved'), onclick: () => { status = 'resolved'; state.reportStatus = status; open.setAttribute('aria-pressed', 'false'); done.setAttribute('aria-pressed', 'true'); draw(); } }, 'Обработанные');
  await draw();
  setView(h('div', { class: 'toolbar' }, open, done), h('div', { class: 'panel' }, holder));
}

// ---------------------------------------------------------------- call quality per user
async function viewQuality() {
  const r = await get('/api/admin/call-quality?days=30');
  const G = { good: ['ok', 'хорошо'], fair: ['', 'средне'], bad: ['warn', 'плохо'] };
  setView(h('div', { class: 'panel' }, h('h2', null, icon('phone', 18), 'Качество звонков за 30 дней'),
    h('p', { class: 'muted' }, 'Только технические показатели, без содержания звонков: задержка, потери пакетов, джиттер, переподключения.'),
    h('div', { class: 'tablewrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Пользователь', 'Оценка', 'Звонков', 'Минут', 'Задержка', 'Потери', 'Джиттер', 'Входящий', 'Переподкл.', 'Через TURN'].map((x) => h('th', null, x)))),
      h('tbody', null, r.users.length ? r.users.map((u) => h('tr', { class: 'click', onclick: () => u.user && openUser(u.user.id) },
        h('td', null, u.user ? u.user.name : '—'), h('td', null, h('span', { class: `pill ${G[u.grade][0]}` }, G[u.grade][1])),
        h('td', null, String(u.calls)), h('td', null, String(u.minutes)),
        h('td', null, u.rtt_ms === null ? '—' : `${u.rtt_ms} мс`), h('td', null, u.loss_pct === null ? '—' : `${u.loss_pct}%`),
        h('td', null, u.jitter_ms === null ? '—' : `${u.jitter_ms} мс`), h('td', null, u.kbps_in === null ? '—' : `${u.kbps_in} кбит/с`),
        h('td', null, String(u.reconnects)), h('td', null, `${u.relay_pct}%`)))
        : h('tr', null, h('td', { colSpan: 10, class: 'muted' }, 'Данных о звонках пока нет')))))));
}

// ---------------------------------------------------------------- shell
function startLive(fn, ms = 5000) {
  stopLive();
  state.live = setInterval(() => fn().catch(() => {}), ms);
}
function stopLive() {
  if (state.live) clearInterval(state.live);
  state.live = null;
}

const VIEWS = { overview: viewOverview, users: viewUsers, chats: viewChats, journal: viewJournal, access: viewAccess, server: viewServer, quality: viewQuality, reports: viewReports };
const TABS = {
  overview: ['Обзор', 'grid', 'Состояние сервера и активность'],
  users: ['Пользователи', 'users', 'Все аккаунты, сессии и действия'],
  chats: ['Чаты и переписка', 'chat', 'Просмотр переписки, правок и удалённого'],
  journal: ['Журнал действий', 'list', 'Кто, что и когда сделал'],
  access: ['Доступ и рассылка', 'key', 'Регистрация, приглашения, сообщения всем'],
  server: ['Сервер и копии', 'disk', 'Нагрузка, диск и резервные копии'],
  quality: ['Качество звонков', 'phone', 'Показатели связи по пользователям'],
  reports: ['Жалобы', 'shield', 'Сообщения, на которые пожаловались пользователи'],
};
let view;
let navEl;
let titleEl;
let subEl;

function setTab(tab, render = true) {
  state.tab = tab;
  navEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === tab)));
  titleEl.textContent = TABS[tab][0];
  subEl.textContent = TABS[tab][2];
  if (render) VIEWS[tab]().then(applyDynamicStyles).catch((e) => setView(h('div', { class: 'panel err' }, `Ошибка загрузки: ${e.message}`)));
}

/** Administrator sign-in: login + password (no SMS code). */
function showLogin(note = '') {
  const login = h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, placeholder: 'Логин', 'aria-label': 'Логин' });
  const pass = h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: 'Пароль', 'aria-label': 'Пароль' });
  const err = h('div', { class: 'err', role: 'alert' });
  const go = h('button', { class: 'btn', type: 'submit' }, 'Войти');
  const form = h('form', { class: 'adm-login-card' },
    h('img', { src: '/icon.svg?v=2', alt: '', width: 64, height: 64 }),
    h('h1', null, 'Вход администратора'),
    note ? h('p', { class: 'muted' }, note) : h('p', { class: 'muted' }, 'Логин и пароль, заданные в консоли администратора.'),
    login, pass, err, go,
    h('a', { href: '/', class: 'muted' }, '← В мессенджер'));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    err.textContent = '';
    go.disabled = true;
    try {
      await send('POST', '/api/auth/admin-login', { login: login.value.trim(), password: pass.value });
      location.reload();
    } catch (x) {
      err.textContent = x.message === 'invalid_credentials' ? 'Неверный логин или пароль' : x.message === '429' || x.message === 'too_many_requests' ? 'Слишком много попыток. Подождите несколько минут.' : `Ошибка: ${x.message}`;
      go.disabled = false;
    }
  });
  clear(root).append(h('div', { class: 'adm-login' }, form));
  login.focus();
}

async function boot() {
  let me;
  try { me = (await get('/api/me')).user; } catch { me = null; }
  if (!me) { showLogin(); return; }
  if (!me.is_admin) {
    showLogin('Этот раздел только для супер-администратора. Войдите под учётной записью администратора.');
    return;
  }
  navEl = h('nav', { class: 'adm-nav', 'aria-label': 'Разделы' },
    Object.entries(TABS).map(([k, [l, ico]]) => h('button', { type: 'button', dataset: { tab: k }, onclick: () => setTab(k) }, icon(ico, 20), h('span', null, l))));
  titleEl = h('h1');
  subEl = h('p', { class: 'muted' });
  view = h('main', { class: 'adm-view' });
  const clock = h('span', { class: 'adm-date muted' });
  const tick = () => { const s = new Date().toLocaleString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }); clock.textContent = s.charAt(0).toUpperCase() + s.slice(1); };
  tick(); setInterval(tick, 30000);
  clear(root).append(h('div', { class: 'adm-app' },
    h('aside', { class: 'adm-side' },
      h('a', { class: 'adm-brand', href: '/admin' }, h('img', { src: '/icon.svg?v=2', alt: '', width: 40, height: 40 }),
        h('span', null, h('b', null, 'Suhbat-dosh'), h('small', null, 'Администратор'))),
      navEl,
      h('div', { class: 'adm-grow' }),
      h('div', { class: 'adm-side-card' }, icon('key', 20), h('b', null, 'Доступ супер-админа'),
        h('span', null, 'Каждый ваш просмотр переписки записывается в журнал.')),
      h('div', { class: 'adm-me' }, h('span', { class: 'av' }, initials(me.name)), h('span', null, h('b', null, me.name), h('small', null, 'Супер-админ'))),
      h('a', { href: '/', class: 'btn secondary adm-back' }, icon('back', 18), 'В мессенджер')),
    h('div', { class: 'adm-main' },
      h('header', { class: 'adm-head' }, h('div', null, titleEl, subEl), h('div', { class: 'adm-head-r' }, clock)),
      view)));
  setTab('overview');
}
boot();
