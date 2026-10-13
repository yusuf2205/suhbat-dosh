import { t } from './i18n.js';
// Shared client state + a tiny pub/sub so modules don't import each other circularly.
export const S = {
  me: null,
  chats: new Map(),        // chatId -> chat (server shape)
  active: null,            // active chatId
  msgs: new Map(),         // chatId -> { list: [], hasMore: true, detached: false, loading: false }
  members: new Map(),      // chatId -> [{ user, role, can_send, banned }]
  users: new Map(),        // userId -> public user (cache for sender names)
  typing: new Map(),       // chatId -> Map(userId -> timeoutId)
  build: null,             // build id of the client currently running
  net: 'connecting',       // connecting | online | offline
  view: 'chats',           // chats | contacts | archive
  filter: 'all',
  folders: [],
  query: '',
  prefs: load('suhbat.prefs', { lang: navigator.language?.startsWith('uz') ? 'uz' : 'ru', theme: 'auto', sound: true, desktop: false, textScale: 1, info: false }),
};

function load(key, fallback) {
  try {
    return { ...fallback, ...JSON.parse(localStorage.getItem(key) || '{}') };
  } catch {
    return fallback;
  }
}

export function savePrefs() {
  try { localStorage.setItem('suhbat.prefs', JSON.stringify(S.prefs)); } catch { /* private mode */ }
}

const listeners = new Map();
export function on(evt, fn) {
  if (!listeners.has(evt)) listeners.set(evt, new Set());
  listeners.get(evt).add(fn);
}
export function fire(evt, data) {
  for (const fn of listeners.get(evt) || []) {
    try { fn(data); } catch (e) { console.error(e); }
  }
}

export function bucket(chatId) {
  if (!S.msgs.has(chatId)) S.msgs.set(chatId, { list: [], hasMore: true, detached: false, loading: false });
  return S.msgs.get(chatId);
}

/** Muted forever, or muted until a time that is still in the future. */
export function isMuted(c) {
  if (c.muted_until) return c.muted_until > Date.now();
  return !!c.muted;
}

export function chatTitle(c) {
  if (c.saved) return t('saved.title');
  if (c.secret) return `🔒 ${c.peer?.name ?? '…'}`;
  return c.type === 'direct' ? c.peer?.name ?? '…' : c.title;
}
