// A thread of replies: one message and everything written in answer to it (and to those answers), with its own composer.
// Also "who reacted with what".
import { h, clear, uuid } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire, on } from './state.js';
import { api } from './net.js';
import { avatar, fmtDay, fmtTime, modal, previewText, toast } from './ui.js';
import { icon } from './icons.js';

const nameOf = (m) => (m.import_author || S.users.get(m.sender_id)?.name || '');

export function repliesLabel(n) {
  return t('thread.n', { n });
}

export async function openThread(root, chat) {
  const list = h('div', { class: 'thread-list', role: 'list' });
  const target = { m: root };
  const bar = h('div', { class: 'thread-target', hidden: true });
  const input = h('input', { class: 'input', type: 'text', maxLength: 4000, placeholder: t('thread.ph'), 'aria-label': t('thread.ph') });
  const send = h('button', { class: 'icon-btn send', type: 'button', 'aria-label': t('chat.send') }, icon('send', 22));
  const canPost = !!chat?.can_post;
  const seen = new Map();
  let off = () => {};
  const m = modal({
    title: t('thread.title'), className: 'thread',
    body: [list, ...(canPost ? [bar, h('div', { class: 'thread-composer' }, input, send)] : [])],
    onClose: () => off(),
  });

  const row = (x, isRoot = false) => {
    const mine = x.sender_id === S.me.id;
    const sender = S.users.get(x.sender_id) || { id: x.sender_id || 0, name: nameOf(x) };
    return h('div', { class: `thread-msg${isRoot ? ' root' : ''}${mine ? ' mine' : ''}`, role: 'listitem', dataset: { id: String(x.id) } },
      avatar(sender, 'sm'),
      h('div', { class: 'thread-bubble' },
        h('div', { class: 'thread-head' }, h('b', null, mine ? t('chat.you') : nameOf(x)), h('span', { class: 'muted' }, ` ${fmtDay(x.created_at)} ${fmtTime(x.created_at)}`)),
        x.reply_to && !isRoot ? h('div', { class: 'thread-quote ellipsis' }, `↩ ${x.reply_to.sender_name ? `${x.reply_to.sender_name}: ` : ''}${x.reply_to.text || ''}`) : null,
        h('div', { class: 'thread-text' }, previewText(x)),
        h('div', { class: 'thread-actions' },
          canPost ? h('button', { class: 'btn link', type: 'button', onclick: () => aim(x) }, t('msg.reply')) : null,
          h('button', { class: 'btn link', type: 'button', onclick: () => { m.close(); fire('jump', { chatId: x.chat_id, msgId: x.id }); } }, t('thread.show')))));
  };

  const aim = (x) => {
    target.m = x;
    bar.hidden = x.id === root.id;
    clear(bar).append(h('span', { class: 'ellipsis' }, `${t('msg.reply')}: ${nameOf(x)} — ${previewText(x).slice(0, 60)}`),
      h('button', { class: 'icon-btn sm', type: 'button', 'aria-label': t('chat.cancel'), onclick: () => aim(root) }, '✕'));
    input.focus();
  };

  const add = (x) => {
    if (seen.has(x.id)) return;
    seen.set(x.id, x);
    const node = row(x);
    list.append(node);
    list.scrollTop = list.scrollHeight;
  };

  try {
    const r = await api('GET', `/api/messages/${root.id}/thread`);
    list.append(row(r.root, true), h('div', { class: 'thread-sep' }, repliesLabel(r.replies.length)));
    r.replies.forEach(add);
  } catch (e) { toast(errText(e.code)); m.close(); return; }

  // answers that arrive while the thread is open: those to the root or to anything already in it
  off = on('ws', (ev) => {
    if (ev.type !== 'message.new' || ev.message?.chat_id !== root.chat_id) return;
    const rid = ev.message.reply_to?.id;
    if (rid && (rid === root.id || seen.has(rid))) { add(ev.message); list.querySelector('.thread-sep').textContent = repliesLabel(seen.size); }
  });

  const go = async () => {
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const r = await api('POST', `/api/chats/${root.chat_id}/messages`, { text, reply_to: target.m.id, client_id: uuid() });
      add(r.message);
      list.querySelector('.thread-sep').textContent = repliesLabel(seen.size);
      aim(root);
    } catch (e) { input.value = text; toast(errText(e.code)); }
  };
  send.addEventListener('click', go);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); go(); } });
  if (canPost) input.focus();
}

/** Who put which reaction on a message. */
export function openReactors(msg) {
  const groups = Object.entries(msg.reactions || {});
  if (!groups.length) return;
  modal({
    title: t('react.who'),
    body: groups.map(([emoji, ids]) => h('div', { class: 'reactors' },
      h('div', { class: 'reactors-head' }, h('span', { class: 'reactors-emoji' }, emoji), h('span', { class: 'muted' }, ` ${ids.length}`)),
      ...ids.map((id) => {
        const u = S.users.get(id) || { id, name: String(id) };
        return h('div', { class: 'list-item' }, avatar(u, 'sm'), h('span', { class: 'grow' }, id === S.me.id ? `${u.name} (${t('chat.you')})` : u.name));
      }))),
  });
}
