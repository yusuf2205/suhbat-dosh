import { h, uuid } from './dom.js';
import { t, errText } from './i18n.js';
import { S, chatTitle } from './state.js';
import { toast } from './ui.js';
import { api } from './net.js';
import { attachFiles } from './chat.js';

// Drop files anywhere in the window to send them to the open chat,
// or onto a chat in the list to send them to that chat (like Telegram).
let overlay;
let depth = 0;
let hovered = null;

const hasFiles = (e) => { const ty = [...(e.dataTransfer?.types || [])]; return ty.includes('Files') && !ty.includes('application/x-suhbat-msg'); };   // not a file of our own chat taken out of it
const MSG = 'application/x-suhbat-msg';   // a file of a message, taken from the open chat
const hasMsg = (e) => [...(e.dataTransfer?.types || [])].includes(MSG);
const chatItem = (e) => e.target?.closest?.('.ci[data-chat-id]');

function targetChatId(e) {
  const ci = chatItem(e);
  return ci ? Number(ci.dataset.chatId) : S.active;
}

function ensureOverlay() {
  if (overlay) return overlay;
  overlay = h('div', { class: 'drop-overlay', 'aria-hidden': 'true' },
    h('div', { class: 'drop-card' }, h('div', { class: 'drop-ico' }, '⬇'), h('b', { class: 'drop-title' }), h('span', { class: 'drop-sub' })));
  document.body.append(overlay);
  return overlay;
}

function show(e) {
  const o = ensureOverlay();
  const id = targetChatId(e);
  const c = id ? S.chats.get(id) : null;
  o.querySelector('.drop-title').textContent = c ? t('drop.title') : t('drop.open_chat');
  o.querySelector('.drop-sub').textContent = c ? t('drop.to', { name: chatTitle(c) }) : '';
  o.classList.add('on');
}

function hide() {
  depth = 0;
  overlay?.classList.remove('on');
  hovered?.classList.remove('drop-target');
  hovered = null;
}

document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || !S.me) return;
  e.preventDefault();
  depth += 1;
  show(e);
});

document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); // required, otherwise the browser would navigate to the dropped file
  e.dataTransfer.dropEffect = 'copy';
  const ci = chatItem(e) || null;
  if (ci !== hovered) {
    hovered?.classList.remove('drop-target');
    hovered = ci;
    hovered?.classList.add('drop-target');
    if (S.me) show(e);
  }
});

document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  depth = Math.max(0, depth - 1);
  if (depth === 0) hide();
});

document.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  const id = targetChatId(e);
  const files = [...(e.dataTransfer.files || [])];
  hide();
  if (!S.me || !files.length) return;
  if (!id) return void toast(t('drop.open_chat'));
  attachFiles(id, files);
});

// a file of a message dropped onto a chat in the list is passed on there (the same as "Передать дальше")
document.addEventListener('dragover', (e) => {
  if (!hasMsg(e)) return;
  const ci = chatItem(e);
  if (!ci || !S.chats.get(Number(ci.dataset.chatId))?.can_post) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
  if (ci !== hovered) { hovered?.classList.remove('drop-target'); hovered = ci; ci.classList.add('drop-target'); }
});
document.addEventListener('dragleave', (e) => {
  if (!hasMsg(e) || !hovered || hovered.contains(e.relatedTarget)) return;
  hovered.classList.remove('drop-target');
  hovered = null;
});
document.addEventListener('drop', async (e) => {
  if (!hasMsg(e)) return;
  const ci = chatItem(e);
  hide();
  if (!ci || !S.me) return;
  e.preventDefault();
  let src;
  try { src = JSON.parse(e.dataTransfer.getData(MSG)); } catch { return; }
  const to = S.chats.get(Number(ci.dataset.chatId));
  if (!to?.can_post || !Number.isInteger(src?.id)) return;
  try {
    await api('POST', `/api/chats/${to.id}/messages`, { forward_of: src.id, client_id: uuid() });
    toast(`${t('msg.forwarded')} · ${chatTitle(to)}`);
  } catch (err) { toast(errText(err.code)); }
});
document.addEventListener('dragend', hide);

// a drag that is cancelled with Esc must not leave the overlay behind
window.addEventListener('blur', hide);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
