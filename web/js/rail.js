import { featureOn } from './features.js';
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { S, fire, isMuted, on, savePrefs } from './state.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { avatar, toast, modal } from './ui.js';
import { openSettings } from './dialogs.js';
import { openCalendar } from './events.js';
import { openNearby } from './nearby.js';
import { openTasks, refreshTaskCount } from './tasks.js';
import { focusOn, openFocus } from './focus.js';
import { openRooms, roomsLive } from './rooms.js';
import { openSelfNotes } from './selfnotes.js';

// Left navigation rail (desktop / tablet): Messages, Contacts, Calls, Saved, Archive, Settings.
let el;
let wired = false;

export async function openSaved() {
  try {
    const r = await api('POST', '/api/chats/saved');
    S.chats.set(r.chat.id, r.chat);
    fire('chats');
    fire('open-chat', r.chat.id);
  } catch { toast(t('err.generic')); }
}

export function setView(v) {
  S.view = v;
  fire('view');
}

export function mount(node) {
  el = node;
  if (!wired) {
    wired = true;
    on('view', render);
    on('active', render);
    on('me', render);
    on('chats', renderBadge);
    on('tasks', render);
    on('gcalls', render);
    on('focus', render);
    refreshTaskCount();
  }
  render();
}

const unreadTotal = () => [...S.chats.values()].reduce((a, c) => a + (isMuted(c) || c.archived ? 0 : c.unread), 0);

function item(id, ico, label, { onclick, active, soon, dot } = {}) {
  const b = h('button', {
    class: `rail-item${active ? ' active' : ''}`, type: 'button', 'aria-label': label, 'aria-current': active ? 'page' : null,
    dataset: { id }, onclick,
  }, h('span', { class: 'rail-ico' }, icon(ico, 24), dot ? h('span', { class: 'rail-dot', 'aria-hidden': 'true' }) : null, id === 'messages' ? h('span', { class: 'rail-badge', hidden: true }) : null,
    id === 'tasks' && S.taskCount?.open ? h('span', { class: `rail-badge${S.taskCount.overdue ? ' bad' : ''}` }, S.taskCount.open > 99 ? '99+' : String(S.taskCount.open)) : null), h('span', { class: 'rail-label' }, label));
  if (soon) b.classList.add('soon');
  return b;
}

const DEFAULT_PINS = [];
const pins = () => (Array.isArray(S.prefs.railPins) ? S.prefs.railPins : DEFAULT_PINS).filter(featureOn);

/** Everything beyond the four main places; each can be pinned to the rail from the "More" window. */
function tools() {
  return [
    { id: 'calendar', ico: 'clock', label: t('ev.calendar'), onclick: openCalendar },
    { id: 'tasks', ico: 'tasks', label: t('task.title'), onclick: openTasks },
    { id: 'selfnotes', ico: 'edit', label: t('sn.title'), onclick: openSelfNotes },
    { id: 'rooms', ico: 'speaker', label: t('room.title_all'), onclick: openRooms, dot: roomsLive() > 0 },
    { id: 'focus', ico: 'moon', label: t('focus.title'), onclick: openFocus, dot: focusOn() },
    { id: 'nearby', ico: 'wifi', label: t('nb.title'), onclick: () => openNearby() },
    { id: 'archive', ico: 'archive', label: t('nav.archive'), onclick: () => setView('archive'), active: S.view === 'archive' },
    { id: 'settings', ico: 'settings', label: t('nav.settings'), onclick: openSettings },
  ].filter((x) => featureOn(x.id));
}

function togglePin(id) {
  const cur = pins().slice();
  const i = cur.indexOf(id);
  if (i >= 0) cur.splice(i, 1); else cur.push(id);
  S.prefs.railPins = cur;
  savePrefs();
  render();
}

function openMore() {
  const m = modal({ title: t('nav.more'), className: 'rail-more' });
  const draw = () => m.setBody(
    h('p', { class: 'muted small' }, t('nav.more_hint')),
    ...tools().map((x) => h('div', { class: 'more-row' },
      h('button', { class: 'more-open', type: 'button', onclick: () => { m.close(); x.onclick(); } }, icon(x.ico, 22), h('span', null, x.label)),
      x.id === 'settings' ? null : h('button', {
        class: `more-pin${pins().includes(x.id) ? ' on' : ''}`, type: 'button', 'aria-pressed': String(pins().includes(x.id)),
        title: pins().includes(x.id) ? t('nav.unpin') : t('nav.pin'), 'aria-label': pins().includes(x.id) ? t('nav.unpin') : t('nav.pin'),
        onclick: () => { togglePin(x.id); draw(); },
      }, icon('pin', 20)))));
  draw();
}

function render() {
  if (!el) return;
  const wide = !!S.prefs.railWide;
  el.classList.toggle('wide', wide);
  el.closest('.app')?.classList.toggle('rail-wide', wide);
  const savedActive = S.active && S.chats.get(S.active)?.saved;
  const pinned = tools().filter((x) => pins().includes(x.id) && x.id !== 'settings');
  clear(el).append(
    h('div', { class: 'rail-brand', title: 'Suhbat-dosh' }, h('img', { class: 'brand-logo', src: '/icon.svg?v=2', alt: '', width: 48, height: 48 }), h('span', { class: 'brand-name' }, 'Suhbat-dosh'),
      h('button', { class: 'rail-toggle', type: 'button', 'aria-label': wide ? t('nav.collapse') : t('nav.expand'), title: wide ? t('nav.collapse') : t('nav.expand'), 'aria-expanded': String(wide),
        onclick: () => { S.prefs.railWide = !S.prefs.railWide; savePrefs(); render(); } }, icon('chevron', 18))),
    h('nav', { class: 'rail-nav', 'aria-label': t('app.name') },
      item('messages', 'chat', t('nav.messages'), { active: S.view === 'chats' && !savedActive, onclick: () => setView('chats') }),
      item('contacts', 'users', t('nav.contacts'), { active: S.view === 'contacts', onclick: () => setView('contacts') }),
      item('calls', 'phone', t('nav.calls'), { active: S.view === 'calls', onclick: () => setView('calls') }),
      item('saved', 'bookmark', t('nav.saved'), { active: !!savedActive, onclick: openSaved }),
      pinned.length ? h('div', { class: 'rail-sep', role: 'separator' }) : null,
      ...pinned.map((x) => item(x.id, x.ico, x.label, { onclick: x.onclick, active: x.active, dot: x.dot })),
      h('div', { class: 'rail-sep', role: 'separator' }),
      item('more', 'apps', t('nav.more'), { onclick: openMore, dot: tools().some((x) => x.dot && !pins().includes(x.id)) })),
    h('button', { class: 'rail-me', type: 'button', 'aria-label': S.me?.name || t('nav.settings'), onclick: openSettings },
      avatar({ ...S.me, online: true }, ''),
      h('span', { class: 'rail-me-text' }, h('b', null, S.me?.name || ''), h('small', null, S.me?.username ? `@${S.me.username}` : ''))),
  );
  renderBadge();
}

function renderBadge() {
  const b = el?.querySelector('.rail-badge');
  if (!b) return;
  const n = unreadTotal();
  b.hidden = n === 0;
  b.textContent = n > 99 ? '99+' : String(n);
}
