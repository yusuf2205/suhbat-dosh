import { EVENTS } from '/shared/contracts.js';
import './ripple.js';
import './dnd.js';
import { mountResizer } from './resizer.js';
import { h, clear } from './dom.js';
import { setLang, t } from './i18n.js';
import { S, bucket, chatTitle, fire, isMuted, on, savePrefs } from './state.js';
import { api, connect, disconnect, flushOutbox, outbox } from './net.js';
import { showLogin } from './auth.js';
import './motion.js';
import { mount as mountList } from './list.js';
import { mount as mountRail } from './rail.js';
import {
  mount as mountChat, openChat, closeChat, upsert, removeMessage, markFailed, renderAll, renderTyping, renderHeader,
  markRead, setConfig, activeChat,
} from './chat.js';
import { beep, modal, toast } from './ui.js';
import { openJoin, renderInfo } from './dialogs.js';
import { drawEmail } from './settings.js';
import { handleCallEvent } from './call.js';
import { isQuietNow, loadFolders, playSound, setFolders } from './extras.js';
import { handleGroupCallEvent, refreshGroupCalls } from './gcall.js';
import { syncPush } from './push.js';
import { initEdgeSwipe } from './swipe.js';
import { handleBack } from './backnav.js';
import { renderGroupCallBar as renderGcallBar, restorePendingUploads } from './chat.js';
import { checkForUpdate, initUpdates } from './updates.js';
import { clearAll as clearMediaCache } from './mediacache.js';
import { snapClear, snapGet, snapSaveBoot } from './snap.js';
import { showLock } from './applock.js';

const root = document.getElementById('root');
let appEl = null;

// ---------------------------------------------------------------- theme
const mq = matchMedia('(prefers-color-scheme: dark)');
/** "By schedule": dark between two times of day (the interval may cross midnight). */
function inDarkHours() {
  const toMin = (v, d) => { const m = /^(\d{1,2}):(\d{2})$/.exec(v || d); return m ? Number(m[1]) * 60 + Number(m[2]) : 0; };
  const from = toMin(S.prefs.themeFrom, '21:00');
  const to = toMin(S.prefs.themeTo, '07:00');
  const d = new Date();
  const now = d.getHours() * 60 + d.getMinutes();
  return from <= to ? now >= from && now < to : now >= from || now < to;
}
function applyTheme() {
  const dark = S.prefs.theme === 'dark' || (S.prefs.theme === 'auto' && mq.matches) || (S.prefs.theme === 'schedule' && inDarkHours());
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--text-scale', String(S.prefs.textScale || 1));
}
mq.addEventListener?.('change', applyTheme);
setInterval(() => { if (S.prefs.theme === 'schedule') applyTheme(); }, 60000);
on('theme', applyTheme);
applyTheme();
setLang(S.prefs.lang);

// ---------------------------------------------------------------- app shell
function buildApp() {
  appEl = h('div', { class: 'app', 'data-view': 'list', 'data-info': 'closed' },
    h('nav', { class: 'rail', 'aria-label': t('app.name') }),
    h('aside', { class: 'sidebar', 'aria-label': t('app.name') }),
    h('main', { class: 'main' }),
    h('aside', { class: 'infopane', 'aria-label': t('chat.info') }));
  clear(root).append(appEl);
  mountRail(appEl.querySelector('.rail'));
  mountList(appEl.querySelector('.sidebar'));
  mountResizer(appEl, appEl.querySelector('.sidebar'));
  mountChat(appEl.querySelector('.main'));
}

function syncView() {
  if (appEl) {
    appEl.dataset.view = S.active ? 'chat' : 'list';
    appEl.dataset.section = S.view;
  }
}
on('view', () => { if (appEl) appEl.dataset.section = S.view; });
on('active', () => { syncView(); renderPane(true); });

// docked info pane (>= 1280px): same content as the info dialog, always visible next to the chat
function renderPane(force = false) {
  const pane = appEl?.querySelector('.infopane');
  // the docked column exists only while a chat is open (no empty white panel on the start screen)
  if (appEl) appEl.dataset.info = S.prefs.info && S.active ? 'open' : 'closed';
  if (!pane || !S.active || S.prefs.info === false || !matchMedia('(min-width: 1280px)').matches) {
    if (pane) pane.replaceChildren();
    return;
  }
  if (!force && pane.contains(document.activeElement)) return;
  const target = {
    setBody(...nodes) { pane.replaceChildren(...nodes.flat()); },
    close() { S.prefs.info = false; savePrefs(); appEl.dataset.info = 'closed'; },
  };
  renderInfo(target, S.active);
}
on('info-toggle', () => {
  S.prefs.info = !S.prefs.info;
  savePrefs();
  renderPane(true);
});
matchMedia('(min-width: 1280px)').addEventListener?.('change', () => renderPane(true));

function updateTitle() {
  const n = [...S.chats.values()].reduce((a, c) => a + (isMuted(c) ? 0 : c.unread), 0);
  document.title = n ? `(${n}) Suhbat-dosh` : 'Suhbat-dosh';
}
on('chats', updateTitle);

// ---------------------------------------------------------------- data sync
async function loadChats() {
  const r = await api('GET', '/api/chats');
  S.chats.clear();
  for (const c of r.chats) {
    S.chats.set(c.id, c);
    if (c.peer) S.users.set(c.peer.id, c.peer);
  }
  fire('chats');
  snapSaveBoot(() => ({ user: S.me, chats: [...S.chats.values()] }));
  loadFolders();
  refreshGroupCalls();
}

/** Called on every (re)connect: pull what we missed while offline, then flush the outbox. */
async function resync() {
  try {
    await loadChats();
    const id = S.active;
    if (id && !S.chats.has(id)) return closeChat();
    if (id) {
      const b = bucket(id);
      const last = [...b.list].reverse().find((m) => typeof m.id === 'number');
      if (last && !b.detached) {
        const r = await api('GET', `/api/chats/${id}/messages?after=${last.id}&limit=100`);
        for (const m of r.messages) upsert(id, m);
      }
      renderAll();
    }
    await flushOutbox();
  } catch (e) {
    if (e.status !== 0) console.error(e);
  }
}
on('resync', resync);
on('ws', (ev) => { if (ev.type === EVENTS.READY && ev.build) checkForUpdate({ build: ev.build, silent: true }); });

on('outbox:sent', ({ message }) => upsert(message.chat_id, message));
on('outbox:failed', ({ client_id }) => markFailed(client_id));
on('chat-removed', (id) => { if (S.active === id) closeChat(); fire('chats'); });
on('open-chat', syncView);
on('gcalls', () => { if (S.active) renderGcallBar(); });

// ---------------------------------------------------------------- realtime events
function notify(chat, m) {
  if (isMuted(chat) || m.sender_id === S.me.id || m.silent) return;
  const visibleHere = document.visibilityState === 'visible' && S.active === chat.id;
  if (visibleHere) return;
  if (isQuietNow()) return; // "do not disturb" hours
  if (S.prefs.sound && chat.sound !== 'none') playSound(chat.sound || 'default');
  if (S.prefs.desktop && window.suhbatShell?.notify && document.visibilityState !== 'visible') {
    window.suhbatShell.notify({ title: chatTitle(chat), body: m.text ? m.text.slice(0, 120) : t(`msg.${m.kind === 'text' ? 'file' : m.kind}`), chat_id: chat.id }).catch(() => {});
  } else if (S.prefs.desktop && window.Notification?.permission === 'granted' && document.visibilityState !== 'visible') {
    const n = new Notification(chatTitle(chat), { body: m.text ? m.text.slice(0, 120) : t(`msg.${m.kind === 'text' ? 'file' : m.kind}`), icon: '/icon.svg?v=2', tag: `chat-${chat.id}` });
    n.onclick = () => { window.focus(); openChat(chat.id); n.close(); };
  }
}

async function onWs(ev) {
  if (typeof ev.type === 'string' && ev.type.startsWith('call.')) return handleCallEvent(ev);
  if (typeof ev.type === 'string' && ev.type.startsWith('gcall.')) return handleGroupCallEvent(ev);
  switch (ev.type) {
    case EVENTS.MESSAGE_NEW: {
      const m = ev.message;
      let c = S.chats.get(m.chat_id);
      if (!c) {
        try {
          const r = await api('GET', `/api/chats/${m.chat_id}`);
          c = r.chat;
          S.chats.set(c.id, c);
          r.members.forEach((x) => S.users.set(x.user.id, x.user));
          S.members.set(c.id, r.members);
        } catch { return; }
      }
      if (m.sender_id && !S.users.has(m.sender_id)) {
        api('GET', `/api/users/${m.sender_id}`).then((r) => { S.users.set(r.user.id, r.user); if (S.active === c.id) renderAll(); }).catch(() => {});
      }
      c.last_message = m;
      c.last_message_at = m.created_at;
      if (m.sender_id !== S.me.id) {
        const here = S.active === c.id && document.visibilityState === 'visible';
        if (!here) c.unread += 1;
        // typing indicator ends when the message lands
        S.typing.get(c.id)?.delete(m.sender_id);
      }
      upsert(c.id, m);
      notify(c, m);
      fire('chats');
      if (S.active === c.id) renderHeader();
      break;
    }
    case EVENTS.MESSAGE_UPDATE: {
      const c = S.chats.get(ev.message.chat_id);
      if (!c) break;
      upsert(c.id, ev.message);
      if (c.last_message?.id === ev.message.id) c.last_message = ev.message;
      if (c.pinned?.id === ev.message.id) c.pinned = ev.message;
      fire('chats');
      break;
    }
    case EVENTS.MESSAGE_DELETE:
      removeMessage(ev.chat_id, ev.message_id);
      break; // chat.update follows with the new last message
    case EVENTS.CHAT_UPDATE: {
      const prev = S.chats.get(ev.chat.id);
      S.chats.set(ev.chat.id, ev.chat);
      if (ev.chat.peer) S.users.set(ev.chat.peer.id, ev.chat.peer);
      if (S.active === ev.chat.id) {
        if (prev && S.typing.has(ev.chat.id)) renderTyping();
        renderAll();
        renderPane();
      }
      fire('chats');
      break;
    }
    case EVENTS.CHAT_REMOVE:
      S.chats.delete(ev.chat_id);
      if (S.active === ev.chat_id) closeChat();
      fire('chats');
      break;
    case EVENTS.READ: {
      const c = S.chats.get(ev.chat_id);
      if (!c) break;
      if (ev.user_id === S.me.id) {
        c.last_read_id = Math.max(c.last_read_id, ev.message_id);
        if (c.last_message && c.last_read_id >= c.last_message.id) c.unread = 0;
        else api('GET', `/api/chats/${c.id}`).then((r) => { S.chats.set(c.id, r.chat); fire('chats'); }).catch(() => {});
      } else {
        c.others_read_id = Math.max(c.others_read_id, ev.message_id);
        c.others_delivered_id = Math.max(c.others_delivered_id, ev.message_id);
      }
      fire('chats');
      if (S.active === c.id) renderAll();
      break;
    }
    case EVENTS.DELIVERED: {
      const c = S.chats.get(ev.chat_id);
      if (!c) break;
      c.others_delivered_id = Math.max(c.others_delivered_id, ev.message_id);
      if (S.active === c.id) renderAll();
      break;
    }
    case EVENTS.TYPING: {
      let map = S.typing.get(ev.chat_id);
      if (!map) S.typing.set(ev.chat_id, (map = new Map()));
      clearTimeout(map.get(ev.user_id));
      map.set(ev.user_id, setTimeout(() => { map.delete(ev.user_id); renderTyping(); }, 4500));
      if (!S.users.has(ev.user_id)) {
        api('GET', `/api/users/${ev.user_id}`).then((r) => { S.users.set(r.user.id, r.user); renderTyping(); }).catch(() => {});
      }
      renderTyping();
      break;
    }
    case 'folders.update':
      setFolders(ev.folders);
      break;
    case 'bot.answer':
      toast(ev.text, ev.alert ? 6000 : 3000);
      break;
    case EVENTS.PRESENCE: {
      S.users.set(ev.user.id, ev.user);
      for (const c of S.chats.values()) if (c.peer?.id === ev.user.id) c.peer = ev.user;
      for (const list of S.members.values()) for (const mem of list) if (mem.user.id === ev.user.id) mem.user = ev.user;
      if (S.active) renderAll();
      if (S.active && activeChat()?.peer?.id === ev.user.id) renderHeader();
      fire('chats');
      break;
    }
    case EVENTS.ME_UPDATE:
      S.me = ev.user;
      S.users.set(ev.user.id, ev.user);
      fire('me');
      fire('chats');
      break;
    case EVENTS.SESSION_REVOKED:
      loggedOut();
      break;
    default:
  }
}
on('ws', onWs);

document.addEventListener('visibilitychange', () => {
  fire('visibility');
  if (document.visibilityState === 'visible' && S.me && S.net === 'online') markRead();
});

// ---------------------------------------------------------------- session lifecycle
function handleHash() {
  const m = /^#\/(chat|join)\/([\w-]+)/.exec(location.hash);
  if (!m || !S.me) return;
  if (m[1] === 'chat') {
    const id = Number(m[2]);
    if (S.chats.has(id) && S.active !== id) openChat(id);
  } else {
    history.replaceState(null, '', '#/');
    openJoin(m[2]);
  }
}
window.addEventListener('hashchange', handleHash);

let paintedFor = null;

/** Start from the last snapshot: the chat list shows at once, the network only refreshes it. */
async function paintFromSnapshot() {
  const snap = await Promise.race([snapGet('boot'), new Promise((r) => setTimeout(r, 400))]);
  if (!snap?.user || !Array.isArray(snap.chats) || S.me) return;
  S.me = snap.user;
  S.users.set(snap.user.id, snap.user);
  buildApp();
  for (const c of snap.chats) { S.chats.set(c.id, c); if (c.peer) S.users.set(c.peer.id, c.peer); }
  paintedFor = snap.user.id;
  fire('chats');
  syncView();
}

async function enter(user) {
  // Android app: tell the native side which server to keep a background connection to (also right after a sign-in)
  try { window.SuhbatNative?.configure?.(location.origin); } catch { /* not the Android app */ }
  window.__openChat = (id) => fire('open-chat', Number(id));
  window.__nativeBack = handleBack;
  S.me = user;
  S.users.set(user.id, user);
  outbox.clearForOtherUsers();
  if (paintedFor !== user.id) buildApp();
  paintedFor = null;
  try { setConfig(await api('GET', '/api/config')); } catch { /* defaults */ }
  try {
    await loadChats();
  } catch { /* offline start: list stays empty until reconnect */ }
  connect();
  initUpdates();
  restorePendingUploads();
  handleHash();
  syncView();
  askForEmail();
}

/** An e-mail address is mandatory: accounts created before that are asked to attach one (once per device; Settings keeps the field). */
async function askForEmail() {
  try {
    if (S.me.email || S.me.is_bot) return;
    if (localStorage.getItem('suhbat.mailAsk')) return; // asked once on this device: never nag again
    const p = await api('GET', '/api/auth/providers');
    if (!p.email) return;
    const box = h('div', { class: 'st-email' });
    const m = modal({ title: t('email.required_title'), body: [h('p', { class: 'muted' }, t('email.required_text')), box] });
    drawEmail(box, () => { if (S.me.email) m.close(); });
    localStorage.setItem('suhbat.mailAsk', String(Date.now()));
  } catch { /* offline or storage blocked: ask again next time */ }
}

function loggedOut() {
  clearMediaCache().catch(() => {});
  snapClear();
  paintedFor = null;
  disconnect();
  S.me = null;
  S.chats.clear();
  S.msgs.clear();
  S.members.clear();
  S.active = null;
  showLogin(root, { onLoggedIn: enter });
}
on('unauthorized', () => { if (S.me) loggedOut(); });
on('logged-out', loggedOut);
on('logged-out-request', async () => {
  try { await api('POST', '/api/auth/logout'); } catch { /* already gone */ }
  try { window.SuhbatNative?.stopBackground?.(); } catch { /* not the Android app */ }
  loggedOut();
});

on('relang', () => {
  setLang(S.prefs.lang);
  const keepActive = S.active;
  if (S.me) {
    S.active = null;
    buildApp();
    fire('chats');
    if (keepActive) openChat(keepActive);
  } else {
    showLogin(root, { onLoggedIn: enter });
  }
});

on('me', () => {
  if (S.me) S.users.set(S.me.id, S.me);
});

// the app lock covers everything from the first moment
showLock();
document.addEventListener('suhbat:logout-local', () => fire('logged-out-request'));

(async function boot() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    // a tapped notification asks the open app to show that chat
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'open-chat' && Number.isInteger(e.data.chat_id)) fire('open-chat', e.data.chat_id);
    });
  }
  try {
    await paintFromSnapshot().catch(() => {});
    const r = await api('GET', '/api/me');
    await enter(r.user);
    syncPush();
    initEdgeSwipe();
    // Android app: tell the native side which server to keep a background connection to
    try { window.SuhbatNative?.configure?.(location.origin); } catch { /* not the Android app */ }
    window.__openChat = (id) => fire('open-chat', Number(id));
    window.__nativeBack = handleBack;
    window.suhbatShell?.onOpenChat?.((id) => fire('open-chat', Number(id)));
    // desktop app: system notifications are on by default (it keeps running in the tray)
    try {
      if (navigator.userAgent.includes('SuhbatShell/desktop') && !localStorage.getItem('suhbat.deskNotif')) {
        localStorage.setItem('suhbat.deskNotif', '1');
        S.prefs.desktop = true;
        savePrefs();
      }
    } catch { /* storage blocked */ }
    const uname = new URLSearchParams(location.search).get('u');
    if (uname && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(uname)) {
      try {
        const found = (await api('GET', `/api/users/search?q=${encodeURIComponent(uname)}`)).users.find((x) => (x.username || '').toLowerCase() === uname.toLowerCase());
        if (found && found.id !== S.me.id) {
          const c = (await api('POST', '/api/chats/direct', { user_id: found.id })).chat;
          S.chats.set(c.id, c);
          fire('chats');
          fire('open-chat', c.id);
        }
      } catch { /* not found */ }
      history.replaceState(null, '', '/');
    }
    const wanted = Number(new URLSearchParams(location.search).get('chat'));
    if (Number.isInteger(wanted) && wanted > 0 && S.chats.has(wanted)) fire('open-chat', wanted);
  } catch (e) {
    if (e.status === 0 && S.me) {
      // started from the snapshot while offline: keep trying until the server answers
      const again = async () => {
        try { await enter((await api('GET', '/api/me')).user); } catch (e2) { if (e2.status === 0) setTimeout(again, 5000); else loggedOut(); }
      };
      setTimeout(again, 3000);
      return;
    }
    if (S.me) { S.me = null; S.chats.clear(); snapClear(); }
    showLogin(root, { onLoggedIn: enter });
    if (e.status === 0) toast(t('net.offline'));
  }
})();

// ---------------------------------------------------------------- keyboard shortcuts (desktop)
document.addEventListener('keydown', (e) => {
  if (!S.me) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (S.active && appEl.dataset.view === 'chat' && matchMedia('(max-width: 600px)').matches) closeChat();
    fire('focus-search');
  } else if (mod && (e.key === '/' || e.key === '?')) {
    e.preventDefault();
    const rows = [['Ctrl + K', 'keys.search'], ['Ctrl + ,', 'keys.settings'], ['Ctrl + I', 'keys.info'], ['Alt + ↑ / ↓', 'keys.switch'], ['Esc', 'keys.close'], ['Enter', 'keys.send'], ['Shift + Enter', 'keys.newline'], ['Ctrl + /', 'keys.help']];
    modal({ title: t('keys.title'), body: h('div', { class: 'keys-list' }, rows.map(([k2, l]) => h('div', { class: 'prop-row' }, h('kbd', null, k2), h('span', null, t(l))))) });
  } else if (mod && e.key === ',') {
    e.preventDefault();
    import('./dialogs.js').then((d) => d.openSettings());
  } else if (mod && e.key.toLowerCase() === 'i' && S.active) {
    e.preventDefault();
    import('./chat.js').then((c) => c.toggleInfo());
  } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
    e.preventDefault();
    const ids = [...S.chats.values()]
      .sort((a, b) => (b.last_message?.created_at ?? b.last_message_at) - (a.last_message?.created_at ?? a.last_message_at))
      .map((c) => c.id);
    if (!ids.length) return;
    const i = ids.indexOf(S.active);
    const next = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i === -1 ? 0 : i - 1);
    openChat(ids[next]);
  } else if (e.key === 'Escape' && S.active && !document.querySelector('.overlay, .menu, .call-overlay')) {
    if (document.activeElement?.tagName === 'TEXTAREA' && document.activeElement.value) return;
    closeChat();
  }
});

// ---------------------------------------------------------------- viewport: follow the on-screen keyboard
const vv = window.visualViewport;
function fitViewport() {
  const hgt = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(hgt)}px`);
  if (vv && vv.offsetTop) window.scrollTo(0, 0);
}
vv?.addEventListener('resize', fitViewport);
vv?.addEventListener('scroll', fitViewport);
window.addEventListener('orientationchange', () => setTimeout(fitViewport, 200));
fitViewport();

// ---------------------------------------------------------------- touch: swipe from the left edge goes back
let touch = null;
document.addEventListener('touchstart', (e) => {
  const p = e.touches[0];
  touch = e.touches.length === 1 && p.clientX < 28 ? { x: p.clientX, y: p.clientY } : null;
}, { passive: true });
document.addEventListener('touchend', (e) => {
  if (!touch || !S.active) return;
  const p = e.changedTouches[0];
  if (p.clientX - touch.x > 80 && Math.abs(p.clientY - touch.y) < 60 && matchMedia('(max-width: 600px)').matches) closeChat();
  touch = null;
}, { passive: true });
