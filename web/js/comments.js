// Comments under a post of a channel: a thread with its own composer, live.
import { h, clear, linkify, uuid } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { S, on } from './state.js';
import { api } from './net.js';
import { avatar, confirmDialog, modal, previewText, toast } from './ui.js';

const open = new Map(); // post id -> { add(message) }

const when = (ts) => new Date(ts).toLocaleTimeString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { hour: '2-digit', minute: '2-digit' });

/** The "N comments" button under a post. */
export function commentsButton(m) {
  const n = m.comments || 0;
  return h('button', { class: 'comments-btn', type: 'button', onclick: () => openComments(m) },
    `\u{1F4AC} ${n ? t('comments.n', { n }) : t('comments.leave')}`);
}

export function openComments(post) {
  const chat = S.chats.get(post.chat_id);
  const list = h('div', { class: 'cm-list' });
  const input = h('textarea', { class: 'input', rows: 1, maxLength: 4000, placeholder: t('comments.write'), 'aria-label': t('comments.write') });
  let replyTo = null;
  const replyBar = h('div', { class: 'cm-reply', hidden: true });
  const nameOf = (id) => (id === S.me.id ? S.me.name : S.users.get(id)?.name || '');
  const draw = (c) => {
    const mine = c.sender_id === S.me.id;
    const admin = chat?.my_role === 'owner' || chat?.my_role === 'admin';
    return h('div', { class: `cm-item${mine ? ' mine' : ''}`, dataset: { id: String(c.id) } },
      avatar(S.users.get(c.sender_id) || { id: c.sender_id, name: nameOf(c.sender_id) }, 'sm'),
      h('div', { class: 'cm-body' },
        h('div', { class: 'cm-head' }, h('b', null, nameOf(c.sender_id) || '…'), h('small', { class: 'muted' }, when(c.created_at))),
        c.reply_to ? h('div', { class: 'quote' }, h('b', null, c.reply_to.sender_name || ''), c.reply_to.text) : null,
        h('div', { class: 'cm-text' }, ...linkify(c.text)),
        h('div', { class: 'cm-actions' },
          h('button', { class: 'btn link', type: 'button', onclick: () => {
            replyTo = c;
            clear(replyBar).append(h('span', null, `${t('msg.reply')}: ${previewText(c).slice(0, 60)}`), h('button', { class: 'icon-btn', type: 'button', onclick: () => { replyTo = null; replyBar.hidden = true; } }, '✕'));
            replyBar.hidden = false;
            input.focus();
          } }, t('msg.reply')),
          mine || admin ? h('button', { class: 'btn link', type: 'button', onclick: async () => {
            if (!(await confirmDialog(t('msg.delete_confirm'), { okLabel: t('msg.delete'), danger: true }))) return;
            api('DELETE', `/api/messages/${c.id}`).then(() => list.querySelector(`[data-id="${c.id}"]`)?.remove()).catch((e) => toast(errText(e.code)));
          } }, t('msg.delete')) : null)));
  };
  const add = (c) => {
    if (list.querySelector(`[data-id="${c.id}"]`)) return;
    list.querySelector('.cm-empty')?.remove();
    list.append(draw(c));
    list.scrollTop = list.scrollHeight;
  };
  const send = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const reply = replyTo?.id;
    replyTo = null;
    replyBar.hidden = true;
    try { add((await api('POST', `/api/messages/${post.id}/comments`, { text, client_id: uuid(), reply_to: reply })).comment); } catch (e) { toast(errText(e.code)); input.value = text; }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); } });
  const win = modal({
    title: t('comments.title'), className: 'comments',
    onClose: () => open.delete(post.id),
    body: [h('div', { class: 'cm-post' }, previewText(post).slice(0, 200)), list, replyBar,
      h('div', { class: 'cm-compose' }, input, h('button', { class: 'btn', type: 'button', onclick: send }, t('chat.send')))],
  });
  open.set(post.id, { add });
  (async () => {
    try {
      const r = await api('GET', `/api/messages/${post.id}/comments?limit=100`);
      clear(list);
      if (!r.comments.length) list.append(h('p', { class: 'muted cm-empty' }, t('comments.none')));
      r.comments.forEach((c) => list.append(draw(c)));
      list.scrollTop = list.scrollHeight;
    } catch (e) { win.close(); toast(errText(e.code)); }
  })();
  setTimeout(() => input.focus(), 60);
}

on('ws', (ev) => {
  if (ev.type === 'comment.new') open.get(ev.post_id)?.add(ev.message);
});
