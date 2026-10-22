import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { S, fire, isMuted, on } from './state.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { avatar, toast } from './ui.js';
import { openSettings } from './dialogs.js';
import { openDrive } from './drive.js';
import { openCalendar } from './events.js';
import { nearbyAvailable, openNearby } from './nearby.js';

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
  }
  render();
}

const unreadTotal = () => [...S.chats.values()].reduce((a, c) => a + (isMuted(c) || c.archived ? 0 : c.unread), 0);

function item(id, ico, label, { onclick, active, soon } = {}) {
  const b = h('button', {
    class: `rail-item${active ? ' active' : ''}`, type: 'button', 'aria-label': label, 'aria-current': active ? 'page' : null,
    dataset: { id }, onclick,
  }, h('span', { class: 'rail-ico' }, icon(ico, 24), id === 'messages' ? h('span', { class: 'rail-badge', hidden: true }) : null), h('span', { class: 'rail-label' }, label));
  if (soon) b.classList.add('soon');
  return b;
}

function render() {
  if (!el) return;
  const savedActive = S.active && S.chats.get(S.active)?.saved;
  clear(el).append(
    h('div', { class: 'rail-brand', title: 'Suhbat-dosh' }, h('img', { class: 'brand-logo', src: '/icon.svg?v=2', alt: '', width: 48, height: 48 }), h('span', { class: 'brand-name' }, 'Suhbat-dosh')),
    h('nav', { class: 'rail-nav', 'aria-label': t('app.name') },
      item('messages', 'chat', t('nav.messages'), { active: S.view === 'chats' && !savedActive, onclick: () => setView('chats') }),
      item('contacts', 'users', t('nav.contacts'), { active: S.view === 'contacts', onclick: () => setView('contacts') }),
      item('calls', 'phone', t('nav.calls'), { active: S.view === 'calls', onclick: () => setView('calls') }),
      item('saved', 'bookmark', t('nav.saved'), { active: !!savedActive, onclick: openSaved }),
      item('drive', 'folder', t('drive.title'), { onclick: openDrive }),
      item('calendar', 'clock', t('ev.calendar'), { onclick: openCalendar }),
      nearbyAvailable() ? item('nearby', 'wifi', t('nb.title'), { onclick: openNearby }) : null,
      item('archive', 'archive', t('nav.archive'), { active: S.view === 'archive', onclick: () => setView('archive') }),
      item('settings', 'settings', t('nav.settings'), { onclick: openSettings })),
    h('button', { class: 'rail-me', type: 'button', 'aria-label': S.me?.name || t('nav.settings'), onclick: openSettings },
      avatar({ ...S.me, online: true }, '')),
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
