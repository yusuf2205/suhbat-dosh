// Topics in a group: a strip of topics under the header (with unread counters), and creating / renaming / closing topics.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { S, on } from './state.js';
import { api } from './net.js';
import { modal, popMenu, toast } from './ui.js';

S.topics ||= new Map(); // chatId -> [{ id, title, emoji, closed, unread }]
S.topic ||= new Map(); // chatId -> topic being viewed (0 = General)

export const topicsOf = (chatId) => S.topics.get(chatId) || [];
export const currentTopic = (chatId) => (S.chats.get(chatId)?.forum ? S.topic.get(chatId) || 0 : null);
/** "&topic=N" for the message list requests of a group with topics, nothing for other chats. */
export const topicQuery = (chatId) => { const x = currentTopic(chatId); return x === null ? '' : `&topic=${x}`; };

let timers = new Map();
/** Reload the topics (and their counters) shortly: many messages in a row make one request. */
export function refreshTopics(chatId, now = false) {
  clearTimeout(timers.get(chatId));
  const run = async () => {
    try {
      S.topics.set(chatId, (await api('GET', `/api/chats/${chatId}/topics`)).topics);
      document.dispatchEvent(new CustomEvent('suhbat:topics', { detail: chatId }));
    } catch { /* not a forum any more, or offline */ }
  };
  if (now) return run();
  timers.set(chatId, setTimeout(run, 700));
  return undefined;
}

export function renderTopicBar(el, chat, switchTopic) {
  if (!chat.forum) { el.hidden = true; return; }
  el.hidden = false;
  const admin = chat.my_role === 'owner' || chat.my_role === 'admin';
  const cur = S.topic.get(chat.id) || 0;
  const list = topicsOf(chat.id);
  clear(el).append(...list.map((tp) => {
    const label = tp.id === 0 ? t('topic.general') : `${tp.emoji ? `${tp.emoji} ` : '\u{1F4AC} '}${tp.title}`;
    const chip = h('button', {
      class: `topic-chip${tp.id === cur ? ' on' : ''}${tp.closed ? ' closed' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(tp.id === cur),
      onclick: () => switchTopic(tp.id),
      oncontextmenu: (e) => { if (admin && tp.id) { e.preventDefault(); topicMenu(chip, chat, tp); } },
    }, h('span', { class: 'ellipsis' }, `${tp.closed ? '\u{1F512} ' : ''}${label}`), tp.unread && tp.id !== cur ? h('b', { class: 'topic-badge' }, tp.unread > 99 ? '99+' : String(tp.unread)) : null);
    return chip;
  }), admin ? h('button', { class: 'topic-chip add', type: 'button', 'aria-label': t('topic.new'), onclick: () => openTopicCreate(chat.id) }, '+') : null, ...(admin && cur ? [h('button', { class: 'topic-chip add', type: 'button', 'aria-label': t('topic.edit'), onclick: (e) => { const tp = list.find((x) => x.id === cur); if (tp) topicMenu(e.currentTarget, chat, tp); } }, '⋯')] : []));
}

function topicMenu(anchor, chat, tp) {
  popMenu(anchor, [
    { label: t('topic.rename'), onClick: () => openTopicCreate(chat.id, tp) },
    { label: tp.closed ? t('topic.reopen') : t('topic.close'), onClick: () => api('PATCH', `/api/topics/${tp.id}`, { closed: !tp.closed }).catch((e) => toast(errText(e.code))) },
  ]);
}

export function openTopicCreate(chatId, existing = null) {
  const title = h('input', { class: 'input', maxLength: 40, placeholder: t('topic.title_ph'), 'aria-label': t('topic.title_ph'), value: existing?.title || '' });
  const emoji = h('input', { class: 'input topic-emoji', maxLength: 4, placeholder: '\u{1F4AC}', 'aria-label': t('topic.emoji'), value: existing?.emoji || '' });
  const err = h('div', { class: 'err', role: 'alert' });
  const win = modal({
    title: existing ? t('topic.rename') : t('topic.new'),
    body: [h('div', { class: 'topic-form' }, emoji, title), err, h('button', { class: 'btn', type: 'button', onclick: async () => {
      if (!title.value.trim()) { err.textContent = t('topic.need_title'); return; }
      try {
        if (existing) await api('PATCH', `/api/topics/${existing.id}`, { title: title.value.trim(), emoji: emoji.value.trim() });
        else await api('POST', `/api/chats/${chatId}/topics`, { title: title.value.trim(), emoji: emoji.value.trim() });
        win.close();
      } catch (e) { err.textContent = errText(e.code); }
    } }, t('task.create'))],
  });
  setTimeout(() => title.focus(), 50);
}

on('ws', (ev) => {
  if (ev.type === 'topics.update') refreshTopics(ev.chat_id, true);
});
