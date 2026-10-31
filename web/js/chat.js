import { featureOn } from './features.js';
import { snapGet, snapSet } from './snap.js';
import { canCompress, compressImage } from './imgcompress.js';
import { isVideoNote, recordVideoNote, videoNoteNode } from './videonote.js';
import { canCompressVideo, compressVideo } from './videocompress.js';
import { accessBadge, accessMenu, shareMessageFile } from './drive.js';
import { eventNode, openEventCreate } from './events.js';
import { miniNode, openMiniCreate } from './mini.js';
import { openTaskCreate, openTasks, taskNode } from './tasks.js';
import { dealNode, openDealCreate } from './deals.js';
import { openDigest } from './digest.js';
import { noteNode, openNoteCreate } from './notes.js';
import { firstUrl, linkCard } from './linkcard.js';
import { editImage, scanDocument } from './photoedit.js';
import { attachQuick, openQuickManager } from './quick.js';
import { directRoute, sendFromChat } from './nearby.js';
import { tgOnline, tgSeenLine } from './tgpresence.js';
import { applyAutoTr, autoAvailable, autoDecided, autoOn, foreignLang, langName, setAuto } from './autotr.js';
import { onceNode } from './once.js';
import { currentTopic, topicQuery, renderTopicBar, refreshTopics, topicsOf } from './topics.js';
import { openReaders } from './readers.js';
import { applyChatTheme, openChatTheme } from './chattheme.js';
import { commentsButton } from './comments.js';
import { openReactors, openThread, repliesLabel } from './thread.js';
import { transcriptNode } from './transcript.js';
import { closeLayer, openLayer } from './backnav.js';
import { swipeLeft } from './swipe.js';
import { REACTIONS, LIMITS } from '/shared/contracts.js';
import { h, clear, linkify, formatBytes, formatDuration, uuid, debounce, longPress } from './dom.js';
import { t, errText } from './i18n.js';
import { S, bucket, chatTitle, fire, isMuted, on, savePrefs } from './state.js';
import { api, flushOutbox, outbox, sendTyping } from './net.js';
import {
  avatar, callLabel, confirmDialog, dayKey, fmtDay, fmtLastSeen, fmtTime, modal, popMenu, previewText, toast,
} from './ui.js';
import { openInfo, openChatSearch, openForward } from './dialogs.js';
import { icon } from './icons.js';
import { startCall } from './call.js';
import { openViewer, openMediaPanel } from './viewer.js';
import { makeThumb } from './thumbs.js';
import { voiceNode, encodeWave } from './voice.js';
import { canOpenNative, isOffice, openNative, prefetchNative } from './native.js';
import { fileIcon } from './fileicons.js';
import { ensureMediaPermission, openAppSettings, showMediaProblem } from './mediaaccess.js';
import { aliasOf, shownName, aliasSig, animalAvatar } from './persona.js';
import { animatedEmoji, isSingleEmoji, openStickerPicker, stickerNode } from './stickers.js';
import { acceptSecretChat, isSecret, openBlob, openPayload, sealBlob, sealPayload, secretStatus, showSecretInfo, startSecretChat } from './secret.js';
import { fileBlob } from './downloads.js';
import { syncGroup } from './e2egroup.js';
import { cancel as cancelTask, enqueue as enqueueUpload, onUpload, pause as pauseUpload, restore as restoreUploads, resume as resumeUpload } from './uploads.js';
import { contactNode, initPhoneMenu, locationNode, openContactShare, sendLocation } from './share.js';
import { groupCallOf, groupCallChatId, joinGroupCall } from './gcall.js';
import {
  folderPicker, openPollCreate, openScheduled, pickTime, pollNode, remind, reportMenu, scheduleText, soundMenu, translateMessage, ttlLabel, ttlMenu,
} from './extras.js';

let root; // .main element
let view = null; // refs to the persistent chat DOM
let cfg = { max_upload_bytes: 50 * 1024 * 1024 };
const nodeCache = new Map(); // key -> { el, sig, status }
let replyTo = null;
let editing = null;
let unreadFrom = 0;
const pinIndex = new Map(); // chat id -> which pinned message the bar shows
let openUnread = 0; // unread messages when the chat was opened: shows the "what did I miss" button
let highlightId = null;
let rec = null; // voice recorder state
let lastTyping = 0; // last time a 'typing' ping was sent (reset after sending a message)
let selectMode = false;
const selected = new Set(); // message ids picked in selection mode

export const isWide = () => matchMedia('(min-width: 1280px)').matches;
export function toggleInfo() {
  if (isWide()) fire('info-toggle');
  else openInfo(S.active);
}

export const setConfig = (c) => { cfg = { ...cfg, ...c }; };
export const activeChat = () => S.chats.get(S.active);

export function mount(mainEl) {
  root = mainEl;
  showPlaceholder();
}

function showPlaceholder() {
  view = null;
  clear(root).append(h('div', { class: 'placeholder' },
    h('div', { style: { fontSize: '48px' } }, '💬'), h('h2', null, t('chat.select')), h('p', null, t('chat.select_hint'))));
}

// ---------------------------------------------------------------- open / close
let chatLayer = null;

/** On a computer the cursor is in the message field as soon as a chat is opened, so one can type at once (not on a phone: the keyboard would jump up). */
function focusComposer() {
  try {
    if (!matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    if (document.querySelector('.modal, dialog[open]')) return;   // a window is open: its own field keeps the cursor
    const ta = view?.ta;
    if (ta?.isConnected && !ta.disabled && !ta.readOnly) ta.focus({ preventScroll: true });
  } catch { /* no focus, no harm */ }
}

export async function openChat(id) {
  if (S.active === id && view) { focusComposer(); return; }
  closeRecorder();
  S.active = id;
  const c = S.chats.get(id);
  if (!c) return closeChat();
  try { localStorage.setItem(`suhbat.last.${S.me.id}`, String(id)); } catch { /* storage blocked */ }
  replyTo = null;
  editing = null;
  selectMode = false;
  selected.clear();
  highlightId = null;
  unreadFrom = c.unread > 0 ? c.last_read_id : 0;
  openUnread = c.secret ? 0 : c.unread;
  nodeCache.clear();
  buildView();
  fire('active');
  focusComposer();
  if (!chatLayer) chatLayer = openLayer(() => { chatLayer = null; closeChat(); });
  history.replaceState(history.state, '', `#/chat/${id}`);
  const b = bucket(id);
  if (!b.list.length || b.detached) {
    b.list = b.list.filter((m) => m.pending);
    b.detached = false;
    b.hasMore = true;
    if (!c.secret) {
      const cached = await snapGet(`m:${S.me.id}:${id}`);
      if (cached?.length && S.active === id && !b.list.length) {
        b.list = [...cached];
        renderAll({ scroll: 'unread' });
      }
    }
    await loadLatest(id);
  }
  loadMembers(id);
  if (c.forum) refreshTopics(id, true);
  renderAll({ scroll: 'unread' });
  markRead();
  if (S.active === id) focusComposer();   // the list that was clicked may have taken the focus back while the messages loaded
  if (c.secret?.group) syncGroup(c);
}

/** Another topic of the group: the list of messages starts over for it. */
export async function switchTopic(topicId) {
  const id = S.active;
  const c = S.chats.get(id);
  if (!c?.forum || (S.topic.get(id) || 0) === topicId) return;
  S.topic.set(id, topicId);
  const b = bucket(id);
  b.list = [];
  b.hasMore = true;
  b.detached = false;
  nodeCache.clear();
  replyTo = null;
  editing = null;
  unreadFrom = (topicsOf(id).find((x) => x.id === topicId)?.unread || 0) > 0 ? 0 : 0;
  renderComposer();
  renderHeader();
  renderAll();
  await loadLatest(id);
  renderAll({ scroll: 'bottom' });
  markRead();
}

export function closeChat() {
  closeRecorder();
  if (chatLayer) { const l = chatLayer; chatLayer = null; closeLayer(l); }
  S.active = null;
  try { localStorage.removeItem(`suhbat.last.${S.me?.id}`); } catch { /* storage blocked */ }
  showPlaceholder();
  fire('active');
  if (location.hash.startsWith('#/chat/')) history.replaceState(history.state, '', '#/');
}

async function loadLatest(id) {
  const b = bucket(id);
  b.loading = true;
  try {
    const r = await api('GET', `/api/chats/${id}/messages?limit=${LIMITS.PAGE_SIZE}${topicQuery(id)}`);
    const pending = b.list.filter((m) => m.pending);
    b.list = [...r.messages, ...pending];
    b.hasMore = r.has_more;
    if (!S.chats.get(id)?.secret) snapSet(`m:${S.me.id}:${id}`, r.messages);
  } catch (e) {
    if (e.status !== 0) toast(errText(e.code));
  } finally {
    b.loading = false;
  }
}

async function loadOlder() {
  const id = S.active;
  const b = bucket(id);
  if (b.loading || !b.hasMore) return;
  const first = b.list.find((m) => !m.pending);
  if (!first) return;
  b.loading = true;
  const sc = view.list;
  const prevH = sc.scrollHeight;
  try {
    const r = await api('GET', `/api/chats/${id}/messages?limit=${LIMITS.PAGE_SIZE}&before=${first.id}${topicQuery(id)}`);
    if (S.active !== id) return;
    b.list = [...r.messages, ...b.list];
    b.hasMore = r.has_more;
    renderMessages();
    sc.scrollTop = sc.scrollHeight - prevH;
  } catch { /* offline: try again on next scroll */ } finally {
    b.loading = false;
  }
}

async function loadNewer() {
  const id = S.active;
  const b = bucket(id);
  if (b.loading || !b.detached) return;
  const last = [...b.list].reverse().find((m) => !m.pending);
  if (!last) return;
  b.loading = true;
  try {
    const r = await api('GET', `/api/chats/${id}/messages?limit=${LIMITS.PAGE_SIZE}&after=${last.id}${topicQuery(id)}`);
    if (S.active !== id) return;
    const pending = b.list.filter((m) => m.pending);
    b.list = [...b.list.filter((m) => !m.pending), ...r.messages, ...pending];
    if (!r.has_more) b.detached = false;
    renderMessages();
  } catch { /* ignore */ } finally {
    b.loading = false;
  }
}

export async function jumpToLatest() {
  const id = S.active;
  const b = bucket(id);
  b.detached = false;
  await loadLatest(id);
  renderMessages();
  scrollBottom();
}

export async function jumpTo(chatId, msgId) {
  if (S.active !== chatId) await openChat(chatId);
  const b = bucket(chatId);
  if (!b.list.some((m) => m.id === msgId)) {
    try {
      const r = await api('GET', `/api/chats/${chatId}/messages?limit=${LIMITS.PAGE_SIZE}&before=${msgId + 26}${topicQuery(chatId)}`);
      b.list = r.messages;
      b.hasMore = r.has_more;
      b.detached = true;
    } catch (e) {
      return toast(errText(e.code));
    }
  }
  highlightId = msgId;
  renderMessages();
  const n = nodeCache.get(`m:${msgId}`)?.el;
  n?.scrollIntoView({ block: 'center' });
  setTimeout(() => { highlightId = null; renderMessages(); }, 1800);
}

async function loadMembers(id) {
  try {
    const r = await api('GET', `/api/chats/${id}`);
    S.members.set(id, r.members);
    for (const m of r.members) S.users.set(m.user.id, m.user);
    if (S.active === id) renderMessages();
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------- view skeleton
function buildView() {
  const c = activeChat();
  const ta = h('textarea', {
    rows: 1, placeholder: t('chat.placeholder'), 'aria-label': t('chat.placeholder'), maxLength: LIMITS.TEXT_MAX,
    enterKeyHint: 'send',
  });
  const fileInput = h('input', { type: 'file', multiple: true, class: 'sr', tabIndex: -1, onchange: () => {
    attachFiles(S.active, [...fileInput.files]);
    fileInput.value = '';
  } });
  view = {
    back: h('button', { class: 'icon-btn back', type: 'button', 'aria-label': t('chat.back'), onclick: closeChat }, icon('back', 24)),
    who: h('button', { class: 'who', type: 'button', onclick: toggleInfo, 'aria-label': t('chat.info') }),
    pin: h('button', { class: 'pinbar', type: 'button', hidden: true }),
    topics: h('div', { class: 'topic-bar', role: 'tablist', hidden: true }),
    list: h('div', { class: 'messages', role: 'log', 'aria-live': 'polite', 'aria-label': chatTitle(c) }),
    jump: h('button', { class: 'btn jump', type: 'button', hidden: true, onclick: jumpToLatest }, `↓ ${t('chat.jump_latest')}`),
    dg: h('button', { class: 'digest-pill', type: 'button', hidden: true, onclick: () => { openUnread = 0; renderHeader(); openDigest(S.active); } }, `✨ ${t('digest.title')}`),
    ctx: h('div', { class: 'ctx', hidden: true }),
    composer: h('div', { class: 'composer' }),
    state: h('div', { class: 'cstate', hidden: true }),
    ta, fileInput,
  };
  view.wrap = h('div', { class: 'composer-wrap' }, view.ctx, view.composer, view.state);
  clear(root).append(
    h('div', { class: 'chat-head' }, view.back, view.who,
      (view.trBtn = h('button', { class: 'icon-btn tr-toggle', type: 'button', hidden: true, onclick: toggleTranslate }, icon('globe', 22))),
      h('button', { class: 'icon-btn hide-narrow', type: 'button', 'aria-label': t('chat.search'), onclick: () => openChatSearch(S.active) }, icon('search', 22)),
      h('button', { class: 'icon-btn call-start', type: 'button', 'aria-label': t('chat.call'), onclick: () => (activeChat()?.type === 'group' ? joinGroupCall(S.active, false) : startCall(S.active, false)) }, icon('phone', 22)),
      h('button', { class: 'icon-btn call-start video', type: 'button', 'aria-label': t('chat.video'), onclick: () => (activeChat()?.type === 'group' ? joinGroupCall(S.active, true) : startCall(S.active, true)) }, icon('video', 22)),
      (view.moreBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('chat.more'), 'aria-haspopup': 'menu', onclick: () => chatMoreMenu(view.moreBtn) }, icon('more', 22)))),
    view.pin, view.topics, (view.gbar = h('div', { class: 'gc-bar', hidden: true })), view.dg, (view.trs = h('div', { class: 'tr-suggest', hidden: true })), view.list, view.jump, view.wrap, fileInput,
  );
  view.list.addEventListener('scroll', onScroll, { passive: true });
  const typingPing = () => {
    const n = Date.now();
    if (n - lastTyping >= 3000) { lastTyping = n; sendTyping(S.active); }
  };
  ta.addEventListener('input', () => {
    autoGrow();
    syncComposerButtons();
    if (ta.value && !editing) typingPing();
    saveDraft();
  });
  attachQuick(ta, view.wrap, () => !!activeChat()?.peer?.is_bot);
  ta.addEventListener('paste', (e) => {
    const fl = e.clipboardData?.files;
    if (fl?.length) {
      e.preventDefault();
      attachFiles(S.active, fl);
    }
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !matchMedia('(pointer: coarse)').matches) {
      e.preventDefault();
      sendText();
    } else if (e.key === 'Escape' && (replyTo || editing)) {
      cancelContext();
    } else if (e.key === 'ArrowUp' && !ta.value && !editing) {
      const mine = [...bucket(S.active).list].reverse().find((m) => m.sender_id === S.me.id && !m.pending && !m.failed && m.text);
      if (mine && activeChat().can_post) {
        e.preventDefault();
        editing = mine;
        renderComposer();
        ta.value = mine.text;
        syncComposerButtons();
        view.sendBtn.hidden = false;
        autoGrow();
      }
    }
  });
  try { ta.value = localStorage.getItem(`suhbat.draft.${S.me.id}.${c.id}`) ?? c.draft ?? ''; } catch { ta.value = c.draft || ''; }
  renderHeader();
  renderComposer();
  autoGrow();
}

function throttle(fn, ms) {
  let last = 0;
  return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...a); } };
}

function autoGrow() {
  if (!view) return;
  view.ta.style.height = 'auto';
  // an empty box is one line high whatever the placeholder says
  view.ta.style.height = view.ta.value ? `${Math.min(view.ta.scrollHeight, 160)}px` : '';
}

const pushDraft = debounce((id, text) => {
  api('PATCH', `/api/chats/${id}/me`, { draft: text }).catch(() => {});
}, 800);

function saveDraft() {
  const id = S.active;
  const text = editing ? null : view.ta.value;
  if (text === null) return;
  try { localStorage.setItem(`suhbat.draft.${S.me.id}.${id}`, text); } catch { /* ignore */ }
  const c = S.chats.get(id);
  if (c) { c.draft = text; fire('chats'); }
  pushDraft(id, text);
}

// ---------------------------------------------------------------- header & composer state
/** The globe in the header: read this chat in my language (or not). */
function toggleTranslate() {
  const c = activeChat();
  if (!c) return;
  if (!autoOn(c.id) && !autoAvailable()) { toast(t('atr.unavailable'), 6000); return; }
  setAuto(c.id, !autoOn(c.id));
  nodeCache.clear();
  renderMessages();
  renderHeader();
}

/** Other people write in the other language: offer to read it in mine, once. */
function suggestTranslate(c, list) {
  if (!view?.trs) return;
  const bar = view.trs;
  const lang = !isSecret(c) && !c.saved && !autoDecided(c.id) && !S.prefs.trNo?.[c.id] && autoAvailable() ? foreignLang(list) : '';
  if (!lang) { bar.hidden = true; return; }
  if (!bar.hidden && bar.dataset.chat === String(c.id) && bar.dataset.lang === lang) return;
  bar.dataset.chat = String(c.id);
  bar.dataset.lang = lang;
  clear(bar).append(h('span', { class: 'tr-suggest-text' }, `\u{1F310} ${t('atr.suggest', { lang: langName(lang) })}`),
    h('button', { class: 'btn small', type: 'button', onclick: () => { setAuto(c.id, true); bar.hidden = true; nodeCache.clear(); renderMessages(); renderHeader(); } }, t('atr.turn_on')),
    h('button', { class: 'btn link', type: 'button', onclick: () => { S.prefs.trNo = { ...(S.prefs.trNo || {}), [c.id]: true }; savePrefs(); bar.hidden = true; } }, t('atr.not_now')));
  bar.hidden = false;
}

export function renderHeader() {
  const c = activeChat();
  if (!c || !view) return;
  const peer = c.peer;
  const ent = c.type === 'direct' ? peer : { id: c.id, name: c.title, avatar: c.avatar, online: tgOnline(c) };
  if (view.trBtn) {
    const can = !isSecret(c) && !c.saved && autoAvailable();
    view.trBtn.hidden = !can;
    view.trBtn.classList.toggle('on', can && autoOn(c.id));
    view.trBtn.setAttribute('aria-pressed', String(can && autoOn(c.id)));
    view.trBtn.setAttribute('aria-label', `${t('atr.title')}: ${autoOn(c.id) ? t('st.on') : t('st.off')}`);
    view.trBtn.title = view.trBtn.getAttribute('aria-label');
  }
  clear(view.who).append(
    avatar(ent, 'sm'),
    h('span', { class: 'grow' }, h('b', { class: 'ellipsis' }, chatTitle(c), c.ttl ? h('span', { class: 'ttl-chip', title: t('ttl.title') }, ` \u23F1 ${ttlLabel(c.ttl)}`) : null), h('span', { class: `sub ${subtitleLive(c) ? 'live' : ''}` }, subtitle(c))),
  );
  // pinned bar
  const pins = c.pins?.length ? c.pins : (c.pinned ? [c.pinned] : []);
  if (pins.length) {
    const idx = Math.min(pinIndex.get(c.id) ?? pins.length - 1, pins.length - 1);
    const cur = pins[idx];
    view.pin.hidden = false;
    clear(view.pin).append(h('span', null, '📌'), h('span', { class: 'grow ellipsis' }, h('b', null, `${t('chat.pinned')}${pins.length > 1 ? ` ${idx + 1}/${pins.length}` : ''}: `), previewText(cur)));
    view.pin.onclick = () => { pinIndex.set(c.id, (idx - 1 + pins.length) % pins.length); jumpTo(c.id, cur.id); renderHeader(); };
  } else {
    view.pin.hidden = true;
  }
  applyChatTheme(view.list, c.theme);
  if (view.topics) renderTopicBar(view.topics, c, (tp) => switchTopic(tp));
  renderGroupCallBar(c);
  if (view.dg) view.dg.hidden = openUnread < 8;
  renderComposer();
}

/** "A group call is in progress" bar under the header, with a join button. */
export function renderGroupCallBar(c = activeChat()) {
  if (!view?.gbar || !c) return;
  const room = c.type === 'group' ? groupCallOf(c.id) : null;
  view.gbar.hidden = !room;
  if (!room) return;
  const mine = groupCallChatId() === c.id;
  clear(view.gbar).append(
    icon('phone', 18),
    h('span', { class: 'grow ellipsis' }, h('b', null, room.room ? t('room.title') : t('gcall.in_progress')), ` · ${room.participants.map((p) => p.name).slice(0, 3).join(', ')}${room.participants.length > 3 ? ` +${room.participants.length - 3}` : ''}`),
    h('button', { class: 'btn', type: 'button', onclick: () => joinGroupCall(c.id, !!room.video, { room: !!room.room }) }, mine ? t('gcall.open') : t('gcall.join')));
}

function typingUsers(c) {
  return [...(S.typing.get(c.id)?.keys() ?? [])];
}
/** What the others are doing now: the most telling activity wins (a voice message over typing). */
function typingAction(c) {
  const acts = [...(S.typingAct.get(c.id)?.values() ?? [])];
  return ['voice', 'video', 'file'].find((a) => acts.includes(a)) || 'typing';
}
const ACT_TEXT = { typing: 'chat.typing', voice: 'chat.rec_voice', video: 'chat.rec_video', file: 'chat.sending_file' };
function subtitleLive(c) {
  return typingUsers(c).length > 0 || (c.type === 'direct' && c.peer?.online);
}
function subtitle(c) {
  const typers = typingUsers(c);
  if (typers.length) {
    const act = typingAction(c);
    if (c.type === 'direct') return t(ACT_TEXT[act]);
    const names = typers.map((id) => shownName(c, id, S.users.get(id)?.name)).filter(Boolean);
    return `${names.join(', ')} ${typers.length > 1 && act === 'typing' ? t('chat.typing_many') : t(ACT_TEXT[act])}`;
  }
  if (c.type === 'direct' && !c.saved) {
    if (c.peer?.is_bot) return t('bots.label');
    const pres = c.peer?.presence === 'busy' ? ` · ${t('pres.busy')}` : c.peer?.presence === 'away' ? ` · ${t('pres.away')}` : '';
    if (c.peer?.online) return t('chat.online') + pres;
    return (c.peer?.last_seen ? fmtLastSeen(c.peer.last_seen) : t('chat.last_seen_hidden')) + pres;
  }
  if (c.saved) return '';
  if (c.imported) return tgSeenLine(c) || (t(c.imported === 'tgbridge' ? 'br.subtitle' : 'imp.subtitle') + (c.tg?.username ? ` · @${c.tg.username}` : ''));
  return `${c.members_count} ${c.type === 'channel' ? t('chat.subscribers') : t('chat.members')}`;
}

export function renderTyping() {
  if (!S.active || !view) return;
  const near = isNearBottom();
  renderHeader();
  renderMessages();
  if (near) scrollBottom();
}

function composerBlockReason(c) {
  if (c.secret) { const r = secretReason(c); if (r) return r; }
  if (c.can_post) return null;
  if (c.blocked_by_me) return 'blocked_by_me';
  if (c.blocked_me) return 'blocked_me';
  if (c.imported === 'tgbridge') return 'bridge_ro';
  if (c.type === 'channel') return 'readonly';
  return 'restricted';
}

const secretStatuses = new Map();
/** Why a secret chat cannot be written to right now (null = it can). The key state is read from this device asynchronously. */
function secretReason(c) {
  const key = `${c.id}:${c.secret.state}:${c.secret.epoch || 0}`;
  const st = secretStatuses.get(key);
  if (!st) {
    secretStatus(c).then((s) => {
      secretStatuses.set(key, s);
      if (view && S.active === c.id) { view.ckey = ''; renderComposer(); renderMessages(); }
    });
    return 'secret_checking';
  }
  if (c.secret.group) return { 'pending-peer': 'secret_gpending', 'no-key': 'secret_gwait', ready: null }[st] ?? null;
  return { 'pending-peer': 'secret_pending', invited: 'secret_invited', 'no-key': 'secret_nokey', ready: null }[st] ?? null;
}

function renderComposer() {
  if (!view) return;
  const c = activeChat();
  const reason = composerBlockReason(c);
  // skip rebuilds that would not change anything (a rebuild would drop focus while the user types)
  const key = `${reason}|${editing?.id}|${replyTo?.id}|${c.peer?.id}|${c.peer?.commands?.length ?? ''}`;
  if (key === view.ckey) return;
  view.ckey = key;
  const hadFocus = document.activeElement === view.ta;
  queueMicrotask(() => { if (hadFocus && view?.ta.isConnected) view.ta.focus(); });
  view.composer.hidden = !!reason;
  view.state.hidden = !reason;
  clear(view.state);
  if (reason) {
    view.state.append(t(`chat.${reason}`));
    if (reason === 'secret_invited') {
      view.state.append(' ', h('button', { class: 'btn', type: 'button', onclick: async () => {
        const r = await acceptSecretChat(c);
        if (r) { secretStatuses.clear(); view.ckey = ''; renderComposer(); renderMessages(); }
      } }, t('secret.accept')));
    }
    if (reason === 'blocked_by_me') {
      view.state.append(' ', h('button', { class: 'btn link', type: 'button', onclick: async () => {
        await api('DELETE', `/api/blocks/${c.peer.id}`).catch(() => {});
      } }, t('chat.unblock')));
    }
  }
  // reply / edit context bar
  view.ctx.hidden = !(replyTo || editing);
  clear(view.ctx);
  if (editing || replyTo) {
    const m = editing || replyTo;
    view.ctx.append(
      h('span', { class: 'grow ellipsis' }, h('b', null, editing ? t('chat.editing') : `${t('chat.reply_to')} · ${senderName(m)}`), ' ', previewText(m)),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('chat.cancel'), onclick: cancelContext }, '✕'),
    );
  }
  if (rec) { updateRecUi(); return; } // never rebuild the composer under a finger that is recording
  view.ta.placeholder = c.saved ? t('saved.hint') : t('chat.write');
  view.recbar = h('div', { class: 'recbar' },
    h('button', { class: 'icon-btn rec-trash', type: 'button', 'aria-label': t('voice.delete'), onclick: () => closeRecorder() }, icon('trash', 22)),
    h('span', { class: 'rec-dot' }), h('span', { class: 'rec-time' }, '0:00'),
    h('div', { class: 'rec-wave' }),
    h('span', { class: 'rec-hint' }, `‹ ${t('voice.slide_cancel')}`));
  view.actionBtn = h('button', { class: 'send-btn', type: 'button' }, icon('mic', 22));
  view.sendBtn = view.actionBtn;
  wireActionButton(view.actionBtn);
  clear(view.composer).append(
    h('button', { class: 'icon-btn attach', type: 'button', 'aria-label': t('chat.attach'), onclick: (e) => popMenu(e.currentTarget, [
      { label: t('attach.file'), onClick: () => view.fileInput.click() },
      ...(directRoute(activeChat()) ? [{ label: directRoute(activeChat()) === 'nearby' ? t('nb.direct_menu_near', { name: activeChat().peer.name }) : t('nb.direct_menu'), onClick: () => sendFromChat(activeChat(), attachFiles) }] : []),
      { label: t('attach.location'), onClick: () => sendLocation(S.active, (m) => upsert(S.active, m)) },
      { label: t('quick.title'), onClick: () => openQuickManager({ onPick: (text) => insertAtCursor(text) }) },
      { label: t('sc.title'), onClick: async () => { const chatId = S.active; const f = await scanDocument(); if (f) attachFiles(chatId, [f]); } },
      { label: t('attach.contact'), onClick: () => openContactShare(S.active, (m) => upsert(S.active, m)) },
      { label: t('stk.title'), onClick: () => openStickerPicker(S.active, (m) => upsert(S.active, m), (txt) => insertAtCursor(txt)) },
      { label: t('poll.new'), onClick: () => openPollCreate(S.active) },
      { label: t('ev.new'), onClick: () => openEventCreate(S.active) },
      { label: t('mini.new'), onClick: () => openMiniCreate(S.active) },
      ...(featureOn('tasks') ? [{ label: t('task.new'), onClick: () => openTaskCreate(S.active) }] : []),
      ...(featureOn('deals') ? [{ label: t('deal.new'), onClick: () => openDealCreate(S.active) }] : []),
      { label: t('note.new'), onClick: () => openNoteCreate(S.active) },
      { label: t('vnote.title'), onClick: async () => {
        const chatId = S.active;
        let ping = 0;
        const r = await recordVideoNote({ onRecording: (on) => {   // the other side sees "recording a video…" while the circle is recorded
          clearInterval(ping);
          if (on) { sendTyping(chatId, 'video'); ping = setInterval(() => sendTyping(chatId, 'video'), 2500); } else sendTyping(chatId, 'stop');
        } });
        if (r) uploadFile(chatId, r.blob, `circle.${r.ext}`, { duration: r.duration });
      } },
    ].filter((it, i) => !(isSecret(c) && i > 0))) }, icon('plus', 22)),
    h('div', { class: 'field-wrap' },
      view.ta,
      (view.schedBtn = h('button', { class: 'icon-btn', type: 'button', hidden: true, 'aria-label': t('when.schedule'), onclick: (e) => scheduleFromComposer(e.currentTarget) }, icon('clock', 22))),
      c.peer?.is_bot ? h('button', { class: 'icon-btn bot-cmd', type: 'button', 'aria-label': t('bots.commands_btn'), onclick: (e) => botMenu(e.currentTarget, c) }, '/') : null,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('chat.emoji'), onclick: (e) => emojiPicker(e.currentTarget) }, icon('smile', 22))),
    view.recbar,
    view.actionBtn,
  );
  syncComposerButtons();
}

/** What the round button does right now: send the text, send the recording, or start recording. */
function actionMode() {
  if (rec?.locked) return 'sendrec';
  if (view?.ta.value.trim().length > 0 || editing) return 'send';
  return 'mic';
}

function syncComposerButtons() {
  if (!view?.actionBtn) return;
  const mode = actionMode();
  const b = view.actionBtn;
  if (b.dataset.mode !== mode) {
    b.dataset.mode = mode;
    b.replaceChildren(icon(mode === 'mic' ? 'mic' : 'send', 22));
  }
  b.classList.toggle('idle', mode === 'mic');
  if (view.schedBtn) view.schedBtn.hidden = !(mode === 'send' && !editing);
  b.setAttribute('aria-label', mode === 'mic' ? t('chat.voice') : editing ? t('settings.save') : t('chat.send'));
}

let holdState = null; // the press that started a recording

function wireActionButton(b) {
  // long press (or right click) on the plane: send without sound / at a chosen time
  let pressTimer = 0;
  let menuShown = false;
  const showSendMenu = () => {
    if (actionMode() !== 'send' || editing) return;
    menuShown = true;
    popMenu(b, [
      { label: t('send.silent'), onClick: () => sendText({ silent: true }) },
      ...(activeChat()?.type !== 'channel' && !activeChat()?.saved && !isSecret(activeChat()) ? [{ label: t('send.urgent'), onClick: () => sendText({ urgent: true }) }] : []),
      { label: t('when.schedule'), onClick: () => scheduleFromComposer(b) },
      { label: t('when.schedule_silent'), onClick: () => scheduleFromComposer(b, { silent: true }) },
    ]);
  };
  b.addEventListener('contextmenu', (e) => { e.preventDefault(); showSendMenu(); });
  b.addEventListener('pointerdown', () => { clearTimeout(pressTimer); menuShown = false; pressTimer = setTimeout(showSendMenu, 550); });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, () => clearTimeout(pressTimer));
  b.addEventListener('click', (e) => {
    const mode = actionMode();
    if (menuShown) { menuShown = false; e.preventDefault(); return; }
    if (mode === 'send') sendText();
    else if (mode === 'sendrec') finishRecording(true);
    else e.preventDefault();
  });
  b.addEventListener('pointerdown', (e) => {
    if (actionMode() !== 'mic' || e.button > 0) return;
    e.preventDefault();
    try { b.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    holdState = { x: e.clientX, t: Date.now(), up: false };
    startRecording(holdState);
  });
  b.addEventListener('pointermove', (e) => {
    if (!holdState || !rec?.hold) return;
    rec.cancelling = e.clientX - holdState.x < -90;
    view?.composer.classList.toggle('cancelling', rec.cancelling);
  });
  const up = () => {
    const hs = holdState;
    holdState = null;
    if (!hs) return;
    hs.up = true;
    if (!rec || !rec.hold) return; // recording not started yet (permission prompt): it will lock itself
    if (rec.cancelling) closeRecorder();
    else if (Date.now() - hs.t > 450) finishRecording(true);   // held: release sends, like Telegram
    else { rec.hold = false; rec.locked = true; updateRecUi(); } // quick tap: stays on, tap the plane to send
  };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
}

function cancelContext() {
  if (editing) view.ta.value = localStorage.getItem(`suhbat.draft.${S.me.id}.${S.active}`) ?? '';
  replyTo = null;
  editing = null;
  renderComposer();
  autoGrow();
  view.ta.focus();
}

// ---------------------------------------------------------------- sending
async function sendText({ silent = false, urgent = false } = {}) {
  const c = activeChat();
  const text = view.ta.value.trim();
  if (!text || !c?.can_post) return;
  if (editing) {
    const m = editing;
    editing = null;
    try {
      const r = await api('PATCH', `/api/messages/${m.id}`, { text });
      upsert(c.id, r.message);
    } catch (e) { toast(errText(e.code)); }
    view.ta.value = localStorage.getItem(`suhbat.draft.${S.me.id}.${c.id}`) ?? '';
    renderComposer();
    autoGrow();
    return;
  }
  lastTyping = 0;
  const secret = isSecret(c);
  const warn = secret ? '' : sendWarning(c, text);
  if (warn && !(await confirmDialog(warn, { okLabel: t('guard.send_anyway') }))) return;
  let envelope = null;
  if (secret) {
    try { envelope = await sealPayload(c, { t: text }); } catch { toast(t('secret.cannot_send')); return; }
  }
  const clientId = uuid();
  const delay = secret ? 0 : Math.max(0, Math.min(30, Number(S.prefs.sendDelay) || 0));
  const hold = delay ? Date.now() + delay * 1000 : undefined;
  const local = {
    id: `c:${clientId}`, client_id: clientId, chat_id: c.id, sender_id: S.me.id, kind: secret ? 'secret' : 'text', text: envelope ?? text, plain: secret ? text : undefined, pending: true, hold,
    reply_to: replyTo ? { id: replyTo.id, text: previewText(replyTo).slice(0, 120), kind: replyTo.kind, sender_id: replyTo.sender_id, sender_name: senderName(replyTo) } : null,
    reactions: {}, file: null, created_at: Date.now(), ...(c.forum && currentTopic(c.id) ? { topic_id: currentTopic(c.id) } : {}),
  };
  outbox.add({ ...(c.forum ? { topic: currentTopic(c.id) || 0 } : {}), chat_id: c.id, text: envelope ?? text, kind: secret ? 'secret' : undefined, client_id: clientId, reply_to: replyTo?.id ?? null, silent: silent || undefined, urgent: urgent || undefined, hold });
  bucket(c.id).list.push(local);
  c.last_message = local;
  c.last_message_at = local.created_at;
  c.draft = '';
  replyTo = null;
  view.ta.value = '';
  try { localStorage.removeItem(`suhbat.draft.${S.me.id}.${c.id}`); } catch { /* ignore */ }
  pushDraft(c.id, '');
  renderComposer();
  autoGrow();
  fire('chats');
  renderMessages();
  scrollBottom();
  if (S.net === 'online') flushOutbox();
  else fire('outbox');
}

const ATTACH_RE = /(во\s?вложени|вложени[ея]|прикрепил|прикрепляю|прикреплён|прикреплен|прилагаю|attached|attachment|ilovada|ilova qildim|biriktirdim|biriktirilgan)/i;

/** Before a message goes out: a promised attachment that is not there, or words for somebody who is not in this chat. */
function sendWarning(c, text) {
  if (ATTACH_RE.test(text)) return t('guard.attachment');
  if (c.type === 'direct' && !c.saved && c.peer) {
    const first = (n) => String(n || '').trim().split(/\s+/)[0].toLowerCase();
    const m = /^\s*(\p{Lu}[\p{L}'\u2019\u02BB-]{2,})\s*[,!:\u2014-]/u.exec(text);
    if (m) {
      const word = m[1].toLowerCase();
      if (word !== first(c.peer.name) && word !== first(S.me.name)
        && [...S.chats.values()].some((x) => x.id !== c.id && x.type === 'direct' && x.peer && first(x.peer.name) === word)) return t('guard.wrong_chat', { name: m[1], chat: c.peer.name });
    }
  }
  return '';
}

/** The message is still held back: take it out of the queue and put the text back into the field. */
function undoSend(m) {
  if (!m.hold || m.hold <= Date.now()) return;
  outbox.remove(m.client_id);
  const c = S.chats.get(m.chat_id);
  const b = bucket(m.chat_id);
  b.list = b.list.filter((x) => x !== m);
  nodeCache.delete(`m:${m.id}`);
  if (c) { c.last_message = b.list[b.list.length - 1] || null; }
  if (view && S.active === m.chat_id) { view.ta.value = m.plain ?? m.text; autoGrow(); syncComposerButtons(); view.ta.focus(); }
  renderMessages();
  fire('chats');
}

const upLabel = { preparing: 'up.preparing', queued: 'up.queued', paused: 'up.paused', waiting: 'up.waiting', error: 'up.error' };

function upText(u, size) {
  const pct = size ? Math.min(100, Math.round(((u.loaded || 0) / size) * 100)) : 0;
  if (u.state === 'uploading') return `${formatBytes(u.loaded || 0)} / ${formatBytes(size)} · ${pct}%`;
  const base = upLabel[u.state] ? t(upLabel[u.state]) : '';
  return pct > 0 ? `${base} · ${pct}%` : base;
}

/** Keeps the pending message and its card in step with the upload manager. */
function paintUpload(task) {
  for (const bk of S.msgs.values()) {
    const x = bk.list.find((v) => v.client_id === task.id && v.upload);
    if (x) { x.upload.state = task.state; x.upload.loaded = task.loaded || task.sent || 0; x.upload.error = task.error; }
  }
  document.querySelectorAll(`[data-up="${task.id}"]`).forEach((el) => {
    const pct = task.size ? Math.min(100, Math.round(((task.loaded || 0) / task.size) * 100)) : 0;
    const bar = el.querySelector('.up-bar');
    if (bar) bar.style.width = `${pct}%`;
    const txt = el.querySelector('.up-txt');
    if (txt) txt.textContent = upText({ state: task.state, loaded: task.loaded || task.sent || 0 }, task.size);
    el.dataset.state = task.state;
  });
}
onUpload((task, type) => {
  if (type === 'state') {
    paintUpload(task);
    if (S.active) renderMessages(); // the buttons of the card depend on the state
  } else paintUpload(task);
});

function followUpload(task, chatId, thumbP) {
  task.promise.then((r) => {
    upsert(chatId, r.message);
    scrollBottom();
    thumbP?.then((th) => {
      if (!th || !r.message?.file) return;
      api('POST', `/api/files/${r.message.file.id}/thumb?w=${th.w}&h=${th.h}`, undefined, {
        raw: th.blob, headers: { 'content-type': 'application/octet-stream' },
      }).catch(() => {});
    });
  }, (e) => {
    if (e.aborted) return;
    removeMessage(chatId, `c:${task.id}`);
    toast(errText(e.code));
  });
}

function pendingUploadMessage(task) {
  const kind = task.opts.voice ? 'voice' : /^image\//.test(task.mime) ? 'image' : /^video\//.test(task.mime) ? 'video' : /^audio\//.test(task.mime) ? 'audio' : 'file';
  return {
    id: `c:${task.id}`, client_id: task.id, chat_id: task.chatId, sender_id: S.me.id, kind, text: task.opts.caption || '', pending: true,
    upload: { state: task.state, loaded: task.loaded || 0 }, file: { id: `u:${task.id}`, name: task.opts.label || task.name, size: task.size, mime: task.mime, url: '', local: true },
    reactions: {}, reply_to: null, created_at: task.createdAt,
  };
}

/** After a start: interrupted uploads of this account continue where they stopped. */
export async function restorePendingUploads() {
  try {
    for (const task of await restoreUploads(S.me.id)) {
      const bk = bucket(task.chatId);
      if (!bk.list.some((m) => m.client_id === task.id)) bk.list.push(pendingUploadMessage(task));
      followUpload(task, task.chatId, null);
    }
    if (S.active) renderMessages();
  } catch { /* storage unavailable: nothing to restore */ }
}

async function uploadFile(chatId, blob, name, { voice = false, duration = null, caption = '', waveform = null, once = false } = {}) {
  const c = S.chats.get(chatId);
  if (blob.size > cfg.max_upload_bytes) {
    return toast(t('upload.too_large', { mb: Math.round(cfg.max_upload_bytes / 1048576) }));
  }
  const opts = { voice, duration, caption, waveform, replyTo: replyTo?.id ?? null, once: !!once, topic: c.forum ? currentTopic(c.id) || 0 : 0 };
  const secret = isSecret(c);
  let sendBlob = blob;
  let sendName = name;
  if (secret) {
    if (blob.size > 100 * 1048576) return toast(t('secret.too_big'));
    try {
      const sealed = await sealBlob(c, blob);
      opts.caption = await sealPayload(c, { f: { name, mime: blob.type, size: blob.size, iv: sealed.iv, ep: sealed.ep } });
      opts.voice = false;
      opts.label = name;
      sendBlob = sealed.blob;
      sendName = 'secret.bin';
    } catch { return toast(t('secret.cannot_send')); }
  }
  replyTo = null;
  renderComposer();
  const task = enqueueUpload({ userId: S.me.id, chatId: c.id, blob: sendBlob, name: sendName, opts, id: uuid() });
  if (!voice && !secret) {
    // "sending a file…" for the other side while it travels (a voice message has its own sign)
    const live = new Set(['preparing', 'uploading', 'queued', 'waiting']);
    const ping = setInterval(() => { if (!live.has(task.state)) { clearInterval(ping); sendTyping(c.id, 'stop'); } else if (task.state === 'uploading') sendTyping(c.id, 'file'); }, 2500);
  }
  // the message appears at once, with its progress card
  bucket(c.id).list.push(pendingUploadMessage(task));
  if (S.active === c.id) { renderMessages(); scrollBottom(); }
  followUpload(task, c.id, voice || secret || once ? null : makeThumb(blob));
}

function attachFile(file0, onDone) {
  let file = file0;
  const c = activeChat();
  if (!c?.can_post) { toast(t('drop.cannot_post')); onDone?.(); return; }
  if (file.size > cfg.max_upload_bytes) {
    toast(t('upload.too_large', { mb: Math.round(cfg.max_upload_bytes / 1048576) }));
    onDone?.();
    return;
  }
  const isImg = /^image\/(png|jpe?g|gif|webp)$/.test(file.type);
  let url = isImg ? URL.createObjectURL(file) : null;
  const pic = isImg ? h('img', { src: url, alt: '', style: { cursor: 'default' } }) : null;
  const edit = isImg && file.type !== 'image/gif' ? h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
    const out = await editImage(file);
    if (!out) return;
    URL.revokeObjectURL(url);
    file = out;
    url = URL.createObjectURL(out);
    pic.src = url;
  } }, `✎ ${t('pe.edit')}`) : null;
  const cap =h('input', { class: 'input', placeholder: t('chat.placeholder'), maxLength: 1000, 'aria-label': t('chat.placeholder') });
  const squeeze = canCompress(file)
    ? h('input', { type: 'checkbox', checked: S.prefs.compress !== false })
    : null;
  const vsqueeze = canCompressVideo(file) ? h('input', { type: 'checkbox' }) : null;
  const onceBox = (isImg || /^video\//.test(file.type)) && !activeChat()?.secret && activeChat()?.type !== 'channel' ? h('input', { type: 'checkbox' }) : null;
  const abortCompress = new AbortController();
  const m = modal({
    title: file.name,
    onClose: () => { abortCompress.abort(); if (url) URL.revokeObjectURL(url); onDone?.(); },
    body: h('div', null,
      url ? h('div', { class: 'media' }, pic)
        : h('div', { class: 'filecard' }, h('span', { class: 'ficon' }, fileIcon(file.name, file.type, 40)),
          h('span', null, h('b', null, file.name), h('br'), h('span', { class: 'muted' }, formatBytes(file.size)))),
      h('div', { class: 'field', style: { marginTop: '12px' } }, cap),
      squeeze ? h('label', { class: 'row compress-opt' }, squeeze, h('span', null, t('upload.compress', { size: formatBytes(file.size) }))) : null,
      vsqueeze ? h('label', { class: 'row compress-opt' }, vsqueeze, h('span', null, t('upload.compress_video'))) : null,
      onceBox ? h('label', { class: 'row compress-opt' }, onceBox, h('span', null, `\u{1F525} ${t('once.option')}`)) : null,
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } }, edit,
        h('button', { class: 'btn', type: 'button', onclick: async (ev) => {
          const caption = cap.value.trim();
          if (vsqueeze?.checked) {
            // re-encoding runs about as long as the video: show the progress on the button, closing the dialog cancels
            const btn = ev.currentTarget;
            btn.disabled = true;
            const out = await compressVideo(file, (p) => { btn.textContent = `${t('upload.compressing')} ${Math.round(p * 100)}%`; }, abortCompress.signal);
            if (abortCompress.signal.aborted) return;
            m.close();
            uploadFile(c.id, out, out.name, { caption, once: onceBox?.checked });
            return;
          }
          const want = squeeze?.checked;
          if (squeeze && S.prefs.compress !== want) { S.prefs.compress = want; savePrefs(); }
          m.close();
          const out = want ? await compressImage(file) : file;
          uploadFile(c.id, out, out.name, { caption, once: onceBox?.checked });
        } }, t('chat.send')))),
  });
}

/** Files dropped/pasted into a chat: each one gets its own preview, one after another. */
export async function attachFiles(chatId, files) {
  const list = [...files];
  if (!list.length) return;
  if (S.active !== chatId) await openChat(chatId);
  for (const f of list) await new Promise((done) => attachFile(f, done));
}

// ---------------------------------------------------------------- voice recording
const REC_MAX_S = 15 * 60; // auto-sends at the limit
const REC_BARS = 40;

async function startRecording(hs) {
  if (rec) return;
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { holdState = null; return toast(t('voice.unsupported')); }
  let stream;
  if (!(await ensureMediaPermission(false))) { holdState = null; openAppSettings(); return showMediaProblem({ name: 'NotAllowedError' }); }
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    holdState = null;
    return showMediaProblem(e);
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'].find((m) => MediaRecorder.isTypeSupported(m));
  let mr;
  try { mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); } catch (e) { stream.getTracks().forEach((tr) => tr.stop()); holdState = null; return showMediaProblem(e); }
  const chunks = [];
  rec = {
    mr, stream, chunks, started: Date.now(), state: 'recording', duration: 0, chatId: S.active, peaks: [], hold: !hs?.up, locked: !!hs?.up, cancelling: false,
  };
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  mr.onstop = async () => {
    stream.getTracks().forEach((tr) => tr.stop());
    const r = rec;
    if (!r || r.mr !== mr || r.state === 'discard') return;
    const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
    const heard = r.duration;
    const duration = Math.round(heard);   // the server keeps whole seconds
    const wave = encodeWave(r.peaks);
    const chatId = r.chatId;
    closeRecorder(false);
    if (heard < 0.7) return; // an accidental touch is not a message
    if (blob.size < 500) { showMediaProblem({ name: 'EmptyRecording', message: `${blob.size} bytes in ${Math.round(duration)} s` }); return; } // the microphone gave no sound at all
    const ext = blob.type.includes('mp4') ? 'm4a' : blob.type.includes('ogg') ? 'ogg' : 'webm';
    await uploadFile(chatId, blob, `voice.${ext}`, { voice: true, duration, waveform: wave });
  };
  // live loudness for the waveform
  try {
    if (/iPhone|iPad|iPod/.test(navigator.userAgent)) throw new Error('no audio graph next to the recorder on iOS');
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const an = ac.createAnalyser();
    an.fftSize = 512;
    ac.createMediaStreamSource(stream).connect(an);
    rec.ac = ac;
    rec.analyser = an;
    rec.buf = new Uint8Array(an.fftSize);
  } catch { /* the waveform is optional */ }
  try { mr.start(250); } catch (e) { stream.getTracks().forEach((tr) => tr.stop()); rec = null; holdState = null; return showMediaProblem(e); }
  rec.timer = setInterval(() => {
    if (!rec || rec.mr !== mr) return;
    rec.duration = (Date.now() - rec.started) / 1000;
    if (Date.now() - (rec.pinged || 0) > 2500) { rec.pinged = Date.now(); sendTyping(rec.chatId, 'voice'); }
    if (rec.analyser) {
      rec.analyser.getByteTimeDomainData(rec.buf);
      let peak = 0;
      for (const v of rec.buf) peak = Math.max(peak, Math.abs(v - 128));
      rec.peaks.push(Math.min(1, peak / 90));
    }
    updateRecBar();
    if (rec.duration >= REC_MAX_S) finishRecording(true);
  }, 80);
  updateRecUi();
}

function updateRecUi() {
  if (!view?.composer) return;
  view.composer.classList.toggle('recording', !!rec);
  view.composer.classList.toggle('locked', !!rec?.locked);
  view.composer.classList.toggle('cancelling', !!rec?.cancelling);
  syncComposerButtons();
  if (rec) {
    const w = view.recbar?.querySelector('.rec-wave');
    if (w && !w.firstChild) for (let i = 0; i < REC_BARS; i++) w.append(h('i'));
    updateRecBar();
  }
}

function updateRecBar() {
  if (!view?.recbar || !rec) return;
  const time = view.recbar.querySelector('.rec-time');
  if (time) time.textContent = formatDuration(rec.duration);
  const bars = view.recbar.querySelectorAll('.rec-wave i');
  const tail = rec.peaks.slice(-bars.length);
  const now = Date.now();
  bars.forEach((el, i) => {
    // no measured loudness (an iPhone records without an audio graph): a lively wave, only for the eyes, never stored
    const v = rec.analyser ? tail[i - (bars.length - tail.length)] : 0.18 + 0.5 * Math.abs(Math.sin(now / 170 + i * 0.55)) * (0.65 + 0.35 * Math.sin(now / 470 + i * 0.3));
    el.style.height = `${Math.round(4 + (v ?? 0) * 26)}px`;
  });
}

/** Stop recording and (when send is true) deliver it. */
function finishRecording(send) {
  if (!rec) return;
  rec.duration = (Date.now() - rec.started) / 1000;
  clearInterval(rec.timer);
  if (!send) { closeRecorder(); return; }
  try { rec.mr.stop(); } catch { closeRecorder(); }
}

function closeRecorder(rerender = true) {
  if (!rec) return;
  const r = rec;
  rec = null;
  holdState = null;
  clearInterval(r.timer);
  if (r.pinged) sendTyping(r.chatId, 'stop');
  r.state = 'discard';
  try { if (r.mr.state !== 'inactive') r.mr.stop(); } catch { /* ignore */ }
  r.stream.getTracks().forEach((tr) => tr.stop());
  r.ac?.close().catch(() => {});
  if (view) { view.composer.classList.remove('recording', 'locked', 'cancelling'); syncComposerButtons(); }
  void rerender;
}

// ---------------------------------------------------------------- message store
export function upsert(chatId, m) {
  if (m.bridge_failed) toast(t('br.send_failed'));
  const cf = S.chats.get(chatId);
  if (cf?.forum && (m.topic_id || 0) !== (currentTopic(chatId) || 0)) { refreshTopics(chatId); return; }
  const b = bucket(chatId);
  const idx = b.list.findIndex((x) => x.id === m.id || (m.client_id && x.client_id === m.client_id));
  const sentNow = idx < 0 || b.list[idx].pending; // my own message just sent; later updates (transcript, edit, reaction) must not move the view
  if (idx < 0 && m.reply_to?.id) {
    // a new answer: the message it answers shows one more reply
    const at = b.list.findIndex((x) => x.id === m.reply_to.id);
    if (at >= 0) b.list[at] = { ...b.list[at], replies: (b.list[at].replies || 0) + 1 };
  }
  if (idx >= 0) {
    b.list[idx] = m;
  } else {
    if (b.detached) return;
    if (S.active === chatId && typeof m.id === 'number') m._enter = true; // a live arrival animates in once
    const pendingStart = b.list.findIndex((x) => x.pending);
    if (pendingStart === -1) b.list.push(m);
    else b.list.splice(pendingStart, 0, m);
  }
  b.list.sort((a, c) => {
    if (a.pending !== c.pending) return a.pending ? 1 : -1;
    return a.pending ? a.created_at - c.created_at : a.id - c.id;
  });
  if (S.active === chatId) {
    const atBottom = isNearBottom();
    renderMessages();
    if (atBottom || (sentNow && m.sender_id === S.me.id)) scrollBottom();
    markRead();
  }
}

export function removeMessage(chatId, id) {
  const b = bucket(chatId);
  b.list = b.list.filter((m) => m.id !== id);
  nodeCache.delete(`m:${id}`);
  if (S.active === chatId) renderMessages();
}

export function markFailed(clientId) {
  for (const b of S.msgs.values()) {
    const m = b.list.find((x) => x.client_id === clientId && x.pending);
    if (m) { m.failed = true; m.pending = false; m.id = `f:${clientId}`; }
  }
  if (S.active) renderMessages();
}

export function messageById(chatId, id) {
  return bucket(chatId).list.find((m) => m.id === id);
}

// ---------------------------------------------------------------- rendering
export function renderAll({ scroll } = {}) {
  if (!view) return;
  renderHeader();
  renderMessages();
  if (scroll === 'unread') {
    const d = nodeCache.get('unread')?.el;
    if (d) view.list.scrollTop = Math.max(0, d.offsetTop - 60);
    else scrollBottom();
  }
}

function isNearBottom() {
  const l = view?.list;
  return !l || l.scrollHeight - l.scrollTop - l.clientHeight < 120;
}

function scrollBottom() {
  if (view) view.list.scrollTop = view.list.scrollHeight;
}

function onScroll() {
  const l = view.list;
  if (l.scrollTop < 100) loadOlder();
  const far = l.scrollHeight - l.scrollTop - l.clientHeight;
  if (far < 200) {
    if (bucket(S.active).detached) loadNewer();
    markRead();
  }
  view.jump.hidden = !(bucket(S.active).detached || far > 800);
}

const topicMarked = new Map();   // chat:topic -> the last message already reported as read
const markReadDebounced = debounce(async () => {
  const id = S.active;
  const c = S.chats.get(id);
  if (!c || document.visibilityState !== 'visible' || !isNearBottom() || bucket(id).detached) return;
  const last = [...bucket(id).list].reverse().find((m) => !m.pending && !m.failed);
  if (!last) return;
  if (c.forum) {
    // a group with topics: the reading position belongs to the topic that is open, whatever was marked for the whole chat before
    const topic = currentTopic(id) || 0;
    const key = `${id}:${topic}`;
    const here = topicsOf(id).find((x) => x.id === topic);
    if ((here && !here.unread) || topicMarked.get(key) === last.id) return;
    topicMarked.set(key, last.id);
    api('POST', `/api/chats/${id}/read-topic`, { topic, message_id: last.id }).then(() => refreshTopics(id)).catch(() => topicMarked.delete(key));
    return;
  }
  if (last.id <= c.last_read_id) return;
  c.last_read_id = last.id;
  c.unread = 0;
  fire('chats');
  api('POST', `/api/chats/${id}/read`, { message_id: last.id }).catch(() => {});
}, 250);
export function markRead() { markReadDebounced(); }

export function senderName(m) {
  if (m.sender_id === S.me.id) return S.me.name;
  return shownName(S.chats.get(m.chat_id), m.sender_id, S.users.get(m.sender_id)?.name ?? m.reply_to?.sender_name ?? '…');
}

function statusOf(m, c) {
  if (m.failed) return { text: '!', cls: 'failed', label: t('msg.failed') };
  if (m.pending) return { text: '🕓', cls: '', label: t('msg.pending') };
  if (m.id <= c.others_read_id) return { text: '✓✓', cls: 'read', label: t('msg.read') };
  // like Telegram: one tick = sent (delivered or not yet), two ticks = read
  return { text: '✓', cls: '', label: m.id <= c.others_delivered_id ? t('msg.delivered') : t('msg.sent') };
}

function renderMessages() {
  if (!view) return;
  const c = activeChat();
  const b = bucket(c.id);
  suggestTranslate(c, b.list);
  const want = [];
  if (!b.list.length && !b.loading) {
    want.push(keyed('empty', () => (c.peer?.is_bot
      ? h('div', { class: 'empty' }, h('p', null, c.peer.bio || t('chat.empty')), h('button', { class: 'btn', type: 'button', onclick: () => sendCommand('/start') }, t('bots.start')))
      : h('div', { class: 'empty' }, t('chat.empty'))), c.peer?.is_bot ? 'bot' : ''));
  }
  let prevDay = null;
  let dividerDone = !unreadFrom;
  for (const m of b.list) {
    const dk = dayKey(m.created_at);
    if (dk !== prevDay) {
      prevDay = dk;
      want.push(keyed(`d:${dk}`, () => h('div', { class: 'day' }, fmtDay(m.created_at)), fmtDay(m.created_at)));
    }
    if (!dividerDone && typeof m.id === 'number' && m.id > unreadFrom && m.sender_id !== S.me.id) {
      want.push(keyed('unread', () => h('div', { class: 'unread-div', role: 'separator' }, t('chat.new_messages'))));
      dividerDone = true;
    }
    const sig = JSON.stringify([m.text, m.edited_at, m.tg_deleted, m.tg_prev?.length, m.deal && JSON.stringify(m.deal), m.forward_note, m.forward_path?.length, m.reactions, m.pending, m.upload?.state, m.failed, m.reply_to?.text, m.forward_from,
      m.file?.id, m.file?.thumb, m.markup, m.poll, m.event, m.mini, m.task, m.note, m.urgent, autoOn(c.id), m.once, m.live_until, m.comments, c.comments, m.topic_id, m.import_author, m.transcript, m.replies, cfg.transcribe, m.access_until, S.users.get(m.sender_id)?.name, aliasSig(c, m.sender_id), c.type, highlightId === m.id, S.me.id, selectMode, selected.has(m.id)]);
    const entry = cached(`m:${m.id}`, sig, () => buildMessage(m, c));
    entry.status && updateStatus(entry, m, c);
    want.push(entry);
  }
  if (typingUsers(c).length) {
    const act = typingAction(c);
    // the picture says what is going on: dots (writing), an equalizer (a voice message), a red dot (a video), arrows (a file)
    want.push(keyed(`typing-${act}`, () => h('div', { class: 'msg in typing-row' },
      h('div', { class: `bubble typing-dots act-${act}`, 'aria-label': t(ACT_TEXT[act]) },
        act === 'voice' ? [icon('mic', 16), h('span', { class: 'eq' }, h('i'), h('i'), h('i'), h('i'), h('i'))]
          : act === 'video' ? [h('span', { class: 'rec-live' }), h('span', { class: 'act-label' }, t('chat.rec_video'))]
            : act === 'file' ? [h('span', { class: 'up-arrows' }, h('i'), h('i'), h('i'))]
              : [h('span'), h('span'), h('span')]))));
  }
  // reconcile without detaching unchanged nodes (keeps audio/video playing)
  const list = view.list;
  const wantEls = want.map((w) => w.el);
  const keep = new Set(wantEls);
  for (const ch of [...list.children]) if (!keep.has(ch)) ch.remove();
  wantEls.forEach((el, i) => {
    if (list.children[i] !== el) list.insertBefore(el, list.children[i] || null);
  });
  const live = new Set(want.map((w) => w.key));
  for (const k of nodeCache.keys()) if (!live.has(k)) nodeCache.delete(k);
}

function cached(key, sig, build) {
  const hit = nodeCache.get(key);
  if (hit && hit.sig === sig) return hit;
  const entry = build();
  const wrapped = entry.el ? entry : { el: entry };
  wrapped.key = key;
  wrapped.sig = sig;
  nodeCache.set(key, wrapped);
  return wrapped;
}

function keyed(key, build, sig = '') {
  return cached(key, sig, () => ({ el: build() }));
}

function updateStatus(entry, m, c) {
  const s = statusOf(m, c);
  entry.status.className = `tick ${s.cls}`;
  entry.status.title = s.label;
  entry.status.replaceChildren(s.text === '✓✓' ? icon('checks', 18) : s.text === '✓' ? icon('check', 18) : document.createTextNode(s.text));
}

function buildCallEntry(m, c) {
  const mine = m.sender_id === S.me.id;
  const [status, flag] = String(m.text).split(':');
  const bad = status === 'missed' && !mine;
  const el = h('div', { class: 'msg call-entry' },
    h('button', {
      type: 'button', class: `call-chip${bad ? ' bad' : ''}`, title: t('call.back'),
      onclick: () => startCall(c.id, flag === 'video'),
    }, icon(flag === 'video' ? 'video' : 'phone', 18), h('span', null, callLabel(m, S.me.id)), h('small', null, fmtTime(m.created_at))));
  return { el, status: null };
}

function buildMessage(m, c) {
  if (m.kind === 'call') return buildCallEntry(m, c);
  const mine = c.imported ? m.import_author === c.import_me : m.sender_id === S.me.id;
  const bigEmoji = m.kind === 'text' && !m.file && /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic}|[\u{1F3FB}-\u{1F3FF}])*){1,3}$/u.test((m.text || '').trim());
  const bubble = h('div', { class: `bubble${bigEmoji ? ' big-emoji' : ''}${m.kind === 'sticker' ? ' sticker-bubble' : ''}${m.forward_from ? ' forwarded' : ''}` });
  if (!mine && c.type !== 'direct') {
    const al = aliasOf(c, m.sender_id);
    bubble.append(h('div', { class: `sender${al ? ' persona' : ''}` }, al ? animalAvatar(al.a, 'xs') : null,
      m.import_author || (al ? al.n : (S.users.get(m.sender_id)?.name ?? '…')), al?.real ? h('small', { class: 'muted' }, ` · ${al.real}`) : null));
  }
  if (m.forward_note) bubble.append(h('div', { class: 'fwd-note' }, h('span', { class: 'fwd-pen', 'aria-hidden': 'true' }, '\u270E'), ` ${m.forward_note}`));
  if (m.forward_path?.length > 1) {
    // who wrote it, then everybody who passed it on: the path the message travelled
    const hops = [];
    m.forward_path.forEach((n, i) => { if (i) hops.push(h('span', { class: 'arrow', 'aria-hidden': 'true' }, '\u2192')); hops.push(h('span', { class: `hop${i === 0 ? ' origin' : ''}` }, n)); });
    bubble.append(h('div', { class: 'fwd-chain', role: 'note', 'aria-label': t('fwd.path') }, ...hops));
  } else if (m.forward_from) bubble.append(h('div', { class: 'fwd' }, t('chat.forwarded_from', { name: m.forward_from })));
  if (m.reply_to) {
    bubble.append(h('div', { class: 'quote', onclick: () => jumpTo(c.id, m.reply_to.id) },
      h('b', null, shownName(c, m.reply_to.sender_id, m.reply_to.sender_name || '')), previewText(m.reply_to)));
  }
  if (m.kind === 'sticker') bubble.append(stickerNode(m));
  else if (m.kind === 'secret' && !m.upload) bubble.append(secretNode(m, c));
  else if (m.once && typeof m.id === 'number') bubble.append(onceNode(m));
  else if (m.file) bubble.append(buildFile(m));
  if (m.kind === 'poll' && m.poll) bubble.append(pollNode(m));
  if (m.kind === 'event' && m.event) bubble.append(eventNode(m));
  if (m.kind === 'task' && m.task) bubble.append(taskNode(m));
  if (m.kind === 'deal' && m.deal) bubble.append(dealNode(m));
  if (m.kind === 'note' && m.note) bubble.append(noteNode(m));
  if (m.kind === 'miniapp' && m.mini) bubble.append(miniNode(m));
  else if ((m.kind === 'poll' && m.poll) || (m.kind === 'event' && m.event) || (m.kind === 'task' && m.task) || (m.kind === 'deal' && m.deal) || (m.kind === 'note' && m.note)) { /* the card shows the text */ }
  else if (m.kind === 'sticker' || m.kind === 'secret') { /* shown above */ }
  else if (m.kind === 'location') bubble.append(locationNode(m));
  else if (m.kind === 'contact') bubble.append(contactNode(m));
  else if (bigEmoji && isSingleEmoji(m.text)) bubble.append(animatedEmoji(m.text.trim()) ?? h('div', { class: 'text' }, m.text));
  else if (m.text) bubble.append(h('div', { class: 'text' }, linkify(m.text)));
  if (m.kind === 'text' && !mine && !c.secret && m.text && autoOn(c.id)) { const te = bubble.querySelector(':scope > .text'); if (te) applyAutoTr(te, m.text, linkify); }
  if (m.kind === 'text' && !c.secret && m.text && typeof m.id === 'number') { const card = linkCard(firstUrl(m.text)); if (card) bubble.append(card); }
  if (c.comments && c.type === 'channel' && typeof m.id === 'number' && !m.pending) bubble.append(commentsButton(m));
  if (m.markup?.inline_keyboard) bubble.append(keyboardNode(m));
  const reacts = Object.entries(m.reactions || {});
  if (reacts.length) {
    bubble.append(h('div', { class: 'reactions' }, reacts.map(([emoji, ids]) =>
      h('button', {
        type: 'button', class: `react ${ids.includes(S.me.id) ? 'mine' : ''}`, disabled: !!m.pending,
        'aria-label': `${emoji} ${ids.length}`,
        onclick: () => api('POST', `/api/messages/${m.id}/reactions`, { emoji }).catch((e) => toast(errText(e.code))),
        oncontextmenu: (e) => { e.preventDefault(); e.stopPropagation(); openReactors(m); },
      }, `${emoji} ${ids.length}`))));
  }
  if (m.replies > 0 && typeof m.id === 'number' && !m.pending) {
    bubble.append(h('button', { class: 'thread-chip', type: 'button', onclick: () => openThread(m, c) }, `\u21a9 ${repliesLabel(m.replies)}`));
  }
  const status = mine ? h('span', { class: 'tick' }) : null;
  if (m.tg_deleted) bubble.append(h('div', { class: 'tg-gone' }, `\u{1F5D1} ${t('br.deleted_in_tg')}`));
  if (m.tg_prev?.length) bubble.append(h('details', { class: 'tg-prev' }, h('summary', null, t('br.was_edited')), ...m.tg_prev.map((p) => h('div', { class: 'tg-prev-v' }, h('small', { class: 'muted' }, fmtTime(p.at)), ` ${p.text}`))));
  bubble.append(h('div', { class: 'meta' }, m.edited_at ? h('span', null, t('chat.edited')) : null, h('span', null, fmtTime(m.created_at)), status));
  if (m.failed) {
    bubble.append(h('button', { class: 'btn link', type: 'button', onclick: () => retryFailed(m) }, t('msg.failed')));
  }
  if (m.pending && m.hold && m.hold > Date.now()) {
    const undo = h('button', { class: 'btn link undo-send', type: 'button', onclick: () => undoSend(m) }, `\u21A9 ${t('guard.undo')}`);
    bubble.append(undo);
    setTimeout(() => undo.remove(), m.hold - Date.now());
  }
  bubble.append(h('button', { class: 'more', type: 'button', 'aria-label': t('msg.more'), onclick: (e) => messageMenu(e.currentTarget, m) }, '⋯'));
  // the menu of a message: a right click, or a long press of the finger (a phone sends no "contextmenu" on iPhone)
  const pressed = longPress(bubble, () => messageMenu(bubble, m));
  bubble.addEventListener('contextmenu', (e) => { e.preventDefault(); if (!pressed()) messageMenu(bubble, m); });
  // double tap / double click: a quick heart, like in Telegram
  if (typeof m.id === 'number' && !m.pending && m.kind !== 'call') {
    bubble.addEventListener('dblclick', (e) => {
      if (e.target.closest('button, a, video, audio, input, .poll')) return;
      api('POST', `/api/messages/${m.id}/reactions`, { emoji: REACTIONS[1] }).catch(() => {});
    });
  }
  const el = h('div', { class: `msg ${mine ? 'out' : 'in'} ${m.pending ? 'pending' : ''} ${highlightId === m.id ? 'hl' : ''} ${m._enter ? 'enter' : ''}` }, bubble);
  if (selectMode && typeof m.id === 'number') {
    const on = selected.has(m.id);
    el.classList.add('selectable');
    if (on) el.classList.add('sel');
    el.prepend(h('span', { class: 'selbox', 'aria-hidden': 'true' }, on ? icon('check', 16) : null));
    el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); toggleSel(m.id); }, true);
  }
  // swipe the message to the left: reply (like Telegram)
  if (typeof m.id === 'number' && c.can_post && !m.pending && !m.failed) {
    swipeLeft(el, {
      canStart: () => !selectMode,
      onMove: (dx, done) => {
        bubble.style.transform = done || !dx ? '' : `translateX(${dx}px)`;
        el.classList.toggle('swiping', !done && dx < -8);
      },
      onCommit: () => { replyTo = m; editing = null; renderComposer(); view?.ta.focus(); },
    });
  }
  return { el, status };
}

/** "Send later": the typed text goes out at the chosen time. */
function scheduleFromComposer(anchor, { silent = false } = {}) {
  const c = activeChat();
  const text = view?.ta.value.trim();
  if (!c || !text) return;
  pickTime(anchor, async (ts, flags = {}) => {
    try {
      await scheduleText(c.id, text, replyTo?.id, ts, { silent, ...flags });
      view.ta.value = '';
      replyTo = null;
      saveDraft();
      renderComposer();
      autoGrow();
      syncComposerButtons();
    } catch (e) { toast(errText(e.code)); }
  }, { online: c.type === 'direct' && !c.saved && !c.imported });
}

/** Bot commands: the button next to the emoji opens the list the bot published. */
function botMenu(anchor, c) {
  const cmds = c.peer?.commands?.length ? c.peer.commands : [{ command: 'start', description: t('bots.start') }];
  popMenu(anchor, cmds.map((x) => ({ label: `/${x.command} \u2014 ${x.description}`, onClick: () => sendCommand(`/${x.command}`) })));
}

function sendCommand(text) {
  if (!view) return;
  view.ta.value = text;
  sendText();
}

/** Inline keyboard under a bot message. */
function keyboardNode(m) {
  const rows = m.markup.inline_keyboard.map((row) => h('div', { class: 'ikb-row' }, row.map((b) => {
    const btn = h('button', { class: 'ikb-btn', type: 'button', disabled: !!m.pending }, b.url ? h('span', null, b.text, ' \u2197') : b.text);
    btn.onclick = async () => {
      if (b.url) {
        if (/^https?:/i.test(b.url)) window.open(b.url, '_blank', 'noopener,noreferrer');
        else location.href = b.url;
        return;
      }
      btn.disabled = true;
      try { await api('POST', '/api/bots/callback', { message_id: m.id, data: b.callback_data }); } catch (e) { toast(errText(e.code)); }
      setTimeout(() => { btn.disabled = false; }, 800);
    };
    return btn;
  })));
  return h('div', { class: 'ikb' }, rows);
}

/** Save a received file through the browser (from the device cache when it is there). */
async function saveFile(f) {
  try {
    const blob = await fileBlob(f, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = f.name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  } catch (e) { toast(errText(e.code === 'forbidden' ? 'forbidden' : 'generic')); }
}

/** The body of an encrypted message: text or a file, decrypted on this device. */
function secretNode(m, c) {
  const box = h('div', { class: 'text secret-text' }, '🔒 …');
  openPayload(c, m).then((p) => {
    if (!p) { box.textContent = t('secret.cannot_read'); box.classList.add('muted'); return; }
    if (p.t !== undefined) { box.replaceChildren(...linkify(p.t)); return; }
    if (p.f) box.replaceChildren(secretFile(m, c, p.f));
  });
  return box;
}

function secretFile(m, c, f) {
  const holder = h('div', { class: 'secret-file' });
  const card = h('button', { class: 'filecard', type: 'button', 'aria-label': f.name },
    h('span', { class: 'ficon' }, fileIcon(f.name, f.mime, 40)),
    h('span', { class: 'fname' }, h('b', null, `🔒 ${f.name}`), h('span', { class: 'muted' }, formatBytes(f.size || 0))));
  const decrypt = async () => {
    card.disabled = true;
    try {
      const blob = await openBlob(c, m.file.url, f.iv, f.mime, f.ep);
      const url = URL.createObjectURL(blob);
      if (/^image\/(png|jpe?g|gif|webp)$/.test(f.mime)) {
        holder.replaceChildren(h('img', { class: 'secret-img', src: url, alt: f.name }));
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.download = f.name;
        a.click();
        card.disabled = false;
      }
    } catch { card.disabled = false; toast(t('secret.cannot_read')); }
  };
  card.onclick = decrypt;
  holder.append(card);
  if (/^image\//.test(f.mime) && (f.size || 0) <= 12 * 1048576) decrypt(); // pictures open by themselves, decrypted locally
  return holder;
}

function uploadCard(m) {
  const f = m.file;
  const u = m.upload || {};
  const pct = f.size ? Math.min(100, Math.round(((u.loaded || 0) / f.size) * 100)) : 0;
  const bar = h('span', { class: 'up-bar' });
  bar.style.width = `${pct}%`;
  const id = m.client_id;
  const act = [];
  if (['uploading', 'preparing', 'queued'].includes(u.state)) act.push(h('button', { class: 'icon-btn up-act', type: 'button', 'aria-label': t('up.pause'), onclick: () => pauseUpload(id) }, '⏸'));
  if (['paused', 'waiting', 'error'].includes(u.state)) act.push(h('button', { class: 'icon-btn up-act', type: 'button', 'aria-label': u.state === 'error' ? t('up.retry') : t('up.resume'), onclick: () => resumeUpload(id) }, u.state === 'error' ? '↻' : '▶'));
  act.push(h('button', { class: 'icon-btn up-cancel', type: 'button', 'aria-label': t('chat.cancel'), onclick: () => { cancelTask(id); removeMessage(m.chat_id, m.id); } }, '✕'));
  return h('div', { class: `upcard${u.state === 'error' ? ' failed' : ''}`, dataset: { up: id, state: u.state || 'queued' } },
    h('span', { class: 'ficon' }, fileIcon(f.name, f.mime, 40)),
    h('span', { class: 'fname' }, h('b', null, f.name),
      h('span', { class: 'muted up-txt' }, upText(u, f.size)),
      h('span', { class: 'up-track' }, bar)),
    h('span', { class: 'up-actions' }, act));
}

/**
 * A picture, video or file can be taken with the mouse and dropped into another program or website (the file is fetched from here at that moment, no need
 * to save it first), or onto a chat in the list (it is passed on there). Chromium browsers and the desktop app; not for secret chats, one-time files or uploads in progress.
 */
function dragOut(node, m) {
  const f = m.file;
  if (!f || m.upload || m.once || typeof m.id !== 'number' || S.chats.get(m.chat_id)?.secret || !['image', 'video', 'file'].includes(m.kind) || isVideoNote(m)) return;
  node.draggable = true;
  node.addEventListener('dragstart', (e) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const name = String(f.name || 'file').replace(/[:\\/]/g, '_');
    dt.effectAllowed = 'copyMove';
    dt.setData('DownloadURL', `${f.mime || 'application/octet-stream'}:${name}:${new URL(`${f.url}?dl=1`, location.origin).href}`);
    dt.setData('application/x-suhbat-msg', JSON.stringify({ id: m.id, chat_id: m.chat_id }));
    dt.setData('text/plain', name);
  });
}

/** A file whose access was limited: after the end its recipients see only a note (the sender still has it). */
function buildFile(m) {
  const mine = m.sender_id === S.me.id;
  if (m.access_until && m.access_until <= Date.now() && !mine) {
    return h('div', { class: 'filecard expired' }, h('span', { class: 'ficon' }, icon('lock', 28)),
      h('span', { class: 'fname' }, h('b', null, m.file.name), h('span', { class: 'muted' }, t('access.ended'))));
  }
  const node = buildFileInner(m);
  dragOut(node, m);
  const badge = accessBadge(m, mine);
  // in Saved messages a file can be handed on: link (password, expiry, download limit) and QR code
  const share = S.chats.get(m.chat_id)?.saved && typeof m.id === 'number' && !m.upload
    ? h('button', { class: 'btn secondary small share-chip', type: 'button', onclick: () => shareMessageFile(m) }, icon('qr', 16), h('span', null, t('sv.share'))) : null;
  return badge || share ? h('div', { class: 'file-with-badge' }, node, badge, share) : node;
}

function buildFileInner(m) {
  if (m.upload) return uploadCard(m);
  const f = m.file;
  const open = () => openViewer(m.chat_id, m.id);
  const ratio = f.width && f.height ? `${f.width} / ${f.height}` : null;
  if (m.kind === 'image') {
    const img = h('img', { src: f.thumb || f.url, alt: f.name, loading: 'lazy', draggable: false });
    if (ratio) img.style.aspectRatio = ratio;
    return h('button', { class: 'media media-btn', type: 'button', 'aria-label': f.name, onclick: open }, img);
  }
  if (isVideoNote(m)) return videoNoteNode(m);
  if (m.kind === 'video') {
    const poster = f.thumb ? h('img', { src: f.thumb, alt: f.name, loading: 'lazy', draggable: false }) : h('div', { class: 'poster-empty' });
    if (ratio && f.thumb) poster.style.aspectRatio = ratio;
    return h('button', { class: 'media media-btn video', type: 'button', 'aria-label': f.name, onclick: open },
      poster, h('span', { class: 'play-badge' }, icon('send', 28)), h('span', { class: 'media-size' }, formatBytes(f.size)));
  }
  if (m.kind === 'audio' || m.kind === 'voice') {
    const tn = transcriptNode(m, !!cfg.transcribe && !isSecret(activeChat() || {}));
    return tn ? h('div', { class: 'voice-with-tr' }, voiceNode(m), tn) : voiceNode(m);
  }
  prefetchNative(f);
  return h('button', { class: 'filecard', type: 'button', onclick: () => { if (isOffice(f)) { if (canOpenNative()) openNative(f); else saveFile(f); } else if (canOpenNative()) openNative(f); else open(); }, 'aria-label': f.name },
    h('span', { class: 'ficon' }, fileIcon(f.name, f.mime, 40)),
    h('span', { class: 'fname' }, h('b', null, f.name), h('span', { class: 'muted' }, formatBytes(f.size))));
}

function retryFailed(m) {
  const c = S.chats.get(m.chat_id);
  const b = bucket(m.chat_id);
  b.list = b.list.filter((x) => x !== m);
  nodeCache.delete(`m:${m.id}`);
  const clientId = uuid();
  outbox.add({ chat_id: m.chat_id, text: m.text, client_id: clientId, reply_to: m.reply_to?.id ?? null });
  b.list.push({ ...m, id: `c:${clientId}`, client_id: clientId, pending: true, failed: false, created_at: Date.now() });
  renderMessages();
  flushOutbox();
  void c;
}

/** A copy of a Telegram chat: an ordinary person cannot delete, clear, leave or edit in it (it is kept in step with Telegram). */
const lockedChat = (c) => c?.imported === 'tgbridge' && !S.me.is_admin;

function messageMenu(anchor, m) {
  const c = activeChat();
  const mine = m.sender_id === S.me.id;
  const items = [];
  const more = [];   // rarely needed: under "More"
  if (m.pending || m.failed) {
    items.push({
      label: t('msg.delete'), danger: true, onClick: () => {
        outbox.remove(m.client_id);
        removeMessage(c.id, m.id);
      },
    });
    return popMenu(anchor, items);
  }
  items.push({ emojis: REACTIONS, onPick: (emoji) => api('POST', `/api/messages/${m.id}/reactions`, { emoji }).catch((e) => toast(errText(e.code))) });
  if (c.can_post) {
    items.push({ icon: 'reply', label: t('msg.reply'), onClick: () => { replyTo = m; editing = null; renderComposer(); view.ta.focus(); } });
  }
  if (m.replies > 0 && typeof m.id === 'number') more.push({ label: `${t('msg.thread')} (${m.replies})`, onClick: () => openThread(m, c) });
  if (Object.keys(m.reactions || {}).length) more.push({ icon: 'smile', label: t('react.who'), onClick: () => openReactors(m) });
  if (m.text) items.push({ icon: 'copy', label: t('msg.copy'), onClick: () => navigator.clipboard?.writeText(m.text).catch(() => {}) });
  if (m.text && m.kind === 'text') more.push({ icon: 'globe', label: t('msg.translate'), onClick: () => translateMessage(m) });
  items.push({ icon: 'forward', label: t('msg.forward'), onClick: () => openForward(m) });
  if (!isSecret(c) && typeof m.id === 'number' && !c.saved && m.kind !== 'call') {
    // bookmark = a copy in "Saved messages"
    more.push({ icon: 'bookmark', label: t('msg.bookmark'), onClick: async () => {
      try {
        const saved = (await api('POST', '/api/chats/saved')).chat;
        S.chats.set(saved.id, saved);
        await api('POST', `/api/chats/${saved.id}/messages`, { forward_of: m.id, client_id: uuid() });
        toast(t('msg.bookmarked'));
      } catch (e) { toast(errText(e.code)); }
    } });
  }
  if (m.file && !isSecret(c) && typeof m.id === 'number') {
    if (c.saved) more.push({ icon: 'forward', label: t('sv.share'), onClick: () => shareMessageFile(m) });
    if (mine) more.push({ icon: 'lock', label: t('access.limit'), onClick: () => accessMenu(anchor, m) });
  }
  if (m.file) {
    items.push({ icon: 'download', label: t('msg.save'), onClick: () => { const a = h('a', { href: `${m.file.url}?dl=1`, download: m.file.name }); document.body.append(a); a.click(); a.remove(); } });
  }
  if (m.kind === 'image' && m.file && navigator.clipboard?.write && window.ClipboardItem) {
    more.push({ icon: 'copy', label: t('msg.copy_image'), onClick: () => copyImage(m).catch(() => toast(t('err.generic'))) });
  }
  if (mine && typeof m.id === 'number' && c.type !== 'channel' && !c.saved && !isSecret(c) && m.kind !== 'call') more.push({ icon: 'checks', label: t('readers.title'), onClick: () => openReaders(m) });
  if (typeof m.id === 'number') {
    if (!mine) more.push({ icon: 'flag', label: t('msg.report'), danger: true, onClick: () => reportMenu(anchor, m) });
    if (!isSecret(c) && c.can_post && ['text', 'image', 'video', 'file', 'voice', 'audio'].includes(m.kind)) more.push(...(featureOn('tasks') ? [{ icon: 'tasks', label: t('task.make'), onClick: () => openTaskCreate(c.id, m) }] : []), ...(featureOn('deals') ? [{ icon: 'check', label: t('deal.make'), onClick: () => openDealCreate(c.id, m) }] : []));
    more.push({ icon: 'bell', label: t('msg.remind'), onClick: () => pickTime(anchor, (ts) => remind(previewText(m).slice(0, 300), c.id, ts).catch((e) => toast(errText(e.code)))) });
    items.push({ icon: 'selectc', label: t('msg.select'), onClick: () => enterSelect(m.id) });
  }
  if (mine && c.can_post && !lockedChat(c) && (m.kind === 'text' || m.file)) {
    items.push({
      label: t('msg.edit'), onClick: () => {
        editing = m;
        replyTo = null;
        renderComposer();
        view.ta.value = m.text;
        syncComposerButtons();
        view.sendBtn.hidden = false;
        autoGrow();
        view.ta.focus();
      },
    });
  }
  const adminLike = c.my_role === 'owner' || c.my_role === 'admin';
  if (c.type === 'direct' || adminLike) {
    const pinned = (c.pins || []).some((p) => p.id === m.id) || c.pinned?.id === m.id;
    items.push({
      icon: 'pin', label: pinned ? t('msg.unpin') : t('msg.pin'),
      onClick: () => api('POST', `/api/chats/${c.id}/pin`, pinned ? { message_id: m.id, unpin: true } : { message_id: m.id }).catch((e) => toast(errText(e.code))),
    });
  }
  if ((mine || (c.type !== 'direct' && adminLike)) && !lockedChat(c)) {
    items.push({
      icon: 'trash', label: t('msg.delete'), danger: true, onClick: async () => {
        if (await confirmDialog(t('msg.delete_confirm'), { okLabel: t('msg.delete'), danger: true })) {
          api('DELETE', `/api/messages/${m.id}`).catch((e) => toast(errText(e.code)));
        }
      },
    });
  }
  if (more.length) items.push({ icon: 'more', label: t('msg.more_actions'), onClick: () => popMenu(anchor, more) });
  popMenu(anchor, items);
}

on('open-chat', (id) => openChat(id));
on('jump', ({ chatId, msgId }) => jumpTo(chatId, msgId));
on('visibility', () => markRead());

// ---------------------------------------------------------------- mute / clear / delete / export
const HOUR = 3600_000;
function muteMenu(anchor, c) {
  popMenu(anchor, [
    { label: t('mute.1h'), onClick: () => setMute(c, HOUR) },
    { label: t('mute.8h'), onClick: () => setMute(c, 8 * HOUR) },
    { label: t('mute.2d'), onClick: () => setMute(c, 48 * HOUR) },
    { label: t('mute.forever'), onClick: () => setMute(c, 'forever') },
  ]);
}
function setMute(c, how) {
  const body = how === 'off' ? { muted: false, muted_until: 0 }
    : how === 'forever' ? { muted: true, muted_until: 0 }
      : { muted: false, muted_until: Date.now() + how };
  api('PATCH', `/api/chats/${c.id}/me`, body).catch((e) => toast(errText(e.code)));
}

async function clearHistory(c) {
  if (!(await confirmDialog(t('chat.clear_confirm'), { okLabel: t('chat.clear'), danger: true }))) return;
  try {
    const r = await api('POST', `/api/chats/${c.id}/clear`);
    if (r.chat) S.chats.set(c.id, r.chat);
    const b = bucket(c.id);
    b.list = b.list.filter((m) => m.pending);
    b.hasMore = false;
    nodeCache.clear();
    unreadFrom = 0;
    if (S.active === c.id) renderMessages();
    fire('chats');
    toast(t('chat.cleared'));
  } catch (e) { toast(errText(e.code)); }
}

async function deleteChat(c) {
  if (!(await confirmDialog(t('chat.delete_confirm'), { okLabel: t('chat.delete'), danger: true }))) return;
  try {
    await api('POST', `/api/chats/${c.id}/hide`);
    S.chats.delete(c.id);
    S.msgs.delete(c.id);
    fire('chat-removed', c.id);
  } catch (e) { toast(errText(e.code)); }
}

/** Download the whole conversation as a text file (done on this device, nothing is sent anywhere). */
async function exportChat(c) {
  toast(t('chat.exporting'));
  const all = [];
  let before;
  for (let i = 0; i < 400; i++) {
    const r = await api('GET', `/api/chats/${c.id}/messages?limit=100${before ? `&before=${before}` : ''}`);
    if (!r.messages.length) break;
    all.unshift(...r.messages);
    before = r.messages[0].id;
    if (!r.has_more) break;
  }
  const NL = String.fromCharCode(10);
  const who = (m) => (m.sender_id === S.me.id ? S.me.name : S.users.get(m.sender_id)?.name || (c.type === 'direct' ? c.peer?.name : '') || '?');
  const lines = [`${chatTitle(c)} — ${new Date().toLocaleString()}`, ''];
  for (const m of all) {
    const when = new Date(m.created_at).toLocaleString();
    const body = m.kind === 'call' ? callLabel(m, S.me.id) : [m.text, m.file ? `[${m.file.name}]` : ''].filter(Boolean).join(' ');
    lines.push(`[${when}] ${who(m)}: ${body}`);
  }
  const blob = new Blob([lines.join(NL)], { type: 'text/plain;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${chatTitle(c).replace(/[^\p{L}\p{N}_-]+/gu, '_')}.txt` });
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  toast(t('chat.exported', { n: all.length }));
}

async function copyImage(m) {
  const blob = await (await fetch(m.file.url, { credentials: 'same-origin' })).blob();
  // the clipboard accepts PNG: re-encode other formats through a canvas
  let png = blob;
  if (blob.type !== 'image/png') {
    const bmp = await createImageBitmap(blob);
    const cv = document.createElement('canvas');
    cv.width = bmp.width; cv.height = bmp.height;
    cv.getContext('2d').drawImage(bmp, 0, 0);
    png = await new Promise((res) => cv.toBlob(res, 'image/png'));
  }
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
  toast(t('msg.copied'));
}

// ---------------------------------------------------------------- selection mode (like Telegram's "Select")
function enterSelect(firstId) {
  selectMode = true;
  selected.clear();
  if (firstId !== null && firstId !== undefined) selected.add(firstId);
  renderSelBar();
  renderMessages();
}
function exitSelect() {
  selectMode = false;
  selected.clear();
  renderSelBar();
  renderMessages();
}
function toggleSel(id) {
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  renderSelBar();
  renderMessages();
}
function selectedMessages() {
  const b = bucket(S.active);
  return b.list.filter((m) => selected.has(m.id)).sort((x, y) => x.id - y.id);
}
function renderSelBar() {
  if (!view) return;
  view.wrap.classList.toggle('selecting', selectMode);
  view.selbar?.remove();
  view.selbar = null;
  if (!selectMode) return;
  const c = activeChat();
  const msgs = selectedMessages();
  const adminLike = c.my_role === 'owner' || c.my_role === 'admin';
  const canDelete = !lockedChat(c) && msgs.length > 0 && msgs.every((m) => m.sender_id === S.me.id || (c.type !== 'direct' && adminLike));
  view.selbar = h('div', { class: 'selbar' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.cancel'), onclick: exitSelect }, icon('close', 22)),
    h('b', { class: 'grow' }, t('sel.count', { n: selected.size })),
    h('button', { class: 'btn secondary', type: 'button', disabled: !msgs.length, onclick: () => { openForward(msgs); exitSelect(); } }, t('msg.forward')),
    h('button', { class: 'btn danger', type: 'button', disabled: !canDelete, onclick: async () => {
      if (!(await confirmDialog(t('sel.delete_confirm', { n: msgs.length }), { okLabel: t('msg.delete'), danger: true }))) return;
      for (const m of msgs) await api('DELETE', `/api/messages/${m.id}`).catch(() => {});
      exitSelect();
    } }, t('msg.delete')));
  view.wrap.prepend(view.selbar);
}

// ---------------------------------------------------------------- header menu & emoji picker
const EMOJI = ['😀', '😂', '😊', '😍', '😘', '😉', '🙂', '😎', '🤔', '😢', '😭', '😡', '👍', '👎', '👏', '🙏', '💪', '🔥', '❤️', '💔', '🎉', '✅', '❌', '⭐', '👋', '🤝', '🙌', '😴', '🤗', '😅', '😇', '🥳'];

function emojiPicker(anchor) {
  const rows = [];
  for (let i = 0; i < EMOJI.length; i += 8) {
    rows.push({ emojis: EMOJI.slice(i, i + 8), onPick: (e) => insertAtCursor(e) });
  }
  popMenu(anchor, rows);
}

function insertAtCursor(text) {
  const ta = view?.ta;
  if (!ta) return;
  const s = ta.selectionStart ?? ta.value.length;
  const e = ta.selectionEnd ?? s;
  ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
  ta.selectionStart = ta.selectionEnd = s + text.length;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
}

function chatMoreMenu(anchor) {
  const c = activeChat();
  if (!c) return;
  const items = [
    { icon: 'search', label: t('chat.search'), onClick: () => openChatSearch(c.id) }, // the header button is hidden on narrow phone screens
    isMuted(c)
      ? { icon: 'bell', label: t('ctx.unmute'), onClick: () => setMute(c, 'off') }
      : { icon: 'bell', label: t('chat.mute_for'), onClick: () => muteMenu(anchor, c) },
    { icon: 'pin', label: c.pinned_at ? t('ctx.unpin') : t('ctx.pin'), onClick: () => api('POST', `/api/chats/${c.id}/pin-chat`, { pinned: !c.pinned_at }).catch((e) => toast(errText(e.code))) },
    { icon: 'folder', label: t('ctx.folder'), onClick: () => folderPicker(anchor, c) },
    ...(featureOn('scheduled') ? [{ label: t('sched.title'), onClick: () => openScheduled(c.id) }] : []),
    ...(featureOn('chattheme') ? [{ label: t('theme.title'), onClick: () => openChatTheme(c) }] : []),
    ...(!isSecret(c) && featureOn('digest') ? [{ label: t('digest.title'), onClick: () => openDigest(c.id) }] : []),
    ...(featureOn('tasks') ? [{ label: t('task.title'), onClick: () => openTasks() }] : []),
    ...(!isSecret(c) && !c.saved ? [{ icon: 'globe', label: `${t('atr.title')}: ${autoOn(c.id) ? t('st.on') : t('st.off')}`, onClick: () => {
      if (!autoOn(c.id) && !autoAvailable()) { toast(t('atr.unavailable'), 6000); return; }
      setAuto(c.id, !autoOn(c.id)); nodeCache.clear(); renderMessages(); renderHeader();
    } }] : []),
    ...(featureOn('autodelete') && (c.type === 'direct' || c.my_role !== 'member') ? [{ label: `${t('ttl.title')}: ${ttlLabel(c.ttl)}`, onClick: () => ttlMenu(anchor, c) }] : []),
    ...(featureOn('chatsound') ? [{ label: `${t('ctx.sound')}: ${t(`sound.${c.sound || 'default'}`)}`, onClick: () => soundMenu(anchor, c) }] : []),
    ...(c.type === 'group' ? [
      ...(!c.imported && featureOn('rooms') ? [{ label: t('room.title'), onClick: () => joinGroupCall(c.id, false, { room: true }) }] : []),
      { icon: 'phone', label: t('gcall.audio'), onClick: () => joinGroupCall(c.id, false) },
      { icon: 'video', label: t('gcall.video'), onClick: () => joinGroupCall(c.id, true) },
    ] : []),
    { icon: 'user', label: t('chat.profile'), onClick: toggleInfo },
    { icon: 'grid', label: t('media.title'), onClick: () => openMediaPanel(c.id) },
    { icon: 'archive', label: c.archived ? t('archive.remove') : t('archive.add'), onClick: () => api('PATCH', `/api/chats/${c.id}/me`, { archived: !c.archived }).catch((e) => toast(errText(e.code))) },
    ...(featureOn('chatexport') ? [{ label: t('chat.export'), onClick: () => exportChat(c).catch((e) => toast(errText(e.code))) }] : []),
    ...(lockedChat(c) ? [] : [{ icon: 'trash', label: t('chat.clear'), danger: true, onClick: () => clearHistory(c) }]),
  ];
  if (isSecret(c)) items.unshift({ icon: 'lock', label: t('secret.title'), onClick: () => showSecretInfo(c) });
  else if (c.type === 'direct' && !c.saved && c.peer && !c.peer.is_bot) items.splice(1, 0, { icon: 'lock', label: t('secret.start'), onClick: () => startSecretChat(c.peer.id) });
  if (c.type === 'direct' && !c.saved && !lockedChat(c)) items.push({ icon: 'trash', label: t('chat.delete'), danger: true, onClick: () => deleteChat(c) });
  popMenu(anchor, items);
}

// the key of an encrypted group arrived: unlock the composer and the messages that could not be read yet
on('e2e-keys', (id) => {
  secretStatuses.clear();
  if (view && S.active === id) { nodeCache.clear(); view.ckey = ''; renderComposer(); renderMessages(); }
});

// the strip of topics (or its counters) changed
document.addEventListener('suhbat:topics', (e) => { if (view && S.active === e.detail) renderHeader(); });
on('chat-theme', (id) => { if (view && S.active === id) renderHeader(); });

initPhoneMenu();
