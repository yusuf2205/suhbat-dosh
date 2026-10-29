// Super-admin console (separate window). All data comes from /api/admin/*, which the server restricts to admins.
import { h, clear } from './dom.js';
import './ripple.js';
import { icon } from './icons.js';
import { qrCanvas } from './qr.js';

const root = document.getElementById('admin-root');
const fmtDT = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'medium' }) : '—');
const fmtBytes = (n) => (n < 1048576 ? `${(n / 1024).toFixed(1)} КБ` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} МБ` : n < 1099511627776 ? `${(n / 1073741824).toFixed(n < 107374182400 ? 1 : 0)} ГБ` : `${(n / 1099511627776).toFixed(1)} ТБ`);
const fmtShort = (ts) => (ts ? new Date(ts).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
/** "Chrome · Windows" instead of the whole User-Agent line. */
function deviceName(ua) {
  const u = String(ua || '');
  if (!u) return '—';
  const os = /Windows/.test(u) ? 'Windows' : /iPhone|iPad|iPod/.test(u) ? 'iOS' : /Android/.test(u) ? 'Android' : /Mac OS X|Macintosh/.test(u) ? 'macOS' : /CrOS/.test(u) ? 'ChromeOS' : /Linux/.test(u) ? 'Linux' : '';
  const app = /SuhbatShell/.test(u) ? 'Приложение' : /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox' : /Chrome\/|CriOS/.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
  return [app, os].filter(Boolean).join(' · ') || u.slice(0, 30);
}

// ---- one sound at a time: starting a voice message or a video stops the one that was playing
document.addEventListener('play', (e) => {
  for (const m of document.querySelectorAll('audio, video')) if (m !== e.target && !m.paused) m.pause();
}, true);

// ---- dialogs and the Esc key: one rule everywhere, the nearest thing closes first
/** A confirmation as a dialog (Esc or the backdrop cancels, Enter confirms the focused button), instead of the browser's confirm())). */
function askConfirm(text, ok = 'Подтвердить', danger = true) {
  return new Promise((resolve) => {
    const done = (v) => { document.removeEventListener('keydown', key, true); box.remove(); resolve(v); };
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); }
      else if (e.key === 'Tab') {   // focus stays inside the dialog
        const bs = [...box.querySelectorAll('button')];
        const i = bs.indexOf(document.activeElement);
        e.preventDefault();
        bs[(i + (e.shiftKey ? -1 : 1) + bs.length) % bs.length].focus();
      }
    };
    const cancel = h('button', { class: 'btn secondary', type: 'button', onclick: () => done(false) }, 'Отмена');
    const yes = h('button', { class: `btn${danger ? ' danger' : ''}`, type: 'button', onclick: () => done(true) }, ok);
    const box = h('div', { class: 'adlg', role: 'alertdialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === box) done(false); } },
      h('div', { class: 'adlg-card' }, h('p', { class: 'adlg-text' }, text), h('div', { class: 'adlg-btns' }, cancel, yes)));
    document.addEventListener('keydown', key, true);
    document.body.append(box);
    (danger ? cancel : yes).focus();   // a destructive question is answered "no" by a stray Enter
  });
}
/** A short message at the bottom instead of alert(). */
function notify(text, ms = 4500) {
  const t = h('div', { class: 'atoast', role: 'status' }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}
/** Esc outside a dialog: close an open menu, then clear/leave a field, then step back out of a detail page. */
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  const menu = document.querySelector('details.amenu[open]');
  if (menu) { menu.open = false; return; }
  const el = document.activeElement;
  if (el && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
    if (el.value && el.type !== 'date' && el.tagName !== 'SELECT') { el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); } else el.blur();
    return;
  }
  document.querySelector('.crumb a')?.click();   // "← Назад" of a user or a conversation
});

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
  'admin.view_user': 'открыл профиль пользователя (админ)', 'admin.view_chat': 'открыл переписку (админ)', 'admin.export_chat': 'выгрузил переписку (админ)', 'client.media_error': 'не удалась запись звука или видео', 'admin.search': 'искал в сообщениях (админ)', 'admin.integrity_run': 'запустил проверку записи данных (админ)', 'admin.export_data': 'выгрузил данные (админ)', 'admin.export_link': 'создал ссылку на выгрузку (админ)', 'admin.export_revoke': 'отозвал ссылку на выгрузку (админ)', 'export.download': 'скачали выгрузку по ссылке', 'export.view': 'открыли ссылку на выгрузку', 'admin.export_extend': 'продлил ссылку на выгрузку (админ)',
  'call.start': 'начал звонок', 'call.end': 'завершил звонок', 'call.quality': 'показатели качества звонка',
  'admin.ban_user': 'заблокировал аккаунт (админ)', 'admin.unban_user': 'разблокировал аккаунт (админ)', 'admin.delete_user': 'удалил аккаунт (админ)',
  'admin.logout_user': 'завершил все сессии (админ)', 'admin.grant_admin': 'выдал права администратора', 'admin.revoke_admin': 'снял права администратора',
  'admin.settings': 'изменил настройки сервера', 'admin.invite_create': 'создал приглашение', 'admin.broadcast': 'сделал рассылку',
  'admin.backup_create': 'создал резервную копию', 'admin.backup_restore': 'восстановил из резервной копии', 'admin.backup_delete': 'удалил резервную копию',
  'admin.backup_download': 'скачал резервную копию', 'admin.backup_verify': 'проверил резервную копию',
  'bridge.chat': 'изменил чат моста (админ)', 'bridge.restore': 'вернул исключённые чаты в мост (админ)',
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
    case 'admin.search': out.push(h('div', null, `«${d.q || ''}» · ${d.mode === 'meaning' ? 'по смыслу' : 'по словам'}`)); break;
    case 'client.media_error': out.push(h('div', null, `${d.where || ''}: ${d.name || ''}${d.message ? ` — ${d.message}` : ''}${d.mime ? ` (${d.mime})` : ''}`), h('div', { class: 'muted' }, deviceName(d.ua))); break;
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
  if (a.last_backup_at && !a.offsite) add('warn', 'disk', 'Копии лежат на том же диске', 'Если диск выйдет из строя, пропадёт всё. Задайте внешнюю папку или облако', () => setTab('server'));
  else if (a.offsite_ok === false) add('bad', 'disk', 'Копия не дошла до внешнего хранилища', 'Подробности на вкладке «Сервер»', () => setTab('server'));
  if (a.backup_verify && !a.backup_verify.ok) add('bad', 'disk', 'Проверка резервной копии не прошла', (a.backup_verify.problems || []).join('; '), () => setTab('server'));
  if (a.integrity && !a.integrity.ok) add('bad', 'shield', 'Проверка записи данных нашла проблемы', (a.integrity.problems || []).join('; ').slice(0, 140), () => setTab('server'));
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
    attentionPanels(o),
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

// ---------------------------------------------------------------- exports of messages: download at once or hand out a link with limits
const FORMAT_CHOICES = [['zip-media', 'Архив ZIP с файлами', { format: 'zip', media: true }], ['zip', 'Архив ZIP (только переписка)', { format: 'zip', media: false }], ['html', 'Страница (.html)', { format: 'html' }], ['txt', 'Текст (.txt)', { format: 'txt' }], ['json', 'Данные (.json)', { format: 'json' }]];
const TTL_CHOICES = [['1', '1 час'], ['24', '1 день'], ['168', '7 дней'], ['720', '30 дней'], ['2160', '90 дней']];
const COUNT_CHOICES = [['1', 'один раз'], ['3', '3 раза'], ['10', '10 раз'], ['', 'без ограничения']];
const VIEW_CHOICES = [['', 'без ограничения'], ['1', 'один раз'], ['3', '3 раза'], ['10', '10 раз']];
const linkUrl = (token) => `${location.origin}/x/${token}`;
const LINK_STATUS = { active: ['ok', 'действует'], expired: ['', 'срок вышел'], used: ['', 'использована'], revoked: ['warn', 'отозвана'] };

/** The window of an export: what to give, in which form, and for how long/how many times/with which password. `scope`: 'chat' or 'user'. */
function openExportDialog({ scope, id, title }) {
  const done = () => { document.removeEventListener('keydown', key, true); box.remove(); };
  const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
  const sel = (label, choices, value) => h('label', { class: 'xd-f' }, h('span', null, label), h('select', { class: 'as-select' }, choices.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));
  const fmt = sel('Как скачать', FORMAT_CHOICES.map(([v, l]) => [v, l]), scope === 'message' ? 'zip-media' : 'zip-media');
  const ttl = sel('Ссылка действует', TTL_CHOICES, '24');
  const cnt = sel('Скачать можно', COUNT_CHOICES, '');
  const opens = sel('Открыть можно', VIEW_CHOICES, '');
  const box1 = (label, on, hint) => { const i = h('input', { type: 'checkbox', checked: on }); return { i, node: h('label', { class: 'xd-chk' }, i, h('span', null, label, hint ? h('small', { class: 'muted' }, hint) : null)) }; };
  const cView = box1('Показать на странице сразу', true, 'фото, видео, голосовое, текст: получатель видит то, что ждал');
  const cDl = box1('Разрешить скачивание', true, 'выключите, если нужно только посмотреть');
  const cHide = box1('Скрыть имена и название чата', false);
  const cNotify = box1('Сообщить мне, когда откроют', false);
  const syncDl = () => { fmt.querySelector('select').disabled = !cDl.i.checked; cnt.querySelector('select').disabled = !cDl.i.checked; };
  cDl.i.addEventListener('change', syncDl);
  const since = h('input', { class: 'as-date', type: 'date', 'aria-label': 'С даты' });
  const until = h('input', { class: 'as-date', type: 'date', 'aria-label': 'По дату' });
  const pass = h('input', { class: 'input', type: 'text', placeholder: 'Пароль (необязательно)', autocomplete: 'off', maxLength: 100, 'aria-label': 'Пароль' });
  const note = h('input', { class: 'input', placeholder: 'Заметка для себя (необязательно)', maxLength: 200, 'aria-label': 'Заметка' });
  const val = (label) => label.querySelector('select').value;
  const spec = () => {
    const c = FORMAT_CHOICES.find((x) => x[0] === val(fmt))[2];
    const day = (v, end) => (v ? String(new Date(`${v}T${end ? '23:59:59.999' : '00:00:00'}`).getTime()) : '');
    return { scope, scope_id: id, format: c.format, media: !!c.media, since: day(since.value, false), until: day(until.value, true) };
  };
  const options = () => {
    const dl = cDl.i.checked;
    return { view: cView.i.checked, allow_download: dl, hide_names: cHide.i.checked, notify: cNotify.i.checked, max_views: val(opens) === '' ? null : Number(val(opens)), max_downloads: !dl || val(cnt) === '' ? null : Number(val(cnt)) };
  };
  const body = h('div', { class: 'xd-body' });
  const err = h('div', { class: 'err', role: 'alert' });
  const form = () => {
    clear(body).append(
      h('h3', null, 'Ссылка и выгрузка'), h('p', { class: 'muted' }, title),
      h('div', { class: 'xd-checks' }, cView.node, cDl.node, cHide.node, cNotify.node),
      fmt,
      scope === 'message' ? h('span', { hidden: true }) : h('div', { class: 'xd-f' }, h('span', null, 'За период (необязательно)'), h('div', { class: 'row' }, since, h('span', { class: 'at-lab' }, '—'), until)),
      h('div', { class: 'xd-split' }, ttl, opens), cnt, pass, note, err,
      h('div', { class: 'adlg-btns xd-btns' },
        h('button', { class: 'btn secondary', type: 'button', onclick: done }, 'Закрыть'),
        h('a', { class: 'btn secondary', href: '#', title: 'Скачать себе, без ссылки', onclick: (e) => { e.currentTarget.href = `/api/admin/exports/now?${new URLSearchParams(spec())}`; } }, 'Скачать себе'),
        h('button', { class: 'btn', type: 'button', onclick: async (e) => {
          e.currentTarget.disabled = true; err.textContent = '';
          if (!cView.i.checked && !cDl.i.checked) { err.textContent = 'Включите хотя бы одно: показать на странице или разрешить скачивание'; e.currentTarget.disabled = false; return; }
          try { const r = await send('POST', '/api/admin/exports', { ...spec(), ...options(), hours: Number(val(ttl)), password: pass.value, note: note.value }); created(r.link); } catch (x) { err.textContent = errMsg(x); e.currentTarget.disabled = false; }
        } }, 'Создать ссылку')));
  };
  const created = (l) => {
    const url = linkUrl(l.token);
    const field = h('input', { class: 'input xd-url', readOnly: true, value: url, 'aria-label': 'Ссылка', onfocus: (e) => e.target.select() });
    const copy = h('button', { class: 'btn', type: 'button', onclick: async (e) => { try { await navigator.clipboard.writeText(url); e.currentTarget.textContent = 'Скопировано ✓'; } catch { field.select(); } } }, 'Копировать');
    clear(body).append(
      h('h3', null, 'Ссылка готова'), h('p', { class: 'muted' }, l.title),
      h('div', { class: 'row xd-row' }, field, copy),
      h('div', { class: 'xd-qr' }, qrCanvas(url, 150, { logo: false, animate: false })),
      h('p', { class: 'muted' }, `${l.view ? 'Откроется страница с содержимым' : 'Страница с кнопкой «Скачать»'}${l.view && l.max_views ? ` (открыть можно ${l.max_views} ${l.max_views === 1 ? 'раз' : 'раза'})` : ''}. ${l.allow_download ? `Скачать ${l.max_downloads === null ? 'можно сколько угодно раз' : `можно ${l.max_downloads} ${l.max_downloads === 1 ? 'раз' : 'раза'}`}` : 'Скачивание отключено'}${l.password ? ' · нужен пароль' : ''}${l.hide_names ? ' · имена скрыты' : ''}. Действует до ${fmtDT(l.expires_at)}. Ссылку можно отозвать в разделе «Доступ и рассылка».`),
      h('div', { class: 'adlg-btns' }, h('button', { class: 'btn', type: 'button', onclick: () => { done(); if (state.tab === 'access') setTab('access'); } }, 'Готово')));
    field.select();
  };
  const box = h('div', { class: 'adlg', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === box) done(); } }, h('div', { class: 'adlg-card xd' }, body));
  document.addEventListener('keydown', key, true);
  document.body.append(box);
  form();
}

/** The links that were handed out: what, until when, how many times used; copy the address, revoke. */
async function exportsPanel() {
  const box = h('section', { class: 'panel' });
  async function paint() {
    let d;
    try { d = await get('/api/admin/exports'); } catch { clear(box).append(h('p', { class: 'muted' }, 'Не удалось получить список')); return; }
    clear(box).append(h('h2', null, icon('download', 18), 'Ссылки на выгрузки'),
      h('p', { class: 'muted' }, 'Выгрузка одного сообщения, сообщений чата или всего, что написал пользователь, отдаётся ссылкой с ограничениями: сколько действует, сколько раз можно скачать, пароль. Создаётся там, где вы смотрите переписку: у сообщения кнопка ⇪, на странице чата меню «Скачать», на странице пользователя «Выгрузить».'),
      d.links.length ? h('div', { class: 'tablewrap' }, h('table', { class: 't compact' },
        h('thead', null, h('tr', null, ['Что', 'Вид', 'Открыто', 'Скачано', 'До', 'Статус', ''].map((x) => h('th', null, x)))),
        h('tbody', null, d.links.map((l) => h('tr', null,
          h('td', null, h('b', null, l.title), l.note ? h('small', { class: 'muted' }, ` · ${l.note}`) : null),
          h('td', null, [l.view ? '👁 ' : '', l.allow_download ? `⬇ ${l.format.toUpperCase()}${l.media ? '+файлы' : ''}` : 'без скачивания', l.password ? ' 🔒' : '', l.hide_names ? ' 🎭' : ''].join('')),
          h('td', { title: l.last_view_at ? `последний раз ${fmtDT(l.last_view_at)}` : '' }, l.view ? `${l.views}${l.max_views === null ? '' : ` из ${l.max_views}`}` : '—'),
          h('td', null, l.allow_download ? `${l.downloads}${l.max_downloads === null ? '' : ` из ${l.max_downloads}`}` : '—'),
          h('td', { class: 'ev-time' }, fmtShort(l.expires_at)),
          h('td', null, h('span', { class: `pill ${LINK_STATUS[l.status][0]}` }, LINK_STATUS[l.status][1])),
          h('td', { class: 'br-actions' },
            l.status === 'active' ? h('button', { class: 'btn small secondary', type: 'button', onclick: async (e) => { try { await navigator.clipboard.writeText(linkUrl(l.token)); e.currentTarget.textContent = '✓'; } catch { notify(linkUrl(l.token), 9000); } } }, 'Копировать') : null,
            l.status !== 'revoked' ? h('button', { class: 'btn small secondary', type: 'button', title: 'Продлить на сутки', onclick: async () => { try { await send('PATCH', `/api/admin/exports/${l.id}`, { extend_hours: 24 }); } catch (e) { notify(errMsg(e)); } paint(); } }, '+1 день') : null,
            l.status === 'active' ? h('button', { class: 'btn small danger-o', type: 'button', onclick: async () => { if (!(await askConfirm(`Отозвать ссылку «${l.title}»? Она сразу перестанет работать.`, 'Отозвать'))) return; try { await send('DELETE', `/api/admin/exports/${l.id}`); } catch (e) { notify(errMsg(e)); } paint(); } }, 'Отозвать') : null)))))) : h('p', { class: 'muted' }, 'Ссылок пока нет.'));
  }
  await paint();
  return box;
}

/** A question with a text field (a reason): resolves to the text ('' if left empty) or null when cancelled. Esc cancels, Enter confirms. */
function askText(text, label, ok = 'Подтвердить') {
  return new Promise((resolve) => {
    const done = (v) => { document.removeEventListener('keydown', key, true); box.remove(); resolve(v); };
    const input = h('input', { class: 'input', placeholder: label, maxLength: 200, 'aria-label': label });
    const key = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(null); }
      else if (e.key === 'Enter' && e.target === input) { e.preventDefault(); done(input.value.trim()); }
    };
    const box = h('div', { class: 'adlg', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === box) done(null); } },
      h('div', { class: 'adlg-card' }, h('p', { class: 'adlg-text' }, text), input,
        h('div', { class: 'adlg-btns' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => done(null) }, 'Отмена'), h('button', { class: 'btn danger', type: 'button', onclick: () => done(input.value.trim()) }, ok))));
    document.addEventListener('keydown', key, true);
    document.body.append(box);
    input.focus();
  });
}

/** A block that is closed until the administrator opens it. */
const fold = (title, count, ...body) => h('details', { class: 'panel fold' },
  h('summary', null, h('span', { class: 'fold-t' }, title), count !== null && count !== undefined ? h('span', { class: 'fold-n' }, String(count)) : null, h('span', { class: 'fold-go', 'aria-hidden': 'true' }, icon('chevron', 18))),
  h('div', { class: 'fold-body' }, ...body));

async function showUser(id) {
  showTab('users', false);
  const d = await get(`/api/admin/users/${id}`);
  const u = d.user;
  const run = (label, fn, after) => async () => {
    if (label && !(await askConfirm(label))) return;
    try { await fn(); await (after ? after() : openUser(id)); } catch (e) { notify(errMsg(e)); }
  };
  const act = (ico, label, cls, onclick, title) => h('button', { class: `btn small ud-act ${cls}`.trim(), type: 'button', title: title || label, 'aria-label': label, onclick }, icon(ico, 16), h('span', null, label));

  // the top: who this is, and what can be done with the account
  const head = h('section', { class: 'panel ud-head' },
    h('div', { class: 'ud-who' },
      u.avatar ? h('img', { class: 'ud-ava', src: u.avatar, alt: '' }) : h('span', { class: 'ud-ava ph', 'aria-hidden': 'true' }, (u.name || '?').slice(0, 1).toUpperCase()),
      h('div', { class: 'ud-name' },
        h('h2', null, u.name),
        h('div', { class: 'ud-pills' },
          u.username ? h('span', { class: 'muted' }, `@${u.username}`) : null,
          u.is_admin ? h('span', { class: 'pill ok' }, 'админ') : null,
          u.online ? h('span', { class: 'pill ok' }, 'в сети') : h('span', { class: 'pill' }, `был(а) ${fmtShort(u.last_seen)}`),
          u.banned_at ? h('span', { class: 'pill warn', title: u.ban_reason || '' }, 'заблокирован') : null))),
    h('div', { class: 'ud-actions' },
      act('list', 'Журнал', 'secondary', () => { state.preset = { actor: id }; setTab('journal'); }, 'Действия этого пользователя в журнале'),
      act('download', 'Выгрузить', 'secondary', () => openExportDialog({ scope: 'user', id, title: `Всё, что написал ${u.name}: в личных чатах, группах и каналах` }), 'Скачать сообщения пользователя или дать ссылку на них'),
      act('logout', 'Завершить сессии', 'secondary', run('Завершить все сессии пользователя?', () => send('POST', `/api/admin/users/${id}/logout`))),
      u.is_bot ? null : act('shield', u.is_admin ? 'Снять админа' : 'Сделать админом', 'secondary', run(u.is_admin ? 'Снять права администратора?' : 'Выдать права администратора?', () => send('POST', `/api/admin/users/${id}/admin`, { admin: !u.is_admin }))),
      h('span', { class: 'ud-sp' }),
      u.banned_at
        ? act('block', 'Разблокировать', '', run(null, () => send('POST', `/api/admin/users/${id}/ban`, { banned: false })))
        : act('block', 'Заблокировать', 'danger-o', async () => {
          const reason = await askText('Заблокировать аккаунт? Все сессии будут завершены.', 'Причина (необязательно)', 'Заблокировать');
          if (reason === null) return;
          try { await send('POST', `/api/admin/users/${id}/ban`, { banned: true, reason }); await openUser(id); } catch (e) { notify(errMsg(e)); }
        }),
      act('trash', 'Удалить', 'danger-o', run('Удалить аккаунт навсегда? Личные чаты будут удалены, сообщения в группах останутся.', () => send('DELETE', `/api/admin/users/${id}`), () => setTab('users')))));

  // chats: the most useful part, right under the top
  const typeName = { direct: 'личный', group: 'группа', channel: 'канал' };
  const chatsPanel = h('section', { class: 'panel' }, h('h2', null, `Чаты · ${d.chats.length}`),
    d.chats.length ? h('div', { class: 'ud-chats' }, d.chats.map((c) => h('button', { class: 'ud-chat', type: 'button', onclick: () => openChat(c.id) },
      h('span', { class: `ud-ci ${c.type}`, 'aria-hidden': 'true' }, (c.title || '#').slice(0, 1).toUpperCase()),
      h('span', { class: 'ud-cm' }, h('b', { class: 'ellipsis' }, c.title || `#${c.id}`),
        h('small', { class: 'muted ellipsis' }, `${typeName[c.type] || c.type}${c.role && c.role !== 'member' ? ` · ${c.role}` : ''} · с ${fmtShort(c.joined_at)}`)),
      c.banned ? h('span', { class: 'pill warn' }, 'заблокирован') : null,
      h('span', { class: 'ud-cn', title: 'написал сообщений' }, String(c.sent)),
      h('span', { class: 'ud-go', 'aria-hidden': 'true' }, icon('chevron', 16))))) : h('p', { class: 'muted' }, 'Чатов нет'));

  const dir = state.users.get(id) || {};
  const qIn = h('input', { class: 'input', type: 'number', min: 0, placeholder: 'МБ (пусто — как у всех, 0 — без лимита)', 'aria-label': 'Лимит хранилища, МБ', value: dir.quota ? Math.round(dir.quota / 1048576) : '' });
  const storage = fold('Хранилище', fmtBytes(dir.storage || 0),
    h('p', { class: 'muted' }, `Занято файлами в чатах: ${fmtBytes(dir.storage || 0)}${dir.quota ? ` из ${fmtBytes(dir.quota)}` : ' (без лимита)'}`),
    h('div', { class: 'toolbar' }, qIn, h('button', { class: 'btn', type: 'button', onclick: run(null, () => send('PUT', `/api/admin/users/${id}/quota`, { mb: qIn.value === '' ? null : Number(qIn.value) })) }, 'Сохранить лимит')));

  const profile = fold('Профиль', null,
    h('dl', { class: 'dl' },
      h('dt', null, 'Телефон'), h('dd', { class: 'mono' }, u.phone || '—'), h('dt', null, 'Username'), h('dd', null, u.username ? `@${u.username}` : '—'),
      h('dt', null, 'Статус'), h('dd', null, u.status || '—'), h('dt', null, 'О себе'), h('dd', null, u.bio || '—'),
      h('dt', null, 'Регистрация'), h('dd', null, fmtDT(u.created_at)), h('dt', null, 'Последний визит'), h('dd', null, u.online ? 'в сети' : fmtDT(u.last_seen)),
      u.banned_at ? [h('dt', null, 'Блокировка'), h('dd', null, `${fmtDT(u.banned_at)}${u.ban_reason ? ` · ${u.ban_reason}` : ''}`)] : '',
      h('dt', null, 'Приватность'), h('dd', { class: 'muted' }, `фото — ${u.privacy.photo}, статус — ${u.privacy.status}, был(а) — ${u.privacy.last_seen}`),
      d.blocks.length ? [h('dt', null, 'Заблокировал'), h('dd', null, d.blocks.map((b) => b.name).join(', '))] : ''));

  const sessions = fold('Сессии', d.sessions.length,
    h('div', { class: 'tablewrap ud-sessions' }, h('table', { class: 't compact' },
      h('thead', null, h('tr', null, ['Устройство', 'IP', 'Активность', ''].map((x) => h('th', null, x)))),
      h('tbody', null, d.sessions.map((s) => h('tr', null, h('td', { title: s.device }, deviceName(s.device)), h('td', { class: 'mono' }, s.ip),
        h('td', { class: 'ev-time', title: `создана ${fmtDT(s.created_at)}` }, fmtShort(s.last_active)),
        h('td', null, s.revoked ? h('span', { class: 'pill' }, 'завершена') : h('span', { class: 'pill ok' }, 'активна'))))))));

  setView(
    backCrumb('#/users', '← Пользователи'),
    head, chatsPanel, profile, sessions, storage,
  );
}

async function viewChats() {
  const { chats } = await loadDirectories();
  const body = h('tbody');
  const search = h('input', { class: 'as-input', type: 'search', placeholder: 'Название чата или слова из сообщений', 'aria-label': 'Поиск' });
  let mode = 'text';
  const modeChips = [['text', 'По словам'], ['meaning', '✨ По смыслу']].map(([k, l]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(k === mode), onclick: () => { mode = k; modeChips.forEach((b, i) => b.setAttribute('aria-pressed', String(i === (k === 'text' ? 0 : 1)))); findMessages(); } }, l));
  const found = h('section', { class: 'panel', hidden: true });
  const draw = () => {
    const t = search.value.trim().toLowerCase();
    clear(body).append(...chats.filter((c) => !t || (c.title || '').toLowerCase().includes(t)).map((c) =>
      h('tr', { class: 'click', onclick: () => openChat(c.id) },
        h('td', null, h('b', null, c.title || `#${c.id}`)),
        h('td', null, c.type === 'direct' ? 'личный' : c.type === 'channel' ? 'канал' : 'группа'),
        h('td', null, String(c.members)), h('td', null, String(c.messages)),
        h('td', null, c.owner ? c.owner.name : '—'), h('td', { class: 'ev-time' }, fmtDT(c.last_message_at)))));
  };
  // messages: by the words, or by meaning
  let seq = 0;
  async function findMessages() {
    const term = search.value.trim();
    const mine = ++seq;
    if (term.length < (mode === 'meaning' ? 3 : 2)) { found.hidden = true; return; }
    found.hidden = false;
    clear(found).append(h('p', { class: 'muted' }, 'Ищу…'));
    let r;
    try { r = await get(`/api/admin/search?mode=${mode}&q=${encodeURIComponent(term)}`); } catch (e) {
      if (mine !== seq) return;
      clear(found).append(h('p', { class: 'muted' }, e.status === 503 || /503|semantic_unavailable/.test(String(e.message)) ? 'Поиск по смыслу сейчас недоступен: служба не запущена. Работает поиск по словам.' : errMsg(e)));
      return;
    }
    if (mine !== seq) return;
    clear(found).append(h('h2', null, `Сообщения · ${r.results.length}`),
      r.results.length ? h('div', { class: 'ud-chats' }, r.results.map((m) => h('button', { class: 'ud-chat find', type: 'button', onclick: () => openChat(m.chat_id, m.id) },
        h('span', { class: 'ud-cm' },
          h('b', { class: 'ellipsis' }, state.chats.get(m.chat_id)?.title || `#${m.chat_id}`),
          h('small', { class: 'ellipsis' }, m.text),
          h('small', { class: 'muted ellipsis' }, `${authorOf(m)} · ${fmtShort(m.created_at)}`)),
        m.score != null ? h('span', { class: 'ud-cn', title: 'насколько близко по смыслу' }, `${Math.round(m.score * 100)}%`) : null,
        h('span', { class: 'ud-go', 'aria-hidden': 'true' }, icon('chevron', 16))))) : h('p', { class: 'muted' }, 'Ничего не найдено'));
  }
  let timer = 0;
  search.addEventListener('input', () => { draw(); clearTimeout(timer); timer = setTimeout(findMessages, 450); });
  draw();
  setView(h('div', { class: 'achat-tools' }, h('div', { class: 'at-row' }, h('label', { class: 'as-search' }, h('span', { class: 'as-ico', 'aria-hidden': 'true' }, '⌕'), search), h('div', { class: 'chips' }, modeChips))),
    found,
    h('div', { class: 'panel tablewrap' }, h('table', { class: 't' },
      h('thead', null, h('tr', null, ['Чат', 'Тип', 'Участников', 'Сообщений', 'Владелец', 'Последняя активность'].map((x) => h('th', null, x)))), body)));
  search.focus();
}

const DAY_FMT = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const dayOf = (ts) => new Date(ts).toDateString();
const clock = (ts) => new Date(ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

/** Who wrote a message: the Telegram name for copied chats, else the account. */
const authorOf = (m) => m.import_author || m.sender?.name || '—';

/** One message as a chat bubble: the owner of the chat on the right, everybody else on the left. */
function messageNode(m, ctx, prev) {
  const kindIcon = { image: '🖼', video: '🎬', audio: '🎵', voice: '🎤', file: '📎' }[m.kind] || '';
  const mine = ctx.imported ? m.import_author === ctx.import_me : (m.sender?.id != null && m.sender.id === ctx.me);
  const sameAuthor = prev && authorOf(prev) === authorOf(m) && dayOf(prev.created_at) === dayOf(m.created_at) && m.created_at - prev.created_at < 5 * 60_000;
  const nodes = [];
  if (!prev || dayOf(prev.created_at) !== dayOf(m.created_at)) nodes.push(h('div', { class: 'aday' }, h('span', null, DAY_FMT.format(new Date(m.created_at)).replace(/^./, (c) => c.toUpperCase()).replace(/ г\.$/, ''))));
  const showName = !sameAuthor && (!mine || ctx.group);
  const name = m.sender && !ctx.imported ? userLink(m.sender.id) : h('b', null, authorOf(m));
  nodes.push(h('div', { class: `abub ${mine ? 'mine' : 'theirs'}${sameAuthor ? ' cont' : ''}`, dataset: { id: String(m.id) } },
    m.score != null ? h('div', { class: 'abub-score', title: 'насколько близко по смыслу' }, `${Math.round(m.score * 100)}%`) : '',
    showName ? h('div', { class: 'abub-who' }, name) : '',
    m.forward_from ? h('div', { class: 'abub-quote' }, `Переслано от ${m.forward_from}`) : '',
    m.reply_to ? h('div', { class: 'abub-quote' }, h('b', null, m.reply_to.sender_name || 'сообщение'), ' ', m.reply_to.text) : '',
    m.kind === 'call' ? h('div', { class: 'abub-text' }, `📞 Звонок: ${m.text.replace(':video', ' (видео)')}${m.duration ? `, ${m.duration} с` : ''}`) : '',
    m.file && m.kind === 'image' ? h('a', { href: `/api/admin/files/${m.file.id}`, target: '_blank', rel: 'noopener' }, h('img', { class: 'abub-img', src: `/api/admin/files/${m.file.id}`, alt: '', loading: 'lazy' })) : '',
    m.file && (m.kind === 'voice' || m.kind === 'audio') ? h('audio', { class: 'abub-audio', controls: true, preload: 'metadata', src: `/api/admin/files/${m.file.id}` }) : '',
    m.file && m.kind === 'video' ? h('div', { class: 'abub-video' }, h('video', { class: 'abub-vid', controls: true, preload: 'metadata', playsinline: true, src: `/api/admin/files/${m.file.id}` }), h('a', { class: 'abub-dl', href: `/api/admin/files/${m.file.id}`, target: '_blank', rel: 'noopener' }, `${m.file.name} (${fmtBytes(m.file.size)})`)) : '',
    m.file && !['image', 'voice', 'audio', 'video'].includes(m.kind) ? h('div', { class: 'abub-text' }, kindIcon, ' ', h('a', { href: `/api/admin/files/${m.file.id}`, target: '_blank', rel: 'noopener' }, m.file.name), ` (${fmtBytes(m.file.size)})`) : '',
    m.kind === 'location' ? locationLine(m.text) : '',
    m.text && m.kind !== 'call' && m.kind !== 'location' ? h('div', { class: 'abub-text' }, m.text) : '',
    m.tg_deleted ? h('div', { class: 'abub-flag bad' }, '🗑 Удалено в Телеграме') : '',
    m.edits?.length ? h('details', { class: 'abub-edits' }, h('summary', null, `Изменено ${m.edits.length} ${m.edits.length === 1 ? 'раз' : 'раза'}: показать историю`),
      m.edits.map((e) => h('div', null, fmtDT(e.ts), ': ', diff(e.old, e.new)))) : '',
    h('div', { class: 'abub-act' }, h('button', { class: 'abub-copy', type: 'button', 'data-what': 'export', title: 'Скачать это сообщение или дать ссылку на него', 'aria-label': 'Скачать это сообщение или дать ссылку' }, '⇪'), h('button', { class: 'abub-copy', type: 'button', 'data-what': 'text', title: 'Копировать текст', 'aria-label': 'Копировать текст' }, '⧉'), h('button', { class: 'abub-copy', type: 'button', 'data-what': 'id', title: 'Копировать номер', 'aria-label': 'Копировать номер' }, '№')),
    h('div', { class: 'abub-time', title: `${fmtDT(m.created_at)} · №${m.id}${m.sender?.phone ? ` · ${m.sender.phone}` : ''}` }, h('span', { class: 'abub-id' }, `№${m.id}`), ' · ', m.edited_at ? 'изм. ' : '', clock(m.created_at))));
  return nodes;
}

/** A place shared in a chat: a link to the map instead of the raw "geo:lat,lng". */
function locationLine(text) {
  const g = /^geo:(-?[\d.]+),(-?[\d.]+)/.exec(String(text || ''));
  if (!g) return h('div', { class: 'abub-text' }, text);
  return h('div', { class: 'abub-text' }, '\u{1F4CD} Геопозиция: ',
    h('a', { href: `https://yandex.ru/maps/?pt=${g[2]},${g[1]}&z=16&l=map`, target: '_blank', rel: 'noopener', title: 'Открыть в Яндекс Картах' }, `${g[1]}, ${g[2]}`), ' ', h('small', { class: 'muted' }, 'Яндекс Карты'));
}

const CHAT_KINDS = [['', 'Всё'], ['image', 'Фото'], ['video', 'Видео'], ['file', 'Файлы'], ['voice', 'Голос и аудио'], ['link', 'Ссылки'], ['location', 'Геопозиции'], ['call', 'Звонки']];

/** One picture at full size, with the arrows and Esc: all the pictures of the conversation that are loaded. */
function openLightbox(imgs, start) {
  let i = start;
  const pic = h('img', { class: 'alb-img', alt: '' });
  const cap = h('div', { class: 'alb-cap' });
  const show = () => { pic.src = imgs[i].src; cap.textContent = `${i + 1} / ${imgs.length}`; };
  const close = () => { root.remove(); document.removeEventListener('keydown', key, true); };
  const go = (d) => { i = (i + d + imgs.length) % imgs.length; show(); };
  const key = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); } else if (e.key === 'ArrowRight') go(1); else if (e.key === 'ArrowLeft') go(-1);
  };
  const root = h('div', { class: 'alb', role: 'dialog', 'aria-modal': 'true', onclick: (e) => { if (e.target === root) close(); } },
    h('button', { class: 'alb-btn alb-prev', type: 'button', 'aria-label': 'Назад', onclick: () => go(-1) }, '‹'),
    pic,
    h('button', { class: 'alb-btn alb-next', type: 'button', 'aria-label': 'Вперёд', onclick: () => go(1) }, '›'),
    h('a', { class: 'alb-btn alb-open', href: '#', target: '_blank', rel: 'noopener', onclick: (e) => { e.currentTarget.href = imgs[i].src; } }, 'Открыть отдельно'),
    h('button', { class: 'alb-btn alb-close', type: 'button', 'aria-label': 'Закрыть', onclick: close }, '✕'),
    cap);
  document.addEventListener('keydown', key, true);
  document.body.append(root);
  show();
}

async function showChat(id, focus = null) {   // focus: a message to scroll to (a search result)
  showTab(state.tab === 'users' ? 'users' : 'chats', false);
  const f = { q: '', kind: '', author: '', since: '', until: '', meaning: false };
  let jumpMode = !!focus;   // a part of the conversation around a message, or search results: the live feed is off
  const qs = (extra = {}) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([k, v]) => k !== 'meaning' && v !== '' && v !== undefined && v !== null)).toString();
  const first = await Promise.all([get(`/api/admin/chats/${id}`), get(`/api/admin/chats/${id}/messages?${focus ? `around=${focus}` : 'limit=100'}`)]);
  const info = first[0];
  const c0 = info.chat;
  let hist = first[1];
  const list = h('div', { class: 'aconv' });
  let all = [...hist.messages];
  let more = hist.has_more;
  const ctx = {
    imported: info.chat.imported === 'tgbridge', import_me: info.chat.import_me, me: info.chat.owner_id || info.members[0]?.id,
    group: info.chat.type !== 'direct' && info.members.length > 2,
  };
  const draw = () => {
    clear(list);
    if (!all.length) list.append(h('p', { class: 'muted' }, 'Ничего не найдено'));
    all.forEach((m, i) => list.append(...messageNode(m, ctx, all[i - 1])));
  };
  const heading = h('h2');
  const paintHeading = () => { heading.textContent = `Переписка (${hist.total ?? all.length}${f.q || f.kind || f.author || f.since || f.until ? ', по фильтру' : ''})`; };
  const moreBtn = h('button', { class: 'btn secondary', type: 'button', hidden: !more }, 'Загрузить более ранние');
  // like a messenger: the conversation opens on its newest message; going back keeps the message being read where it is
  let stick = true;
  const scroller = () => {
    for (let p = list.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {   // the body's own overflow belongs to the viewport
      const o = getComputedStyle(p).overflowY;
      if ((o === 'auto' || o === 'scroll') && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement;
  };
  const toEnd = () => { list.lastElementChild?.scrollIntoView({ block: 'end' }); };
  // the place being read: the first message on screen and how far from the top of the screen it is
  let anchor = null;
  const bubbleOf = (mid) => list.querySelector(`.abub[data-id="${mid}"]`);
  const takeAnchor = () => {
    for (const el of list.querySelectorAll('.abub')) {
      const r = el.getBoundingClientRect();
      if (r.bottom > 60) return { id: el.dataset.id, top: r.top };
    }
    return null;
  };
  const holdAnchor = () => {
    if (!anchor) return;
    const el = bubbleOf(anchor.id);
    if (!el) return;
    const d = el.getBoundingClientRect().top - anchor.top;
    if (Math.abs(d) > 1) scroller().scrollTop += d;
  };
  let loading = false;
  const loadEarlier = async () => {
    if (loading || !more || !all.length) return;
    loading = true;
    try {
      const r = await get(`/api/admin/chats/${id}/messages?${qs({ limit: 100, before: all[0]?.id })}`);
      stick = false;
      anchor = takeAnchor();
      all.unshift(...r.messages);
      more = r.has_more; moreBtn.hidden = !more;
      draw();
      holdAnchor();
      // the pictures above arrive later and push everything down: keep the same message in place until the user moves on
      clearTimeout(loadEarlier.t);
      loadEarlier.t = setTimeout(() => { anchor = null; }, 8000);
    } finally { loading = false; }
  };
  moreBtn.onclick = loadEarlier;
  list.addEventListener('load', () => { if (stick) toEnd(); else holdAnchor(); }, true);   // pictures change the height as they arrive
  let ready = false;   // the page settles on the newest message first; its own scrolling must not count as the user's
  setTimeout(() => { ready = true; }, 900);
  const onScroll = () => {
    if (!list.isConnected) { window.removeEventListener('scroll', onScroll); return; }
    if (!ready) return;
    const sc = scroller();
    if (sc.scrollHeight - sc.scrollTop - sc.clientHeight > 160) stick = false;   // scrolled away from the end by any means (wheel, bar, touch, keys)
    if (anchor) { const el = bubbleOf(anchor.id); if (el) anchor.top = el.getBoundingClientRect().top; }
    // reached the beginning of what is loaded: bring the earlier part in, without a button press
    if (more && !loading && moreBtn.getBoundingClientRect().bottom > -200 && moreBtn.getBoundingClientRect().top < innerHeight) loadEarlier();
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  // a picture opens large, with the arrows, instead of a new tab
  list.addEventListener('click', (e) => {
    const img = e.target.closest?.('img.abub-img');
    if (!img) return;
    e.preventDefault();
    const imgs = [...list.querySelectorAll('img.abub-img')];
    openLightbox(imgs, imgs.indexOf(img));
  });

  // search and filters
  const active = () => !!(f.q || f.kind || f.author || f.since || f.until);
  const meaningBtn = h('button', { class: 'chip', type: 'button', 'aria-pressed': 'false', title: 'Искать по смыслу, а не по словам: «деньги» найдёт и «перевод на карту»', onclick: () => { f.meaning = !f.meaning; paintTools(); if (f.q) reload(); } }, '✨ По смыслу');
  const reload = async () => {
    if (f.meaning && f.q.length >= 3) {
      // by meaning: the closest messages first, whatever words they use
      try {
        const r = await get(`/api/admin/search?mode=meaning&q=${encodeURIComponent(f.q)}&chat_id=${id}`);
        all = r.results.map((x) => ({ ...x, score: x.score }));
        hist = { ...hist, total: all.length };
        more = false; moreBtn.hidden = true; jumpMode = true;
        paintHeading(); paintTools(); draw(); stick = false;
        list.closest('.panel')?.scrollIntoView({ block: 'start' });
      } catch (e) {
        notify(e.status === 503 || /503|semantic_unavailable/.test(String(e.message)) ? 'Поиск по смыслу сейчас недоступен: служба не запущена. Работает поиск по словам.' : errMsg(e));
        f.meaning = false; paintTools();
      }
      return;
    }
    jumpMode = false;
    hist = await get(`/api/admin/chats/${id}/messages?${qs({ limit: 100 })}`);
    all = [...hist.messages];
    more = hist.has_more; moreBtn.hidden = !more;
    paintHeading(); paintTools(); draw(); stick = true; toEnd();
  };
  let timer = null;
  const later = () => { clearTimeout(timer); timer = setTimeout(reload, 350); };
  const search = h('input', { class: 'as-input', type: 'search', placeholder: 'Поиск по тексту', 'aria-label': 'Поиск по тексту', oninput: (e) => { f.q = e.target.value.trim(); paintTools(); later(); } });
  const chips = CHAT_KINDS.map(([v, l]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(v === ''), onclick: () => { f.kind = v; reload(); } }, l));
  const authorSel = h('select', { class: 'as-select', 'aria-label': 'Автор', onchange: (e) => { f.author = e.target.value; reload(); } },
    h('option', { value: '' }, 'Все авторы'), (hist.authors || []).map((a) => h('option', { value: a }, a)));
  const day = (v, end) => (v ? new Date(`${v}T${end ? '23:59:59.999' : '00:00:00'}`).getTime() : '');
  const since = h('input', { class: 'as-date', type: 'date', 'aria-label': 'С даты', onchange: (e) => { f.since = String(day(e.target.value, false)); reload(); } });
  const until = h('input', { class: 'as-date', type: 'date', 'aria-label': 'По дату', onchange: (e) => { f.until = String(day(e.target.value, true)); reload(); } });
  const clearBtn = h('button', { class: 'chip reset', type: 'button', hidden: true, onclick: () => {
    Object.assign(f, { q: '', kind: '', author: '', since: '', until: '', meaning: false });
    search.value = ''; authorSel.value = ''; since.value = ''; until.value = '';
    reload();
  } }, '✕ Сбросить');
  function paintTools() {
    chips.forEach((b, i) => b.setAttribute('aria-pressed', String(CHAT_KINDS[i][0] === f.kind)));
    meaningBtn.setAttribute('aria-pressed', String(f.meaning));
    clearBtn.hidden = !active();
  }
  const exportLink = (format, label) => h('a', { class: 'amenu-item', href: '#', onclick: (e) => { e.currentTarget.href = `/api/admin/chats/${id}/export?${qs({ format })}`; e.currentTarget.closest('details').open = false; } }, label);
  const exportMenu = h('details', { class: 'amenu' }, h('summary', { class: 'chip solid', title: 'Скачать переписку (с учётом фильтров)' }, '⬇ Скачать'),
    h('div', { class: 'amenu-list' }, exportLink('txt', 'Текст (.txt)'), exportLink('html', 'Страница (.html)'),
      h('a', { class: 'amenu-item', href: '#', onclick: (e) => { e.preventDefault(); e.currentTarget.closest('details').open = false; openExportDialog({ scope: 'chat', id, title: c0.title || state.chats.get(id)?.title || `Чат #${id}` }); } }, 'Архив с файлами, ссылка…')));
  document.addEventListener('click', (e) => { if (!exportMenu.contains(e.target)) exportMenu.open = false; });
  const tools = h('div', { class: 'achat-tools' },
    h('div', { class: 'at-row' }, h('label', { class: 'as-search' }, h('span', { class: 'as-ico', 'aria-hidden': 'true' }, '⌕'), search), exportMenu),
    h('div', { class: 'at-row' }, h('div', { class: 'chips', role: 'group', 'aria-label': 'Тип сообщений' }, chips, meaningBtn)),
    h('div', { class: 'at-row' }, authorSel, h('span', { class: 'at-lab' }, 'с'), since, h('span', { class: 'at-lab' }, 'по'), until, clearBtn));

  // a message: copy its text or its number; and a way back to the newest
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest?.('button.abub-copy');
    if (!btn) return;
    const bub = btn.closest('.abub');
    if (btn.dataset.what === 'export') {   // one message: download it, or hand out a link to it
      const who = bub.querySelector('.abub-who')?.textContent;
      openExportDialog({ scope: 'message', id: Number(bub.dataset.id), title: `Сообщение №${bub.dataset.id}${who ? ` · ${who}` : ''}` });
      return;
    }
    const text = btn.dataset.what === 'id' ? `№${bub.dataset.id}` : [...bub.querySelectorAll('.abub-text')].map((x) => x.textContent).join('\n');
    try { await navigator.clipboard.writeText(text); btn.textContent = '✓'; } catch { btn.textContent = '!'; }
    setTimeout(() => { btn.textContent = btn.dataset.what === 'id' ? '№' : '⧉'; }, 1200);
  });
  const jump = h('button', { class: 'ajump', type: 'button', hidden: true, 'aria-label': 'К последним сообщениям', title: 'К последним сообщениям', onclick: () => { if (jumpMode) { if (focus) go(`#/chat/${id}`); else reload(); } else { stick = true; toEnd(); } } }, '↓');
  document.body.append(jump);
  const showJump = () => {
    if (!list.isConnected) { jump.remove(); return; }
    const sc = scroller();
    jump.hidden = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 500;
  };
  window.addEventListener('scroll', function jumpScroll() { if (!list.isConnected) { window.removeEventListener('scroll', jumpScroll); jump.remove(); return; } showJump(); }, { passive: true });

  // live: new messages appear by themselves (when no filter is on); the view stays on the end if it was there
  const live = setInterval(async () => {
    if (!list.isConnected) { clearInterval(live); return; }
    if (document.visibilityState !== 'visible' || jumpMode || f.q || f.kind || f.author || f.since || f.until) return;
    try {
      const last = [...all].reverse().find((m) => typeof m.id === 'number');
      const r = await get(`/api/admin/chats/${id}/messages?after=${last ? last.id : 0}&limit=100`);
      if (!r.messages.length) return;
      const sc = scroller();
      const atEnd = stick || sc.scrollHeight - sc.scrollTop - sc.clientHeight < 240;
      for (const m of r.messages) { list.append(...messageNode(m, ctx, all.at(-1))); all.push(m); }
      hist.total = (hist.total ?? 0) + r.messages.length;
      paintHeading();
      if (atEnd) toEnd();
    } catch { /* the next tick retries */ }
  }, 3000);

  const c = info.chat;
  paintHeading();
  draw();
  setView(
    backCrumb('#/chats', '← Чаты'),
    h('div', { class: 'panel' }, h('h2', null, c.title || state.chats.get(id)?.title || `Чат #${id}`),
      h('p', { class: 'muted' }, `${c.type} · создан ${fmtDT(c.created_at)}${c.description ? ` · ${c.description}` : ''}`),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Участник', 'Телефон', 'Роль', 'Вступил', ''].map((x) => h('th', null, x)))),
        h('tbody', null, info.members.map((m) => h('tr', null, h('td', null, userLink(m.id)), h('td', { class: 'mono' }, m.phone), h('td', null, m.role),
          h('td', { class: 'ev-time' }, fmtDT(m.joined_at)), h('td', null, m.banned ? h('span', { class: 'pill warn' }, 'заблокирован') : m.can_send ? '' : h('span', { class: 'pill' }, 'без права писать')))))))),
    h('div', { class: 'panel' }, heading, tools, moreBtn, list),
    hist.deleted.length ? h('div', { class: 'panel' }, h('h2', null, `Удалённые сообщения (${hist.deleted.length})`),
      h('div', { class: 'tablewrap' }, h('table', { class: 't' },
        h('thead', null, h('tr', null, ['Удалено', 'Кто удалил', 'Автор', 'Отправлено', 'Содержимое'].map((x) => h('th', null, x)))),
        h('tbody', null, hist.deleted.map((e) => h('tr', { class: 'delrow' },
          h('td', { class: 'ev-time' }, fmtDT(e.ts)), h('td', null, e.actor ? userLink(e.actor.id) : '—'),
          h('td', null, e.details?.author ? userLink(e.details.author) : '—'), h('td', { class: 'ev-time' }, fmtDT(e.details?.sent_at)),
          h('td', null, e.details?.text || (e.details?.file ? `[файл ${e.details.file.name}]` : '')))))))) : '',
  );
  if (focus) {
    // a search result: the conversation opens on that message and marks it
    stick = false;
    requestAnimationFrame(() => {
      const el = bubbleOf(focus);
      if (el) { el.scrollIntoView({ block: 'center' }); el.classList.add('abub-hl'); setTimeout(() => el.classList.remove('abub-hl'), 2600); }
    });
    return;
  }
  requestAnimationFrame(() => { toEnd(); setTimeout(() => { if (stick) toEnd(); }, 300); });
}

async function viewJournal() {
  await loadDirectories();
  const actor = h('select', { class: 'input' }, h('option', { value: '' }, 'Все пользователи'),
    [...state.users.values()].map((u) => h('option', { value: u.id }, uname(u.id))));
  const action = h('select', { class: 'input' }, h('option', { value: '' }, 'Все действия'),
    [['message', 'Сообщения'], ['profile', 'Профиль'], ['auth', 'Вход/выход'], ['chat', 'Чаты'], ['user', 'Блокировки/регистрации'], ['session', 'Сессии'], ['admin', 'Действия админа']]
      .map(([v, l]) => h('option', { value: v }, l)));
  if (state.preset?.action) action.value = state.preset.action;
  if (state.preset?.actor) actor.value = String(state.preset.actor);
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
  const KIND = { user: 'личный', group: 'группа', channel: 'канал' };
  const list = h('div', { class: 'tb-list' });
  const head = h('div', { class: 'tb-sum' });
  let users = data.users;
  let filter = 'all';
  let query = '';
  const refresh = async () => { users = (await get('/api/admin/bridge')).users; draw(); };
  const fail = (e) => notify(errMsg(e));

  /** A switch with a caption: on / off, the state is the whole message. */
  const sw = (on, label, title, onclick) => h('button', { class: `tb-sw${on ? ' on' : ''}`, type: 'button', role: 'switch', 'aria-checked': String(on), title, onclick }, h('i', { 'aria-hidden': 'true' }), h('span', null, label));

  // the copied chats of one person: opened under the row
  async function chatsOf(u, cell) {
    clear(cell).append(h('p', { class: 'muted' }, 'Загрузка…'));
    let r;
    try { r = await get(`/api/admin/bridge/${u.id}/chats`); } catch (e) { clear(cell).append(h('p', { class: 'err' }, errMsg(e))); return; }
    const row = (c) => h('div', { class: 'ud-chat tb-chat' },
      h('span', { class: `ud-ci ${c.kind === 'user' ? 'direct' : c.kind}`, 'aria-hidden': 'true' }, (c.title || '?').slice(0, 1).toUpperCase()),
      h('span', { class: 'ud-cm' }, h('b', { class: 'ellipsis' }, c.title || '—'), h('small', { class: 'muted ellipsis' }, `${KIND[c.kind] || c.kind} · ${c.last_at ? `последнее ${fmtShort(c.last_at)}` : 'сообщений нет'}`)),
      h('span', { class: 'ud-cn', title: 'сообщений скопировано' }, String(c.messages)),
      sw(!!c.two_way, c.two_way ? 'отвечает' : 'читает', 'Может ли человек отвечать в этом чате из приложения', async () => { try { await send('PUT', `/api/admin/bridge/${u.id}/chats/${encodeURIComponent(c.tg_chat)}`, { two_way: !c.two_way }); chatsOf(u, cell); } catch (e) { fail(e); } }),
      h('button', { class: 'btn small danger-o', type: 'button', title: 'Перестать копировать этот чат (то, что скопировано, останется)', onclick: async () => {
        if (!(await askConfirm(`Перестать копировать «${c.title}»? Уже скопированное останется.`))) return;
        try { await send('PUT', `/api/admin/bridge/${u.id}/chats/${encodeURIComponent(c.tg_chat)}`, { copy: false }); chatsOf(u, cell); } catch (e) { fail(e); }
      } }, 'Не копировать'));
    clear(cell).append(
      r.chats.length ? h('div', { class: 'ud-chats tb-chats' }, r.chats.map(row)) : h('p', { class: 'muted' }, 'Чатов нет.'),
      r.excluded ? h('p', { class: 'muted' }, `Снято с копирования личных чатов: ${r.excluded}. `, h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { try { await send('POST', `/api/admin/bridge/${u.id}/restore`, {}); chatsOf(u, cell); } catch (e) { fail(e); } } }, 'Вернуть все')) : null);
  }

  const act = (ico, label, cls, title, onclick) => h('button', { class: `btn small ud-act ${cls}`.trim(), type: 'button', title: title || label, 'aria-label': label, onclick }, icon(ico, 16), h('span', null, label));

  const rowOf = (u) => {
    const sub = h('div', { class: 'tb-sub', hidden: true });
    const live = u.linked && !(u.live && !u.live.connected);
    const el = h('div', { class: `tb-row${u.linked ? '' : ' off'}` },
      h('div', { class: 'tb-main' },
        h('span', { class: `ud-ci ${u.linked ? 'direct' : 'channel'}`, 'aria-hidden': 'true' }, (u.name || '?').slice(0, 1).toUpperCase()),
        h('span', { class: 'ud-cm' },
          h('b', { class: 'ellipsis' }, u.name, u.username ? h('span', { class: 'muted' }, ` @${u.username}`) : null, u.is_admin ? [' ', h('span', { class: 'pill ok' }, 'админ')] : null),
          u.linked ? h('small', { class: 'muted ellipsis' }, `Телеграм: ${u.tg_name || '—'}${u.tg_username ? ` @${u.tg_username}` : ''}`) : h('small', { class: 'muted' }, u.allowed ? 'Телеграм не подключён' : 'Подключать запрещено')),
        h('span', { class: 'tb-chips' },
          u.linked ? h('span', { class: `pill ${live ? 'ok' : ''}` }, live ? 'подключён' : 'нет связи') : (!u.allowed ? h('span', { class: 'pill warn' }, 'запрещено') : null),
          u.linked ? h('span', { class: 'pill', title: 'скопировано чатов' }, `${u.chats} чатов`) : null,
          u.linked ? h('span', { class: 'pill', title: 'скопировано сообщений' }, `${u.messages.toLocaleString('ru-RU')} сообщ.`) : null)),
      h('div', { class: 'tb-ctl' },
        u.linked ? sw(!!u.auto_private, u.auto_private ? 'личные копируются' : 'личные не копируются', 'Копировать ли личные чаты этого человека (видит только админ)', async () => { try { await send('PUT', `/api/admin/bridge/${u.id}/personal`, { auto_private: !u.auto_private }); await refresh(); } catch (e) { fail(e); } }) : null,
        h('span', { class: 'ud-sp' }),
        u.linked ? act('chat', 'Чаты', 'secondary', 'Показать скопированные чаты', () => { sub.hidden = !sub.hidden; if (!sub.hidden) chatsOf(u, sub); }) : null,
        u.is_admin ? h('span', { class: 'muted' }, 'всегда можно') : [
          act(u.allowed ? 'block' : 'check', u.allowed ? 'Запретить' : 'Разрешить', u.allowed ? 'secondary' : '', u.allowed ? 'Отключить Телеграм и запретить подключать' : 'Разрешить подключать Телеграм', async () => {
            if (u.allowed && u.linked && !(await askConfirm(`Запретить ${u.name}? Подключённый Телеграм будет отключён, копии останутся.`, 'Запретить'))) return;
            try { await send('PUT', `/api/admin/bridge/${u.id}`, { allowed: !u.allowed }); await refresh(); } catch (e) { fail(e); }
          }),
          u.linked ? act('trash', 'Удалить', 'danger-o', 'Отключить Телеграм этого человека и удалить скопированные чаты', async () => {
            if (!(await askConfirm(`Удалить мост ${u.name}? Телеграм будет отключён, ВСЕ скопированные чаты удалены. Это нельзя отменить.`, 'Удалить'))) return;
            try { await send('DELETE', `/api/admin/bridge/${u.id}`); await refresh(); } catch (e) { fail(e); }
          }) : null]),
      sub);
    return el;
  };

  function draw() {
    const linked = users.filter((u) => u.linked);
    const offline = linked.filter((u) => u.live && !u.live.connected).length;
    clear(head).append(
      h('span', { class: 'pill ok' }, `подключено: ${linked.length}`),
      offline ? h('span', { class: 'pill warn' }, `нет связи: ${offline}`) : null,
      h('span', { class: 'pill' }, `сообщений: ${linked.reduce((a, u) => a + (u.messages || 0), 0).toLocaleString('ru-RU')}`));
    const q = query.trim().toLowerCase();
    const shown = users.filter((u) => (filter === 'all' || (filter === 'on' ? u.linked : !u.linked)) && (!q || `${u.name} ${u.username || ''} ${u.tg_name || ''} ${u.tg_username || ''}`.toLowerCase().includes(q)));
    clear(list).append(...(shown.length ? shown.map(rowOf) : [h('p', { class: 'muted' }, 'Никого не найдено')]));
  }

  const search = h('input', { class: 'as-input', type: 'search', placeholder: 'Имя или @username', 'aria-label': 'Поиск', oninput: (e) => { query = e.target.value; draw(); } });
  const chips = [['all', 'Все'], ['on', 'Подключены'], ['off', 'Не подключены']].map(([k, l]) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(k === filter), onclick: () => { filter = k; chips.forEach((b, i) => b.setAttribute('aria-pressed', String(['all', 'on', 'off'][i] === k))); draw(); } }, l));
  draw();
  return h('section', { class: 'panel tb-panel' },
    h('div', { class: 'panel-head' }, h('h2', null, icon('chat', 18), 'Мост с Телеграмом'), data.configured ? head : null),
    data.configured ? null : h('p', { class: 'muted' }, 'Мост не включён на сервере: нужны BRIDGE_TOKEN и контейнер tgbridge (см. docs/tgbridge.md).'),
    h('details', { class: 'tb-how' }, h('summary', null, 'Как это работает'),
      h('p', { class: 'muted' }, 'Подключить свой Телеграм может любой пользователь, пока вы не запретите. «Запретить» отключает его Телеграм (копии остаются), «Удалить» отключает и стирает все скопированные чаты. Все личные чаты такого человека копируются сюда тихо, без уведомлений; человек видит их и может отвечать из приложения, но не может их удалять, очищать или остановить копирование: это можете только вы. Вы видите эти копии во вкладке «Чаты и переписка»; каждый просмотр записывается в журнал. Человек знает об этом заранее.')),
    data.configured ? h('div', { class: 'achat-tools' }, h('div', { class: 'at-row' }, h('label', { class: 'as-search' }, h('span', { class: 'as-ico', 'aria-hidden': 'true' }, '⌕'), search), h('div', { class: 'chips' }, chips))) : null,
    data.configured ? list : null);
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
    } catch (e) { notify(errMsg(e)); }
  };

  const text = h('textarea', { class: 'input', rows: 4, maxLength: 2000, placeholder: 'Текст сообщения всем пользователям — придёт в чат «Suhbat-dosh»' });
  const sendBtn = h('button', { class: 'btn', type: 'button' }, 'Отправить всем');
  const sendMsg = h('span', { class: 'muted' });
  sendBtn.onclick = async () => {
    const v = text.value.trim();
    if (!v || !(await askConfirm('Отправить это сообщение всем пользователям?'))) return;
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
    await exportsPanel(),
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

/** The daily check that everything is recorded: the last verdict, every check, the days before it, and a button to run it now. */
const CHECK_ICON = { ok: '✓', warn: '!', bad: '✕' };
async function integrityPanel() {
  const box = h('section', { class: 'panel integ' });
  let timer = 0;
  async function paint() {
    let d;
    try { d = await get('/api/admin/integrity'); } catch { clear(box).append(h('p', { class: 'muted' }, 'Не удалось получить данные проверки')); return; }
    const last = d.runs[0];
    const running = d.state.running;
    const btn = h('button', { class: 'btn small', type: 'button', disabled: running, onclick: async () => { btn.disabled = true; try { await send('POST', '/api/admin/integrity/run'); } catch (e) { notify(errMsg(e)); } paint(); } }, running ? 'Проверяю…' : 'Проверить сейчас');
    clear(box).append(
      h('div', { class: 'panel-head' }, h('h2', null, icon('shield', 18), 'Проверка записи данных'), btn),
      h('p', { class: 'muted' }, `Каждый день в ${d.state.at} (${d.state.tz}) сервер сам проверяет, что всё записано: база, файлы, поиск, запланированное, копии и Телеграм. Устройства для этого включать не нужно.`),
      running ? h('p', { class: 'integ-run' }, `Идёт проверка: ${d.state.progress || '…'}`) : null,
      last ? h('div', { class: 'integ-head' },
        h('span', { class: `pill ${last.ok ? 'ok' : 'bad'}` }, last.ok ? (last.warn ? 'в порядке, есть заметки' : 'всё в порядке') : 'есть проблемы'),
        h('span', { class: 'muted' }, `${fmtDT(last.ts)} · ${last.trigger === 'auto' ? 'по расписанию' : 'вручную'} · ${(last.duration_ms / 1000).toFixed(1)} с`)) : h('p', { class: 'muted' }, 'Проверок ещё не было: первая будет сегодня после ' + d.state.at + ' или по кнопке.'),
      last ? h('ul', { class: 'integ-list' }, last.checks.map((c) => h('li', { class: c.status },
        h('span', { class: 'integ-ico', 'aria-hidden': 'true' }, CHECK_ICON[c.status] || '·'),
        h('span', { class: 'integ-t' }, h('b', null, c.name), h('small', null, c.text), c.examples?.length ? h('small', { class: 'muted' }, c.examples.join(', ')) : null)))) : null,
      d.runs.length > 1 ? h('div', { class: 'integ-days', 'aria-label': 'Прошлые проверки' }, d.runs.slice().reverse().map((r) => h('span', { class: `integ-day ${r.ok ? (r.warn ? 'warn' : 'ok') : 'bad'}`, title: `${fmtDT(r.ts)}: ${r.ok ? 'в порядке' : `проблем: ${r.bad}`}` }))) : null);
    clearTimeout(timer);
    if (running) timer = setTimeout(() => { if (box.isConnected) paint(); }, 3000);
  }
  await paint();
  return box;
}

async function viewServer() {
  const [sys, bk, st] = await Promise.all([get('/api/admin/system'), get('/api/admin/backups'), get('/api/admin/storage').catch(() => null)]);
  const n = sys.now;
  const fmtUp = (s) => (s >= 86400 ? `${Math.floor(s / 86400)} д ${Math.floor((s % 86400) / 3600)} ч` : s >= 3600 ? `${Math.floor(s / 3600)} ч ${Math.floor((s % 3600) / 60)} мин` : `${Math.max(1, Math.floor(s / 60))} мин`);
  const used = n.disk_total ? Math.round(((n.disk_total - n.disk_free) / n.disk_total) * 100) : 0;
  const S = sys.series;
  const kpis = h('div', { class: 'kpis' },
    kpi('bolt', 'tone-gold', `${n.cpu}%`, 'Процессор', `${n.cpus} ядер · нагрузка ${n.load.join(' / ')}`),
    kpi('grid', 'tone-blue', `${n.mem}%`, 'Память', `процесс: ${fmtBytes(n.rss)} из ${fmtBytes(n.mem_total)}`),
    kpi('disk', used > 90 ? 'tone-red' : 'tone-green', fmtBytes(n.disk_free), 'Свободно на диске', `занято ${used}% из ${fmtBytes(n.disk_total)}`),
    kpi('list', 'tone-violet', fmtBytes(n.db_bytes), 'База данных', `файлы: ${fmtBytes(n.files_bytes)}`),
    kpi('trend', 'tone-green', fmtUp(n.uptime), 'Без перезапуска', `Node ${n.node}`));

  const names = { auto: 'авто', manual: 'вручную', 'pre-restore': 'перед восстановлением' };
  const rows = bk.backups.map((b) => h('tr', null,
    h('td', null, b.name), h('td', null, h('span', { class: 'pill' }, names[b.kind] || b.kind)),
    h('td', null, fmtBytes(b.size)), h('td', { class: 'ev-time' }, fmtDT(b.created_at)),
    h('td', null,
      h('a', { class: 'btn secondary', href: `/api/admin/backups/${encodeURIComponent(b.name)}` }, 'Скачать'), ' ',
      h('button', { class: 'btn secondary', type: 'button', title: 'Открыть копию отдельно и проверить: цела ли база, есть ли в ней данные и файлы', onclick: async (e) => {
        e.currentTarget.disabled = true;
        try { const v = (await send('POST', `/api/admin/backups/${encodeURIComponent(b.name)}/verify`, {})).verify; notify(v.ok ? `Копия в порядке.\nПользователей: ${v.counts.users}, чатов: ${v.counts.chats}, сообщений: ${v.counts.messages}, файлов: ${v.counts.files}.${v.files_missing === 0 ? '\nВсе файлы есть во внешней копии.' : ''}` : `Проблемы:\n${v.problems.join('\n')}`); viewServer().then(applyDynamicStyles); } catch (err) { notify(errMsg(err)); }
      } }, 'Проверить'), ' ',
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        if (!(await askConfirm(`Восстановить базу из «${b.name}»? Сервер перезапустится, изменения после этой копии будут потеряны (перед этим создаётся ещё одна копия).`))) return;
        try { await send('POST', `/api/admin/backups/${encodeURIComponent(b.name)}/restore`, { confirm: true }); notify('Перезапуск… обновите страницу через несколько секунд.'); } catch (e) { notify(errMsg(e)); }
      } }, 'Восстановить'), ' ',
      h('button', { class: 'btn danger', type: 'button', onclick: async () => { if ((await askConfirm('Удалить копию?'))) { await send('DELETE', `/api/admin/backups/${encodeURIComponent(b.name)}`); viewServer().then(applyDynamicStyles); } } }, 'Удалить'))));
  const make = h('button', { class: 'btn', type: 'button' }, 'Создать копию сейчас');
  make.onclick = async () => {
    make.disabled = true;
    try { await send('POST', '/api/admin/backups', {}); viewServer().then(applyDynamicStyles); } catch (e) { notify(errMsg(e)); make.disabled = false; }
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
    ['Копия на другом диске', bk.mirror.configured ? mark(!bk.mirror.last || ((bk.mirror.last.dir || 'ok') === 'ok' && (bk.mirror.last.webdav || 'ok') === 'ok'), false) : mark(false, true), bk.mirror.configured ? mirrorLine(bk.mirror) : 'не настроена: копии лежат на том же диске, что и данные'],
    ['Проверка копии', bk.verify ? mark(bk.verify.ok, false) : mark(false, true), bk.verify ? `${bk.verify.name}, ${ago(Date.now() - bk.verify.at)}${bk.verify.ok ? ': цела' : `: ${bk.verify.problems.join('; ')}`}` : 'ещё не делалась (автоматически раз в сутки)'],
    ['Работа без перезапуска', mark(true, false), fmtUp(n.uptime)],
  ];
  const healthPanel = h('div', { class: 'panel' }, h('h2', null, icon('shield', 18), 'Состояние сервера'),
    h('div', { class: 'tablewrap' }, h('table', { class: 't health' }, h('tbody', null,
      ...healthRows.map(([name, pill, text]) => h('tr', null, h('td', null, name), h('td', null, pill), h('td', { class: 'muted' }, text)))))));
  const storagePanel = st ? h('div', { class: 'panel' }, h('h2', null, icon('disk', 18), 'Куда уходит место'),
    h('p', { class: 'muted' }, `Файлов: ${st.total.files}, ${fmtBytes(st.total.bytes)}${st.bridge.files ? `; из них из Телеграма: ${st.bridge.files} (${fmtBytes(st.bridge.bytes)})` : ''}. Только размеры, содержимое не открывается.`),
    h('div', { class: 'grid2' },
      h('div', null, h('h3', null, 'По видам'),
        ...[['image', 'Фото'], ['video', 'Видео'], ['audio', 'Голос и аудио'], ['file', 'Файлы']].map(([k, label]) => {
          const x = st.kinds[k] || { files: 0, bytes: 0 };
          return h('div', { class: 'mtr wide' }, h('span', null, `${label} · ${x.files}`), h('i', null, h('u', { dataset: { w: String(st.total.bytes ? Math.max(x.bytes ? 2 : 0, Math.round((x.bytes / st.total.bytes) * 100)) : 0) } })), h('b', null, fmtBytes(x.bytes)));
        })),
      h('div', null, h('h3', null, 'По людям'),
        ...st.users.slice(0, 8).map((u) => {
          const top = st.users[0].bytes || 1;
          return h('div', { class: 'mtr wide' }, h('span', { class: 'ellipsis' }, `${u.name} · ${u.messages} сообщ.`), h('i', null, h('u', { dataset: { w: String(Math.max(u.bytes ? 2 : 0, Math.round((u.bytes / top) * 100))) } })), h('b', null, `${fmtBytes(u.bytes)}${u.quota ? ` / ${fmtBytes(u.quota)}` : ''}`));
        }))),
    h('h3', null, 'Самые тяжёлые чаты'),
    h('div', { class: 'tablewrap' }, h('table', { class: 't' }, h('thead', null, h('tr', null, ['Чат', 'Сообщений', 'Файлов', 'Размер'].map((x) => h('th', null, x)))),
      h('tbody', null, ...st.chats.map((c) => h('tr', null, h('td', null, c.title || `чат ${c.id}`, c.bridge ? [' ', h('span', { class: 'pill' }, 'Телеграм')] : ''), h('td', null, String(c.messages)), h('td', null, String(c.files)), h('td', null, fmtBytes(c.bytes)))))))) : null;
  const integrity = await integrityPanel();
  setView(healthPanel, integrity, kpis, turnPanel, storagePanel,
    h('div', { class: 'grid2' },
      h('div', { class: 'panel' }, h('h2', null, 'Процессор, % (последние сутки)'), spark(S.map((x) => x.cpu), { max: 100, unit: '%' })),
      h('div', { class: 'panel' }, h('h2', null, 'Память, %'), spark(S.map((x) => x.mem), { max: 100, unit: '%', color: '#3b82f6' }))),
    h('div', { class: 'grid2' },
      h('div', { class: 'panel' }, h('h2', null, 'Запросов в минуту'), spark(S.map((x) => x.req), { color: '#22c55e' })),
      h('div', { class: 'panel' }, h('h2', null, 'Подключений в реальном времени'), spark(S.map((x) => x.ws), { color: '#a855f7' }))),
    h('div', { class: 'panel' }, h('h2', null, icon('disk', 18), 'Резервные копии базы'),
      h('p', { class: 'muted' }, 'Копия базы (пользователи, чаты, сообщения) делается автоматически каждые 6 часов. Хранятся: десять последних, по одной на каждый из последних 14 дней, 8 недель и 12 месяцев, а сделанные вручную — 90 дней. Загруженные файлы копируются отдельно: копируются только новые, ничего не удаляется. Раз в сутки свежая копия сама проверяется.'),
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
          h('button', { class: 'btn danger', type: 'button', onclick: async () => { if ((await askConfirm('Заблокировать автора?'))) { await send('POST', `/api/admin/reports/${x.id}/resolve`, { action: 'ban' }); draw(); } } }, 'Заблокировать'),
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

function showTab(tab, render = true) {
  state.tab = tab;
  navEl.querySelectorAll('button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.tab === tab)));
  titleEl.textContent = TABS[tab][0];
  subEl.textContent = TABS[tab][2];
  if (render) VIEWS[tab]().then(applyDynamicStyles).catch((e) => setView(h('div', { class: 'panel err' }, `Ошибка загрузки: ${e.message}`)));
}

// ---------------------------------------------------------------- navigation: every screen has an address, so "Back" (the browser, the phone) steps out of it
const depth = () => history.state?.d ?? 0;
/** Open an address; the same one again only redraws it (after a change). */
function go(hash) {
  if (location.hash === hash) return route();
  history.pushState({ d: depth() + 1 }, '', hash);
  return route();
}
async function route() {
  const hsh = location.hash || '#/overview';
  const u = /^#\/user\/(\d+)$/.exec(hsh);
  const c = /^#\/chat\/(\d+)(?:\/(\d+))?$/.exec(hsh);
  const t = /^#\/([a-z]+)$/.exec(hsh);
  try {
    if (u) await showUser(Number(u[1]));
    else if (c) await showChat(Number(c[1]), c[2] ? Number(c[2]) : null);
    else showTab(t && TABS[t[1]] ? t[1] : 'overview');
  } catch (e) { setView(h('div', { class: 'panel err' }, `Ошибка загрузки: ${e.message}`)); }
}
window.addEventListener('popstate', route);
const setTab = (tab) => go(`#/${tab}`);
const openUser = (id) => go(`#/user/${id}`);
const openChat = (id, focus) => go(`#/chat/${id}${focus ? `/${focus}` : ''}`);
function startRouting() {
  history.replaceState({ d: 0 }, '', location.hash || '#/overview');
  route();
}
/** "← Back": one step back through what was opened (the same as the browser's Back); a way to the list when this page was opened directly. */
function backCrumb(fallback, label) {
  const inside = depth() > 0;
  return h('div', { class: 'crumb' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); if (depth() > 0) history.back(); else go(fallback); } }, inside ? '← Назад' : label));
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
  startRouting();
}
boot();
