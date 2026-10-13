import { closeLayer, openLayer } from './backnav.js';
import { h, clear } from './dom.js';
import { t, locale } from './i18n.js';
import { S } from './state.js';

// ---------------------------------------------------------------- avatars
const COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#c026d3', '#db2777', '#dc2626', '#ea580c', '#65a30d', '#0891b2', '#4f46e5'];

export function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ([...parts[0]][0] + (parts[1] ? [...parts[1]][0] : '')).toUpperCase();
}

/** entity: { id, name, avatar?, online? } */
export function avatar(entity, size = '') {
  const id = entity?.id ?? 0;
  const name = entity?.name ?? entity?.title ?? '';
  const el = h('span', { class: `avatar ${size}`, 'aria-hidden': 'true' });
  el.style.background = COLORS[Math.abs(Number(id) * 7 + name.length) % COLORS.length];
  if (entity?.avatar) {
    el.append(h('img', { src: entity.avatar, alt: '', loading: 'lazy' }));
  } else {
    el.textContent = initials(name);
  }
  if (entity?.online) el.append(h('span', { class: 'dot' }));
  return el;
}

// ---------------------------------------------------------------- time
export function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function fmtDay(ts) {
  const d = new Date(ts);
  const diff = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  if (diff === 0) return t('chat.today');
  if (diff === 1) return t('chat.yesterday');
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'long', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
}

export function fmtListTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const diff = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  if (diff === 0) return fmtTime(ts);
  if (diff < 7) return d.toLocaleDateString(locale(), { weekday: 'short' });
  return d.toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export function fmtLastSeen(ts) {
  const d = new Date(ts);
  const diff = Math.round((dayStart(new Date()) - dayStart(d)) / 86400000);
  const when = diff === 0 ? `${fmtTime(ts)}` : diff === 1 ? `${t('chat.yesterday').toLowerCase()} ${fmtTime(ts)}` : d.toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
  return t('chat.last_seen', { t: when });
}

// ---------------------------------------------------------------- toast
export function toast(msg, ms = 3200) {
  const root = document.getElementById('toasts');
  const el = h('div', { class: 'toast' }, msg);
  root.append(el);
  setTimeout(() => el.remove(), ms);
}

// ---------------------------------------------------------------- modal
const modalStack = [];

export function modal({ title, body, onClose, className = '', bare = false }) {
  const opener = document.activeElement;
  const root = document.getElementById('modal-root');
  const titleId = `m${Math.random().toString(36).slice(2, 8)}`;
  const content = h('div', { class: 'modal-body' }, body);
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': t('common.close'), type: 'button' }, '✕');
  const box = h('div', { class: `modal ${className}`, role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    ...(bare ? [h('h2', { id: titleId, class: 'sr' }, title)] : [h('div', { class: 'modal-head' }, h('h2', { id: titleId }, title), closeBtn)]), content);
  const overlay = h('div', { class: 'overlay' }, box);
  const layer = openLayer(() => api.close());
  const api = {
    el: content,
    setBody(...nodes) { clear(content).append(...nodes.flat()); },
    close() {
      closeLayer(layer);
      if (!overlay.isConnected) return;
      overlay.remove();
      modalStack.splice(modalStack.indexOf(api), 1);
      document.removeEventListener('keydown', onKey);
      onClose?.();
      if (opener?.isConnected) opener.focus?.();
    },
  };
  const onKey = (e) => {
    if (e.key === 'Escape' && modalStack[modalStack.length - 1] === api) { e.stopPropagation(); api.close(); }
  };
  closeBtn.addEventListener('click', api.close);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) api.close(); });
  document.addEventListener('keydown', onKey);
  root.append(overlay);
  modalStack.push(api);
  (content.querySelector('input, textarea, select, button') || closeBtn).focus();
  return api;
}

export function confirmDialog(message, { okLabel = t('common.ok'), danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const m = modal({
      title: message,
      body: h('div', { class: 'row', style: { justifyContent: 'flex-end' } },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => { finish(false); m.close(); } }, t('common.cancel')),
        h('button', { class: `btn ${danger ? 'danger' : ''}`, type: 'button', onclick: () => { finish(true); m.close(); } }, okLabel)),
      onClose: () => finish(false),
    });
  });
}

// ---------------------------------------------------------------- popup menu
let openMenu = null;
let menuLayer = null;
export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
  if (menuLayer) { closeLayer(menuLayer); menuLayer = null; }
}

/** items: [{ label, onClick, danger }] | { emojis: [...], onPick, active: Set } */
export function popMenu(anchor, items) {
  closeMenu();
  const el = h('div', { class: 'menu', role: 'menu' });
  for (const it of items) {
    if (it.emojis) {
      el.append(h('div', { class: 'emoji-row' }, it.emojis.map((e) =>
        h('button', { type: 'button', role: 'menuitem', 'aria-label': e, onclick: () => { closeMenu(); it.onPick(e); } }, e))));
    } else {
      el.append(h('button', {
        type: 'button', role: 'menuitem', class: it.danger ? 'danger' : '',
        onclick: () => { closeMenu(); it.onClick(); },
      }, it.label));
    }
  }
  document.body.append(el);
  const r = anchor.getBoundingClientRect();
  const w = el.offsetWidth;
  const hgt = el.offsetHeight;
  let left = Math.min(Math.max(8, r.right - w), window.innerWidth - w - 8);
  let top = r.bottom + 4;
  if (top + hgt > window.innerHeight - 8) top = Math.max(8, r.top - hgt - 4);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  openMenu = el;
  menuLayer = openLayer(() => { menuLayer = null; closeMenu(); });
  el.querySelector('button')?.focus();
  const off = (e) => {
    // a newer menu may have replaced this one (submenus): never close that one from a stale listener
    if (openMenu !== el) { document.removeEventListener('mousedown', off, true); return; }
    if (!el.contains(e.target)) { closeMenu(); document.removeEventListener('mousedown', off, true); }
  };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
  el.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeMenu(); anchor.focus?.(); } });
}

// ---------------------------------------------------------------- misc
/** "Outgoing call · 2:13", "Missed call", ... for a call history message. */
export function callLabel(m, myId) {
  const [status, flag] = String(m.text || '').split(':');
  const mine = m.sender_id === myId;
  const video = flag === 'video' ? ` (${t('call.video')})` : '';
  const dur = m.duration ? ` · ${Math.floor(m.duration / 60)}:${String(m.duration % 60).padStart(2, '0')}` : '';
  if (status === 'ended') return `${t(mine ? 'call.out' : 'call.in')}${video}${dur}`;
  if (status === 'missed') return mine ? t('call.no_answer') : t('call.missed');
  if (status === 'declined') return mine ? t('call.declined') : t('call.declined_in');
  if (status === 'busy') return t('call.busy');
  return t('call.cancelled');
}

export function previewText(m) {
  if (!m) return '';
  if (m.kind === 'call') return `📞 ${callLabel(m, S.me?.id)}`;
  if (m.kind === 'secret') return m.plain !== undefined ? `🔒 ${m.plain}` : `🔒 ${t('secret.message')}`;
  if (m.kind === 'poll') return `📊 ${m.text}`;
  if (m.kind === 'location') return `📍 ${t('msg.location')}`;
  if (m.kind === 'contact') { try { return `👤 ${JSON.parse(m.text).name}`; } catch { return `👤 ${t('msg.contact')}`; } }
  if (m.text) return m.text;
  const map = { image: `🖼 ${t('msg.photo')}`, video: `🎬 ${t('msg.video')}`, audio: `🎵 ${t('msg.audio')}`, voice: `🎤 ${t('msg.voice')}`, file: `📎 ${m.file?.name || t('msg.file')}` };
  return map[m.kind] || '';
}

export function lightbox(src) {
  const m = modal({ title: '', className: 'lightbox', body: h('img', { src, alt: '' }) });
  return m;
}

let audioCtx;
export function beep() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.0001, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.15, audioCtx.currentTime + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.25);
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + 0.26);
  } catch { /* autoplay policy */ }
}
