// "Сводка дня": a short list of things to do (not a retelling of the chats): who waits for an answer, what is due, what to confirm, what is on today.
import { h, clear } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { S, fire, chatTitle } from './state.js';
import { api } from './net.js';
import { modal, toast, previewText } from './ui.js';
import { dueLabel } from './tasks.js';

const loc = () => (getLang() === 'uz' ? 'uz-UZ' : 'ru-RU');

/** "ждёт 3 ч", "ждёт 2 дня" */
function waitLabel(at) {
  const min = Math.max(1, Math.round((Date.now() - at) / 60000));
  if (min < 60) return t('today.wait_min', { n: min });
  const hrs = Math.round(min / 60);
  if (hrs < 24) return t('today.wait_h', { n: hrs });
  return t('today.wait_d', { n: Math.round(hrs / 24) });
}

let timer = null;
/** The number on the button: how many things wait. Refreshed now and then. */
export async function refreshToday() {
  try { S.todayCount = (await api('GET', '/api/today')).count; } catch { return; }
  fire('today');
}
export function startToday() {
  refreshToday();
  clearInterval(timer);
  timer = setInterval(refreshToday, 5 * 60_000);
}

export async function openToday() {
  const body = h('div', { class: 'today' }, h('p', { class: 'muted' }, t('net.connecting')));
  const win = modal({ title: t('today.title'), className: 'drive', body: [body] });
  const go = (chatId, messageId) => {
    win.close();
    // jumpTo opens the chat itself; opening it twice at once leaves the list "detached" and new messages stop appearing
    if (messageId) import('./chat.js').then((c) => c.jumpTo(chatId, messageId));
    else fire('open-chat', chatId);
  };
  const chatName = (id) => (S.chats.get(id) ? chatTitle(S.chats.get(id)) : '');
  const section = (titleKey, rows) => (rows.length ? [h('h3', null, t(titleKey)), ...rows] : []);
  const row = (main, sub, actions = []) => h('div', { class: 'today-row' }, main, sub ? h('small', { class: 'muted ellipsis' }, sub) : null, actions.length ? h('div', { class: 'today-actions' }, ...actions) : null);
  async function load() {
    let r;
    try { r = await api('GET', '/api/today'); } catch (e) { win.close(); toast(errText(e.code)); return; }
    S.todayCount = r.count;
    fire('today');
    clear(body);
    if (!r.count) { body.append(h('p', { class: 'muted drive-empty' }, `☀️ ${t('today.empty')}`)); return; }
    body.append(
      ...section('today.waiting', r.waiting.map((w) => row(
        h('button', { class: 'today-main', type: 'button', onclick: () => go(w.chat_id, w.message_id) }, h('b', { class: 'ellipsis' }, chatName(w.chat_id) || '…'), h('span', { class: 'today-wait' }, waitLabel(w.at))),
        w.kind === 'text' ? w.text : previewText({ kind: w.kind, text: w.text })))),
      ...section('today.tasks', r.tasks.map((k) => row(
        h('button', { class: 'today-main', type: 'button', onclick: () => go(k.chat_id, k.message_id) }, h('b', { class: 'ellipsis' }, k.title), h('span', { class: `today-wait${k.due_at < Date.now() ? ' bad' : ''}` }, dueLabel(k.due_at))),
        chatName(k.chat_id),
        [h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { await api('POST', `/api/tasks/${k.id}/toggle`, { done: true }).catch((e) => toast(errText(e.code))); load(); } }, t('today.done'))]))),
      ...section('today.deals', r.deals.map((d) => row(
        h('button', { class: 'today-main', type: 'button', onclick: () => go(d.chat_id, d.message_id) }, h('b', { class: 'ellipsis' }, `\u{1F91D} ${d.title}`), d.due_at ? h('span', { class: `today-wait${d.due_at < Date.now() ? ' bad' : ''}` }, dueLabel(d.due_at)) : null),
        chatName(d.chat_id),
        [h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { await api('POST', `/api/deals/${d.id}/done`, { done: true }).catch((e) => toast(errText(e.code))); load(); } }, t('today.done'))]))),
      ...section('today.confirm', r.confirm.map((d) => row(
        h('button', { class: 'today-main', type: 'button', onclick: () => go(d.chat_id, d.message_id) }, h('b', { class: 'ellipsis' }, `\u{1F91D} ${d.title}`), d.due_at ? h('span', { class: 'today-wait' }, dueLabel(d.due_at)) : null),
        chatName(d.chat_id),
        [h('button', { class: 'btn small', type: 'button', onclick: async () => { await api('POST', `/api/deals/${d.id}/agree`, { agree: true }).catch((e) => toast(errText(e.code))); load(); } }, t('deal.agree'))]))),
      ...section('today.events', r.events.map((ev) => row(
        h('button', { class: 'today-main', type: 'button', onclick: () => go(ev.chat_id, ev.message_id) }, h('b', { class: 'ellipsis' }, `\u{1F4C5} ${ev.title}`), h('span', { class: 'today-wait' }, new Date(ev.start_at).toLocaleString(loc(), { weekday: 'short', hour: '2-digit', minute: '2-digit' }))),
        chatName(ev.chat_id)))));
  }
  load();
}
