// "Договорились": the outcome of a conversation as a card (what was agreed, who is responsible, until when). The people in the chat agree with one tap.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';
import { dueLabel } from './tasks.js';

const nameOf = (id) => (id === S.me.id ? t('task.me') : S.users.get(id)?.name || '');
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
const call = (method, url, body) => api(method, url, body).catch((e) => { toast(errText(e.code)); return null; });

// ---------------------------------------------------------------- the card
export function dealNode(m) {
  const d = m.deal;
  const overdue = !d.done && d.due_at && d.due_at < Date.now();
  const mine = d.agreed.includes(S.me.id);
  const chat = S.chats.get(m.chat_id);
  const canFinish = d.owner_id === S.me.id || d.creator_id === S.me.id || d.owner_id === null || (chat && chat.my_role && chat.my_role !== 'member');
  const bar = h('div', { class: 'deal-bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': String(d.people), 'aria-valuenow': String(d.agreed.length) });
  bar.append(h('i'));
  bar.firstChild.style.width = `${d.people ? Math.min(100, (d.agreed.length / d.people) * 100) : 0}%`;
  return h('div', { class: `deal${d.done ? ' done' : ''}${overdue ? ' overdue' : ''}` },
    h('div', { class: 'deal-head' }, h('span', { class: 'deal-badge' }, `\u{1F91D} ${d.done ? t('deal.done') : t('deal.badge')}`)),
    h('div', { class: 'deal-title' }, d.title),
    h('div', { class: 'deal-meta' },
      h('span', { class: `deal-chip${d.owner_id === S.me.id ? ' me' : ''}` }, `\u{1F464} ${d.owner_id ? nameOf(d.owner_id) : t('deal.everyone')}`),
      d.due_at ? h('span', { class: `deal-chip${overdue ? ' bad' : ''}` }, `⏰ ${dueLabel(d.due_at)}`) : null),
    d.done ? null : h('div', { class: 'deal-agree' }, bar,
      h('small', { class: 'muted' }, t('deal.agreed_n', { n: d.agreed.length, total: d.people }), d.agreed.length ? ` · ${d.agreed.map(nameOf).filter(Boolean).join(', ')}` : '')),
    h('div', { class: 'deal-actions' },
      d.done ? null : h('button', { class: `btn small${mine ? ' secondary' : ''}`, type: 'button', disabled: !!m.pending, onclick: () => call('POST', `/api/deals/${d.id}/agree`, { agree: !mine }) }, mine ? `✓ ${t('deal.i_agree')}` : t('deal.agree')),
      canFinish ? h('button', { class: 'btn small secondary', type: 'button', disabled: !!m.pending, onclick: () => call('POST', `/api/deals/${d.id}/done`, { done: !d.done }) }, d.done ? t('deal.reopen') : t('deal.finish')) : null));
}

// ---------------------------------------------------------------- creation
export function openDealCreate(chatId, source = null) {
  const chat = S.chats.get(chatId);
  const members = (S.members.get(chatId) || []).map((x) => x.user).filter((u) => u && !u.is_bot);
  const title = h('textarea', { class: 'input', rows: 3, maxLength: 300, placeholder: t('deal.title_ph'), 'aria-label': t('deal.title_ph') });
  if (source?.text) title.value = source.text.replace(/\s+/g, ' ').slice(0, 300);
  const who = h('select', { class: 'input', 'aria-label': t('deal.owner') },
    h('option', { value: '' }, t('deal.everyone')),
    h('option', { value: String(S.me.id) }, t('task.me')),
    ...members.filter((u) => u.id !== S.me.id).map((u) => h('option', { value: String(u.id) }, u.name)));
  if (chat?.type === 'direct' && chat.peer && !chat.saved) who.value = String(chat.peer.id);
  const due = h('input', { class: 'input', type: 'datetime-local', 'aria-label': t('deal.due') });
  const setIn = (fn) => { due.value = toLocalInput(fn(new Date())); };
  const at = (days, hour) => (d) => { d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  const quick = h('div', { class: 'task-quick' },
    h('button', { class: 'chip', type: 'button', onclick: () => setIn(at(0, 18)) }, t('task.evening')),
    h('button', { class: 'chip', type: 'button', onclick: () => setIn(at(1, 10)) }, t('task.tomorrow_morning')),
    h('button', { class: 'chip', type: 'button', onclick: () => setIn(at(7, 10)) }, t('task.next_week')),
    h('button', { class: 'chip', type: 'button', onclick: () => { due.value = ''; } }, t('task.no_due')));
  const pin = h('input', { type: 'checkbox', checked: true });
  const err = h('div', { class: 'err', role: 'alert' });
  const win = modal({
    title: t('deal.new'),
    body: [h('p', { class: 'muted' }, t('deal.hint')), title, h('label', { class: 'field' }, h('span', null, t('deal.owner')), who), h('label', { class: 'field' }, h('span', null, t('deal.due')), due), quick,
      h('label', { class: 'row' }, pin, t('deal.pin')), err,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!title.value.trim()) { err.textContent = t('deal.need_title'); return; }
        const ts = due.value ? new Date(due.value).getTime() : null;
        if (ts && ts < Date.now() - 60000) { err.textContent = t('ev.need_future'); return; }
        try {
          const r = await api('POST', `/api/chats/${chatId}/deals`, { title: title.value.trim(), owner_id: who.value ? Number(who.value) : null, due_at: ts });
          if (pin.checked) api('POST', `/api/chats/${chatId}/pin`, { message_id: r.message.id }).catch(() => { /* only admins pin in groups */ });
          win.close();
          toast(t('deal.created'));
        } catch (e) { err.textContent = errText(e.code); }
      } }, t('deal.create'))],
  });
  setTimeout(() => title.focus(), 50);
}
