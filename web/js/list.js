import { tgOnline } from './tgpresence.js';
import { justSwiped, swipeLeft } from './swipe.js';
import { h, clear, debounce, hscroll } from './dom.js';
import { t, errText } from './i18n.js';
import { S, chatTitle, fire, isMuted, on } from './state.js';
import { api, outbox } from './net.js';
import { avatar, callLabel, confirmDialog, fmtListTime, matchLine, popMenu, previewText, toast } from './ui.js';
import { startCall } from './call.js';
import { icon } from './icons.js';
import { openInfo, openNewChat, openNewGroup, openSettings } from './dialogs.js';
import { openSaved, setView } from './rail.js';
import { folderPicker, openFolders, openGlobalSearch } from './extras.js';
import { groupCallOf } from './gcall.js';
import { openSecretByDefault } from './secret.js';
import { openBotFather } from './bots.js';
import { storiesBar } from './stories.js';

let el;
let listEl;
let netEl;
let searchInput;
let titleEl;
let greetEl;
let heroEl;
let compact = false;
let tabsEl;
let recentEl;
let wired = false;
let remote = { users: [], messages: [], loading: false, term: '' };

const TABS = ['all', 'inbox', 'direct', 'group', 'channel', 'unread'];

/** "Inbox": what wants an answer from you: unread chats that are not muted, chats where you were mentioned, chats with your open tasks. */
function inInbox(c) {
  if (c.archived) return false;
  if (S.taskCount?.chats?.includes(c.id)) return true;
  if (c.unread <= 0) return false;
  if (!isMuted(c)) return true;
  const me = S.me?.username;
  return !!me && new RegExp(`@${me}\\b`, 'i').test(c.last_message?.text || '');
}

const isPhone = () => window.matchMedia('(max-width: 600px)').matches;

/** The big header (greeting, search, stories) folds into a thin bar with the main buttons while the list is scrolled. */
function setCompact(v) {
  if (!heroEl) return;
  compact = v;
  heroEl.classList.toggle('compact', v || document.documentElement.classList.contains('compact-ui')); // the compact interface keeps the header folded
}

function onListScroll() {
  if (!isPhone() || !listEl || !heroEl) return;
  const top = listEl.scrollTop;
  if (!compact) {
    // fold only when the list is long enough to stay scrollable after the header has given its room back (no flicker)
    const gain = heroEl.querySelector('.hero-inner')?.offsetHeight || 0;
    const room = listEl.scrollHeight - listEl.clientHeight;
    if (top > 48 && room > gain + 80) setCompact(true);
  } else if (top <= 2) {
    setCompact(false);
  }
}

export function mount(sidebar) {
  el = sidebar;
  searchInput = h('input', {
    class: 'input', type: 'search', placeholder: t('search.chats'), 'aria-label': t('search.chats'),
    oninput: () => { S.query = searchInput.value.trim(); runRemote(); render(); },
  });
  titleEl = h('h2', { class: 'view-title' });
  const composeBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('menu.new_chat'), 'aria-haspopup': 'menu' }, icon('compose', 24));
  composeBtn.classList.add('compose-btn');
  const composeMenu = (anchor) => popMenu(anchor, [
    { label: t('menu.new_group'), onClick: () => openNewGroup('group') },
    { label: t('menu.new_channel'), onClick: () => openNewGroup('channel') },
    { label: t('menu.new_chat'), onClick: openNewChat },
  ]);
  composeBtn.onclick = () => composeMenu(composeBtn);
  const fab = h('button', { class: 'fab', type: 'button', 'aria-label': t('menu.new_chat'), 'aria-haspopup': 'menu', onclick: () => composeMenu(fab) }, icon('compose', 24));
  // phone layout: the search field is hidden until the magnifier is tapped (more room for chats, like Telegram)
  const searchBtn = h('button', { class: 'icon-btn only-mobile', type: 'button', 'aria-label': t('search.chats'), onclick: () => { el.dataset.search = 'open'; setCompact(false); listEl.scrollTo({ top: 0 }); searchInput.focus(); } }, icon('search', 24));
  searchInput.addEventListener('focus', () => setCompact(false));
  searchInput.addEventListener('blur', () => { if (!searchInput.value && el) delete el.dataset.search; });
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchInput.value = ''; S.query = ''; searchInput.blur(); render(); } });

  recentEl = h('div', { class: 'recent', hidden: true, 'aria-label': t('nav.messages') });
  tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  hscroll(tabsEl);
  drawTabs();
  netEl = h('div', { class: 'netbar', role: 'status', hidden: true });
  listEl = h('div', { class: 'chatlist', role: 'list' });
  listEl.addEventListener('keydown', listKeys);
  listEl.addEventListener('scroll', onListScroll, { passive: true });

  const nav = h('nav', { class: 'bottomnav', 'aria-label': t('app.name') },
    navBtn('chat', t('nav.messages'), () => setView('chats'), 'chats'),
    navBtn('phone', t('nav.calls'), () => setView('calls'), 'calls'),
    navBtn('users', t('nav.contacts'), () => setView('contacts'), 'contacts'),
    navBtn('settings', t('nav.settings'), openSettings));

  greetEl = h('div', { class: 'greet' }, h('span', { class: 'greet-hi' }), h('b', { class: 'greet-main' }), h('span', { class: 'greet-sub' }));
  const searchBox = h('div', { class: 'search' }, icon('search', 18), searchInput);
  clear(el).append(
    (heroEl = h('div', { class: 'hero' },
    h('div', { class: 'side-head2' }, h('span', { class: 'brand-word' }, h('img', { class: 'brand-logo sm', src: '/icon.svg?v=2', alt: '', width: 32, height: 32 }), 'Suhbat-dosh'), titleEl, h('span', { class: 'grow' }), searchBtn, composeBtn),
    h('div', { class: 'hero-body' }, h('div', { class: 'hero-inner' }, greetEl, searchBox, storiesBar())))),
    tabsEl, netEl, listEl, nav, fab,
  );

  if (!wired) {
    wired = true;
    on('chats', render);
    on('tasks', render);
    on('folders', () => { drawTabs(); render(); });
    on('gcalls', render);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openGlobalSearch(); }
    });
    on('net', renderNet);
    on('outbox', renderNet);
    on('active', render);
    on('view', () => { setCompact(false); searchInput.value = ''; S.query = ''; remote = { users: [], messages: [], loading: false, term: '' }; render(); });
    on('focus-search', () => { searchInput?.focus(); searchInput?.select(); });
  }
  renderNet();
  render();
}

function navBtn(ico, label, onclick, view) {
  return h('button', { type: 'button', dataset: { view: view || '' }, onclick },
    h('span', { class: 'nb-ico' }, icon(ico, 24), view === 'chats' ? h('span', { class: 'nb-badge', hidden: true }) : null),
    h('span', { class: 'nb-label' }, label));
}

export function renderNet() {
  if (!netEl) return;
  const queued = outbox.all().length;
  const parts = [];
  if (S.net === 'offline') parts.push(t('net.offline'));
  else if (S.net === 'connecting') parts.push(t('net.connecting'));
  if (queued) parts.push(t('net.queued', { n: queued }));
  netEl.hidden = parts.length === 0;
  netEl.textContent = parts.join(' · ');
  netEl.classList.toggle('offline', S.net === 'offline');
}

const runRemote = debounce(async () => {
  const term = S.query;
  if (term.length < 2) {
    remote = { users: [], messages: [], loading: false, term };
    return render();
  }
  remote.loading = true;
  remote.term = term;
  render();
  try {
    const calls = [api('GET', `/api/users/search?q=${encodeURIComponent(term)}`)];
    if (S.view !== 'contacts') calls.push(api('GET', `/api/search/messages?q=${encodeURIComponent(term)}`));
    const [u, m] = await Promise.all(calls);
    if (S.query !== term) return;
    remote = { users: u.users, messages: m?.messages ?? [], loading: false, term };
  } catch {
    remote = { users: [], messages: [], loading: false, term };
  }
  render();
}, 300);

/** Built-in filters followed by the user's folders. */
function drawTabs() {
  if (!tabsEl) return;
  clear(tabsEl);
  const add = (f, label) => tabsEl.append(h('button', {
    class: 'tab', type: 'button', role: 'tab', 'aria-selected': String(S.filter === f), dataset: { f },
    onclick: () => { S.filter = f; render(); },
  }, label));
  for (const f of TABS) add(f, t(`filter.${f}`));
  for (const f of S.folders || []) add(`f:${f.id}`, `${f.emoji ? `${f.emoji} ` : ''}${f.name}`);
  tabsEl.dataset.sel = '';
}

const RULE_TEST = {
  direct: (c) => c.type === 'direct' && !c.saved && !c.peer?.is_bot,
  groups: (c) => c.type === 'group',
  channels: (c) => c.type === 'channel',
  bots: (c) => c.type === 'direct' && !!c.peer?.is_bot,
  telegram: (c) => !!c.imported,
};
const RULE_SKIP = { muted: (c) => isMuted(c), read: (c) => c.unread <= 0, archived: (c) => !!c.archived };

/** A folder holds the chats picked by hand, and the chats that fit its rules (unless the rules leave them out). */
export function inFolder(f, c) {
  if (f.chat_ids.includes(c.id)) return true;
  const r = f.rules;
  if (!r?.include?.length) return false;
  return r.include.some((k) => RULE_TEST[k]?.(c)) && !(r.exclude || []).some((k) => RULE_SKIP[k]?.(c));
}

function passesFilter(c, filter = S.filter) {
  if (filter.startsWith('f:')) { const f = S.folders?.find((x) => `f:${x.id}` === filter); return !!f && inFolder(f, c); }
  switch (filter) {
    case 'unread': return c.unread > 0;
    case 'inbox': return inInbox(c);
    case 'direct': return c.type === 'direct';
    case 'group': return c.type === 'group';
    case 'channel': return c.type === 'channel';
    default: return true;
  }
}

function lastLine(c) {
  if (c.draft && S.active !== c.id) {
    return [h('span', { class: 'draft' }, `${t('list.draft')}: `), c.draft];
  }
  const m = c.last_message;
  if (!m) return '';
  const mine = c.imported ? m.import_author === c.import_me : m.sender_id === S.me.id;
  const prefix = c.imported ? (mine ? `${t('chat.you')}: ` : `${m.import_author || ''}: `) : mine ? (c.type === 'channel' || c.saved ? '' : `${t('chat.you')}: `) : c.type !== 'direct' ? `${S.users.get(m.sender_id)?.name ?? ''}: ` : '';
  return `${prefix}${previewText(m)}`;
}

function listKeys(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const items = [...listEl.querySelectorAll('.ci')];
  const i = items.indexOf(document.activeElement);
  if (i === -1) return;
  e.preventDefault();
  items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
}

function chatMenu(anchor, c) {
  popMenu(anchor, [
    { label: t('ctx.open'), onClick: () => fire('open-chat', c.id) },
    ...(c.unread > 0 ? [{ label: t('ctx.mark_read'), onClick: () => { if (c.last_message) api('POST', `/api/chats/${c.id}/read`, { message_id: c.last_message.id }).catch(() => {}); } }] : []),
    { label: isMuted(c) ? t('ctx.unmute') : t('ctx.mute'), onClick: () => api('PATCH', `/api/chats/${c.id}/me`, isMuted(c) ? { muted: false, muted_until: 0 } : { muted: true, muted_until: 0 }).catch((e) => toast(errText(e.code))) },
    { label: c.archived ? t('archive.remove') : t('archive.add'), onClick: () => api('PATCH', `/api/chats/${c.id}/me`, { archived: !c.archived }).catch((e) => toast(errText(e.code))) },
    { label: c.pinned_at ? t('ctx.unpin') : t('ctx.pin'), onClick: () => api('POST', `/api/chats/${c.id}/pin-chat`, { pinned: !c.pinned_at }).catch((e) => toast(errText(e.code))) },
    { label: t('ctx.folder'), onClick: () => folderPicker(anchor, c) },
    { label: t('ctx.info'), onClick: () => openInfo(c.id) },
    ...(c.saved || (c.imported === 'tgbridge' && !S.me.is_admin) ? [] : [{ label: c.type === 'direct' ? t('chat.delete') : t('info.leave'), danger: true, onClick: () => removeChat(c) }]),
  ]);
}

async function removeChat(c) {
  const direct = c.type === 'direct';
  if (!(await confirmDialog(t(direct ? 'chat.delete_confirm' : 'info.leave_confirm'), { okLabel: t(direct ? 'chat.delete' : 'info.leave'), danger: true }))) return;
  try {
    if (direct) await api('POST', `/api/chats/${c.id}/hide`);
    else await api('DELETE', `/api/chats/${c.id}/members/${S.me.id}`);
    S.chats.delete(c.id);
    S.msgs.delete(c.id);
    fire('chat-removed', c.id);
  } catch (e) { toast(errText(e.code)); }
}

function entityOf(c) {
  return c.type === 'direct' ? c.peer : { id: c.id, name: c.title, avatar: c.avatar, online: tgOnline(c) };
}

function item(c) {
  const badge = c.unread > 0 ? h('span', { class: `badge ${isMuted(c) ? 'muted' : ''}`, 'aria-label': `${c.unread}` }, c.unread > 99 ? '99+' : c.unread) : null;
  const btn = h('button', {
    class: 'ci', type: 'button', role: 'listitem', 'aria-current': String(S.active === c.id), dataset: { chatId: c.id },
    onclick: () => { if (!justSwiped()) fire('open-chat', c.id); },
    oncontextmenu: (e) => { e.preventDefault(); chatMenu(e.currentTarget, c); },
  },
  avatar(entityOf(c)),
  h('span', { class: 'ci-main' },
    h('span', { class: 'ci-top' }, h('span', { class: 'ci-title ellipsis' }, chatTitle(c), isMuted(c) ? h('span', { class: 'mute-ico', title: t('info.mute') }, ' 🔕') : null, c.pinned_at ? h('span', { class: 'pin-ico', title: t('ctx.pin') }, icon('pin', 14)) : null, groupCallOf(c.id) ? h('span', { class: 'live-call', title: t('gcall.in_progress') }, icon('phone', 14)) : null),
      h('span', { class: `ci-time${c.unread > 0 ? ' hot' : ''}` }, fmtListTime(c.last_message?.created_at ?? c.last_message_at))),
    h('span', { class: 'ci-bot' }, h('span', { class: 'ci-last ellipsis' }, lastLine(c)), badge)));
  swipeLeft(btn, {
    onMove: (dx, done) => { btn.style.transform = done || !dx ? '' : `translateX(${dx}px)`; },
    onCommit: () => chatMenu(btn, c),
  });
  return btn;
}

function personRow(u, onclick) {
  return h('button', { class: 'ci', type: 'button', role: 'listitem', onclick },
    avatar(u),
    h('span', { class: 'ci-main' }, h('span', { class: 'ci-title ellipsis' }, u.name),
      h('span', { class: 'ci-last ellipsis' }, u.username ? `@${u.username}` : u.status || '')));
}

async function openPerson(u) {
  try {
    if (await openSecretByDefault(u)) { S.view = 'chats'; fire('view'); return; }
    const r = await api('POST', '/api/chats/direct', { user_id: u.id });
    S.chats.set(r.chat.id, r.chat);
    searchInput.value = '';
    S.query = '';
    S.view = 'chats';
    fire('view');
    fire('open-chat', r.chat.id);
  } catch (e) { toast(errText(e.code)); }
}

function empty(emoji, title, hint, action) {
  return h('div', { class: 'empty' }, h('div', { class: 'empty-emoji' }, emoji), h('h3', null, title), hint ? h('p', null, hint) : null, action);
}

export function render() {
  if (!listEl) return;
  setCompact(compact);
  const view = S.view;
  titleEl.textContent = t(view === 'contacts' ? 'nav.contacts' : view === 'archive' ? 'nav.archive' : view === 'calls' ? 'nav.calls' : 'nav.messages');
  if (greetEl) {
    const hr = new Date().getHours();
    const unread = [...S.chats.values()].reduce((a, c) => a + (isMuted(c) || c.archived ? 0 : c.unread), 0);
    greetEl.querySelector('.greet-hi').textContent = t(hr < 5 ? 'greet.night' : hr < 12 ? 'greet.morning' : hr < 18 ? 'greet.day' : 'greet.evening');
    greetEl.querySelector('.greet-main').textContent = (S.me?.name || '').split(' ')[0];
    greetEl.querySelector('.greet-sub').textContent = unread ? t('greet.unread', { n: unread }) : t('greet.clear');
  }
  const ph = t(view === 'contacts' ? 'search.people' : 'search.chats');
  searchInput.placeholder = ph;
  searchInput.setAttribute('aria-label', ph);
  tabsEl.hidden = view === 'contacts' || view === 'calls';
  tabsEl.querySelectorAll('.tab').forEach((b) => {
    const on = b.dataset.f === S.filter;
    b.setAttribute('aria-selected', String(on));
    // chats with something new in this folder (not muted, not archived), shown on the tabs you are not looking at
    let badge = b.querySelector('.tab-n');
    const n = on || b.dataset.f === 'all' ? 0 : [...S.chats.values()].filter((c) => !c.archived && !isMuted(c) && c.unread > 0 && passesFilter(c, b.dataset.f)).length;
    if (n && !badge) b.append(badge = h('span', { class: 'tab-n' }));
    if (badge) { badge.textContent = n > 99 ? '99+' : String(n); badge.hidden = !n; }
    if (on && tabsEl.dataset.sel !== S.filter) {
      tabsEl.dataset.sel = S.filter;
      b.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    }
  });
  el.querySelectorAll('.bottomnav button').forEach((b) => b.setAttribute('aria-current', String(b.dataset.view === view)));
  const nb = el.querySelector('.nb-badge');
  if (nb) {
    const n = [...S.chats.values()].reduce((a, c) => a + (isMuted(c) || c.archived ? 0 : c.unread), 0);
    nb.hidden = n === 0;
    nb.textContent = n > 99 ? '99+' : String(n);
    try { if (n > 0) navigator.setAppBadge?.(n); else navigator.clearAppBadge?.(); } catch { /* not supported */ }
  }

  renderRecent();
  clear(listEl);
  const q = S.query.toLowerCase();

  if (view === 'calls') {
    renderCalls(q);
    return;
  }

  if (view === 'contacts') {
    const seen = new Map();
    for (const c of S.chats.values()) if (c.type === 'direct' && !c.saved && c.peer) seen.set(c.peer.id, c.peer);
    const people = [...seen.values()].filter((u) => !q || `${u.name} ${u.username || ''}`.toLowerCase().includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const u of people) listEl.append(personRow(u, () => openPerson(u)));
    const known = new Set(people.map((u) => u.id));
    const others = remote.users.filter((u) => !known.has(u.id));
    if (others.length) {
      listEl.append(h('div', { class: 'section-title' }, t('list.people')));
      for (const u of others) listEl.append(personRow(u, () => openPerson(u)));
    }
    if (remote.loading) listEl.append(h('div', { class: 'empty' }, t('list.loading')));
    if (!people.length && !others.length && !remote.loading) {
      listEl.append(q ? h('div', { class: 'empty' }, t('list.nothing')) : empty('👥', t('contacts.empty'), t('contacts.empty_hint'),
        h('button', { class: 'btn', type: 'button', onclick: openNewChat }, t('menu.find'))));
    }
    return;
  }

  const wantArchived = view === 'archive';
  const chats = [...S.chats.values()].filter((c) => !c.saved && !!c.archived === wantArchived).filter((c) => passesFilter(c))
    .filter((c) => !q || chatTitle(c).toLowerCase().includes(q))
    .sort((a, b) => ((b.pinned_at ? 1 : 0) - (a.pinned_at ? 1 : 0))
      || ((b.pinned_at || 0) - (a.pinned_at || 0))
      || (b.last_message?.created_at ?? b.last_message_at) - (a.last_message?.created_at ?? a.last_message_at));

  for (const c of chats) listEl.append(item(c));

  if (q.length >= 2 && !wantArchived) {
    if (remote.loading) listEl.append(h('div', { class: 'empty' }, t('list.loading')));
    if (remote.users.length) {
      listEl.append(h('div', { class: 'section-title' }, t('list.people')));
      for (const u of remote.users) listEl.append(personRow(u, () => openPerson(u)));
    }
    if (remote.messages.length) {
      listEl.append(h('div', { class: 'section-title' }, t('list.messages')));
      for (const m of remote.messages) {
        const c = S.chats.get(m.chat_id);
        if (!c) continue;
        listEl.append(h('button', { class: 'ci', type: 'button', role: 'listitem', onclick: () => fire('jump', { chatId: c.id, msgId: m.id }) },
          avatar(entityOf(c)), h('span', { class: 'ci-main' }, h('span', { class: 'ci-title ellipsis' }, chatTitle(c)), h('span', { class: 'ci-last ellipsis' }, matchLine(m, S.query)))));
      }
    }
    if (!chats.length && !remote.users.length && !remote.messages.length && !remote.loading) listEl.append(h('div', { class: 'empty' }, t('list.nothing')));
    return;
  }

  if (!chats.length) {
    if (wantArchived) listEl.append(empty('🗄', t('archive.empty'), t('archive.empty_hint')));
    else if ([...S.chats.values()].some((c) => !c.saved && !c.archived)) listEl.append(h('div', { class: 'empty' }, t('list.nothing')));
    else listEl.append(empty('👋', t('list.empty'), t('list.empty_hint'), h('button', { class: 'btn', type: 'button', onclick: openNewChat }, t('menu.find'))));
  }
}

// ---- call history (Calls section)
let callsCache = { at: 0, items: [], loading: false };

async function loadCalls() {
  if (callsCache.loading) return;
  callsCache.loading = true;
  try {
    const r = await api('GET', '/api/calls');
    callsCache = { at: Date.now(), items: r.calls, loading: false };
  } catch {
    callsCache.loading = false;
  }
  if (S.view === 'calls') render();
}

on('call-state', () => { if (S.view === 'calls') loadCalls(); });

function renderCalls(q) {
  if (Date.now() - callsCache.at > 15000) loadCalls();
  const items = callsCache.items.filter((m) => {
    const c = S.chats.get(m.chat_id);
    return c && (!q || chatTitle(c).toLowerCase().includes(q));
  });
  if (!items.length) {
    listEl.append(callsCache.loading
      ? h('div', { class: 'empty' }, t('list.loading'))
      : empty('📞', t('calls.empty'), t('calls.empty_hint')));
    return;
  }
  for (const m of items) {
    const c = S.chats.get(m.chat_id);
    const [status, flag] = String(m.text).split(':');
    const mine = m.sender_id === S.me.id;
    const bad = status === 'missed' && !mine;
    listEl.append(h('button', {
      class: 'ci', type: 'button', role: 'listitem', title: t('call.back'),
      onclick: () => startCall(c.id, flag === 'video'),
    },
    avatar(entityOf(c)),
    h('span', { class: 'ci-main' },
      h('span', { class: 'ci-top' }, h('span', { class: `ci-title ellipsis${bad ? ' bad' : ''}` }, chatTitle(c)), h('span', { class: 'ci-time' }, fmtListTime(m.created_at))),
      h('span', { class: 'ci-bot' }, h('span', { class: `ci-last ellipsis${bad ? ' bad' : ''}` }, callLabel(m, S.me.id)))),
    h('span', { class: 'call-ico' }, icon(flag === 'video' ? 'video' : 'phone', 20))));
  }
}

// strip of the most recent people (tap to open), like the stories row in the design
function renderRecent() {
  if (!recentEl) return;
  const chats = [...S.chats.values()]
    .filter((c) => c.type === 'direct' && !c.saved && !c.archived && c.peer)
    .sort((a, b) => (b.last_message?.created_at ?? b.last_message_at) - (a.last_message?.created_at ?? a.last_message_at))
    .slice(0, 8);
  const show = S.view === 'chats' && !S.query && S.filter === 'all' && chats.length >= 2;
  recentEl.hidden = !show;
  if (!show) return;
  clear(recentEl);
  for (const c of chats) {
    recentEl.append(h('button', { type: 'button', title: c.peer.name, onclick: () => fire('open-chat', c.id) },
      avatar(c.peer), h('b', null, c.peer.name.split(' ')[0])));
  }
}
