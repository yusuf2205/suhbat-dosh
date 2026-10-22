// Tasks: a card in the chat (checkbox, assignee, due time), a creation dialog (also from any message) and "My tasks".
import { h, clear } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { S, fire, on, chatTitle } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';

const loc = () => (getLang() === 'uz' ? 'uz-UZ' : 'ru-RU');
const nameOf = (id) => (id === S.me.id ? t('task.me') : S.users.get(id)?.name || '');
const pad = (n) => String(n).padStart(2, '0');
const toLocalInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

export function dueLabel(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const dayDiff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  const time = d.toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
  if (dayDiff === 0) return `${t('task.today')}, ${time}`;
  if (dayDiff === 1) return `${t('task.tomorrow')}, ${time}`;
  return `${d.toLocaleDateString(loc(), { day: 'numeric', month: 'short' })}, ${time}`;
}

const call = (method, url, body) => api(method, url, body).catch((e) => { toast(errText(e.code)); return null; });

// ---------------------------------------------------------------- the card
export function taskNode(m) {
  const k = m.task;
  const overdue = !k.done && k.due_at && k.due_at < Date.now();
  const toggle = h('input', {
    type: 'checkbox', checked: k.done, disabled: !!m.pending, 'aria-label': k.title,
    onchange: () => call('POST', `/api/tasks/${k.id}/toggle`, { done: toggle.checked }),
  });
  return h('div', { class: `task${k.done ? ' done' : ''}${overdue ? ' overdue' : ''}` },
    h('label', { class: 'task-main' }, toggle, h('span', { class: 'task-title' }, k.title)),
    h('div', { class: 'task-meta' },
      k.assignee_id ? h('span', { class: `task-chip${k.assignee_id === S.me.id ? ' me' : ''}` }, `\u{1F464} ${nameOf(k.assignee_id)}`) : h('span', { class: 'task-chip' }, t('task.anyone')),
      k.due_at ? h('span', { class: `task-chip${overdue ? ' bad' : ''}` }, `⏰ ${dueLabel(k.due_at)}`) : null,
      k.done && k.done_by ? h('span', { class: 'task-chip ok' }, `✓ ${nameOf(k.done_by)}`) : null));
}

// ---------------------------------------------------------------- creation (also "make a task of this message")
export function openTaskCreate(chatId, source = null) {
  const chat = S.chats.get(chatId);
  const members = (S.members.get(chatId) || []).map((x) => x.user).filter((u) => u && !u.is_bot);
  const title = h('input', { class: 'input', maxLength: 200, placeholder: t('task.title_ph'), 'aria-label': t('task.title_ph'), value: source?.text ? source.text.replace(/\s+/g, ' ').slice(0, 200) : '' });
  const who = h('select', { class: 'input', 'aria-label': t('task.assignee') },
    h('option', { value: '' }, t('task.anyone')),
    h('option', { value: String(S.me.id) }, t('task.me')),
    ...members.filter((u) => u.id !== S.me.id).map((u) => h('option', { value: String(u.id) }, u.name)));
  // in a conversation with one person the likely answer is "that person", or "me" in Saved messages
  if (chat?.saved) who.value = String(S.me.id);
  else if (chat?.type === 'direct' && chat.peer) who.value = String(chat.peer.id);
  const due = h('input', { class: 'input', type: 'datetime-local', 'aria-label': t('task.due') });
  const quick = h('div', { class: 'task-quick' });
  const setIn = (fn) => { const d = fn(new Date()); due.value = toLocalInput(d); };
  const at = (days, hour) => (d) => { d.setDate(d.getDate() + days); d.setHours(hour, 0, 0, 0); return d; };
  quick.append(
    h('button', { class: 'chip', type: 'button', onclick: () => setIn((d) => new Date(d.getTime() + 3600_000)) }, t('task.in_hour')),
    h('button', { class: 'chip', type: 'button', onclick: () => setIn(at(0, 18)) }, t('task.evening')),
    h('button', { class: 'chip', type: 'button', onclick: () => setIn(at(1, 10)) }, t('task.tomorrow_morning')),
    h('button', { class: 'chip', type: 'button', onclick: () => setIn(at(7, 10)) }, t('task.next_week')),
    h('button', { class: 'chip', type: 'button', onclick: () => { due.value = ''; } }, t('task.no_due')));
  const err = h('div', { class: 'err', role: 'alert' });
  const win = modal({
    title: t('task.new'),
    body: [title, h('label', { class: 'field' }, h('span', null, t('task.assignee')), who), h('label', { class: 'field' }, h('span', null, t('task.due')), due), quick, err,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!title.value.trim()) { err.textContent = t('task.need_title'); return; }
        const ts = due.value ? new Date(due.value).getTime() : null;
        if (ts && ts < Date.now() - 60000) { err.textContent = t('ev.need_future'); return; }
        try {
          await api('POST', `/api/chats/${chatId}/tasks`, { title: title.value.trim(), assignee_id: who.value ? Number(who.value) : null, due_at: ts, source_id: source?.id ?? undefined });
          win.close();
          toast(t('task.created'));
        } catch (e) { err.textContent = errText(e.code); }
      } }, t('task.create'))],
  });
  setTimeout(() => title.focus(), 50);
}

// ---------------------------------------------------------------- "My tasks"
const TABS = ['mine', 'given', 'free', 'done'];
export async function openTasks() {
  let tab = 'mine';
  const tabs = h('div', { class: 'poll-tabs task-tabs', role: 'tablist' });
  const list = h('div', { class: 'task-list' });
  const win = modal({ title: t('task.title'), className: 'drive', body: [tabs, list] });
  const load = async () => {
    clear(tabs).append(...TABS.map((k) => h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-pressed': String(tab === k), onclick: () => { tab = k; load(); } }, t(`task.tab_${k}`))));
    clear(list).append(h('p', { class: 'muted' }, t('net.connecting')));
    const r = await call('GET', `/api/tasks?scope=${tab}`);
    clear(list);
    if (!r) return;
    if (!r.tasks.length) { list.append(h('p', { class: 'muted drive-empty' }, t(`task.none_${tab}`))); return; }
    for (const k of r.tasks) {
      const overdue = !k.done && k.due_at && k.due_at < Date.now();
      list.append(h('div', { class: `task-row${k.done ? ' done' : ''}${overdue ? ' overdue' : ''}` },
        h('input', { type: 'checkbox', checked: k.done, 'aria-label': k.title, onchange: async (e) => { await call('POST', `/api/tasks/${k.id}/toggle`, { done: e.target.checked }); load(); } }),
        h('button', { class: 'task-row-main', type: 'button', onclick: () => {
          win.close();
          fire('open-chat', k.chat_id);
          import('./chat.js').then((c) => c.jumpTo(k.chat_id, k.message_id));
        } },
        h('b', { class: 'ellipsis' }, k.title),
        h('small', { class: 'muted ellipsis' }, [k.chat_id && (S.chats.get(k.chat_id) ? chatTitle(S.chats.get(k.chat_id)) : k.chat_title), k.assignee_id && k.assignee_id !== S.me.id ? nameOf(k.assignee_id) : '', k.due_at ? dueLabel(k.due_at) : ''].filter(Boolean).join(' · ')))));
    }
  };
  load();
}

// ---------------------------------------------------------------- counter for the rail
export async function refreshTaskCount() {
  try { S.taskCount = await api('GET', '/api/tasks/count'); } catch { return; }
  fire('tasks');
}
on('ws', (ev) => {
  if ((ev.type === 'message.new' || ev.type === 'message.update') && ev.message?.kind === 'task') refreshTaskCount();
});
