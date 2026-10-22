// Mini-apps in a chat message: a shared checklist and an expense splitter.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { modal, toast } from './ui.js';

const nameOf = (id) => S.users.get(id)?.name || (id === S.me.id ? S.me.name : t('mini.someone'));
const op = (app, body) => api('POST', `/api/mini/${app.id}/op`, body).catch((e) => toast(errText(e.code)));
const money = (n, cur) => `${(n / 100).toLocaleString(undefined, { minimumFractionDigits: n % 100 ? 2 : 0, maximumFractionDigits: 2 })} ${cur}`;

// ---------------------------------------------------------------- creation
export function openMiniCreate(chatId) {
  let type = 'checklist';
  const title = h('input', { class: 'input', maxLength: 80, 'aria-label': t('mini.title_ph') });
  const err = h('div', { class: 'err', role: 'alert' });
  const tabs = h('div', { class: 'poll-tabs' });
  const build = () => {
    clear(tabs).append(...['checklist', 'expenses'].map((k) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(type === k), onclick: () => { type = k; build(); } }, t(`mini.k_${k}`))));
    title.placeholder = type === 'checklist' ? t('mini.ph_checklist') : t('mini.ph_expenses');
  };
  build();
  const m = modal({
    title: t('mini.new'),
    body: [tabs, h('p', { class: 'muted' }, t('mini.hint')), title, err,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!title.value.trim()) { err.textContent = t('mini.need_title'); return; }
        try { await api('POST', `/api/chats/${chatId}/mini`, { type, title: title.value.trim() }); m.close(); } catch (e) { err.textContent = errText(e.code); }
      } }, t('chat.send'))],
  });
  setTimeout(() => title.focus(), 50);
}

// ---------------------------------------------------------------- the card
export function miniNode(m) {
  const app = m.mini;
  return app.type === 'checklist' ? checklistNode(m, app) : expensesNode(m, app);
}

function checklistNode(m, app) {
  const items = app.data.items || [];
  const done = items.filter((x) => x.done).length;
  const input = h('input', { class: 'input', maxLength: 200, placeholder: t('mini.add_item'), 'aria-label': t('mini.add_item') });
  const add = async () => {
    const v = input.value.trim();
    if (!v) return;
    input.value = '';
    await op(app, { op: 'add', text: v });
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  const bar = h('i');
  queueMicrotask(() => { bar.style.width = `${items.length ? Math.round((done / items.length) * 100) : 0}%`; });
  const rows = items.map((it) => h('div', { class: `mini-item${it.done ? ' done' : ''}` },
    h('label', { class: 'mini-check' },
      h('input', { type: 'checkbox', checked: it.done, disabled: !!m.pending, onchange: () => op(app, { op: 'toggle', item: it.id }) }),
      h('span', { class: 'mini-text' }, it.text)),
    h('small', { class: 'muted mini-by' }, it.done && it.done_by ? `✓ ${nameOf(it.done_by)}` : nameOf(it.by)),
    it.by === S.me.id || app.creator_id === S.me.id
      ? h('button', { class: 'icon-btn mini-x', type: 'button', 'aria-label': t('common.delete'), onclick: () => op(app, { op: 'remove', item: it.id }) }, icon('close', 14)) : null));
  return h('div', { class: 'mini' },
    h('div', { class: 'mini-head' }, h('span', { class: 'mini-ico' }, '✅'), h('b', null, app.title), h('small', { class: 'muted' }, `${done}/${items.length}`)),
    items.length ? h('div', { class: 'mini-bar' }, bar) : null,
    ...rows,
    h('div', { class: 'mini-add' }, input, h('button', { class: 'btn small', type: 'button', onclick: add }, '+')),
    done && app.creator_id === S.me.id ? h('button', { class: 'btn link', type: 'button', onclick: () => op(app, { op: 'clear_done' }) }, t('mini.clear_done')) : null);
}

/** Who owes whom: balances (paid minus own share), then settle greedily with the fewest transfers. */
export function settle(expenses) {
  const bal = new Map();
  for (const e of expenses) {
    const share = Math.floor(e.amount / e.split.length);
    let rest = e.amount - share * e.split.length; // the odd tiyin goes to the first people
    bal.set(e.payer, (bal.get(e.payer) || 0) + e.amount);
    for (const u of e.split) {
      const extra = rest > 0 ? 1 : 0;
      rest -= extra;
      bal.set(u, (bal.get(u) || 0) - share - extra);
    }
  }
  const debtors = [...bal].filter(([, v]) => v < 0).map(([id, v]) => [id, -v]).sort((a, b) => b[1] - a[1]);
  const creditors = [...bal].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const moves = [];
  let i = 0;
  let j = 0;
  while (i < debtors.length && j < creditors.length) {
    const pay = Math.min(debtors[i][1], creditors[j][1]);
    if (pay > 0) moves.push({ from: debtors[i][0], to: creditors[j][0], amount: pay });
    debtors[i][1] -= pay;
    creditors[j][1] -= pay;
    if (debtors[i][1] === 0) i += 1;
    if (creditors[j][1] === 0) j += 1;
  }
  return { balances: bal, moves };
}

function expensesNode(m, app) {
  const cur = app.data.currency || 'UZS';
  const list = app.data.expenses || [];
  const total = list.reduce((a, e) => a + e.amount, 0);
  const { moves } = settle(list);
  const title = h('input', { class: 'input', maxLength: 60, placeholder: t('mini.exp_what'), 'aria-label': t('mini.exp_what') });
  const amount = h('input', { class: 'input', type: 'number', min: '0', step: '0.01', inputMode: 'decimal', placeholder: t('mini.exp_sum'), 'aria-label': t('mini.exp_sum') });
  const add = async () => {
    const v = Math.round(Number(amount.value) * 100);
    if (!title.value.trim() || !Number.isFinite(v) || v < 1) { toast(t('mini.exp_need')); return; }
    const t0 = title.value.trim();
    title.value = '';
    amount.value = '';
    await op(app, { op: 'add', title: t0, amount: v, split: 'all' });
  };
  amount.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
  return h('div', { class: 'mini' },
    h('div', { class: 'mini-head' }, h('span', { class: 'mini-ico' }, '\u{1F4B8}'), h('b', null, app.title), h('small', { class: 'muted' }, money(total, cur))),
    ...list.map((e) => h('div', { class: 'mini-item' },
      h('div', { class: 'mini-text' }, h('span', null, e.title), h('small', { class: 'muted' }, `${nameOf(e.payer)} · ${e.split.length} ${t('mini.people')}`)),
      h('b', { class: 'mini-sum' }, money(e.amount, cur)),
      e.by === S.me.id || app.creator_id === S.me.id
        ? h('button', { class: 'icon-btn mini-x', type: 'button', 'aria-label': t('common.delete'), onclick: () => op(app, { op: 'remove', item: e.id }) }, icon('close', 14)) : null)),
    h('div', { class: 'mini-add' }, title, amount, h('button', { class: 'btn small', type: 'button', onclick: add }, '+')),
    list.length ? h('div', { class: 'mini-settle' }, h('b', null, t('mini.settle')),
      ...(moves.length ? moves.map((mv) => h('div', { class: 'mini-move' }, `${nameOf(mv.from)} → ${nameOf(mv.to)}: `, h('b', null, money(mv.amount, cur)))) : [h('div', { class: 'muted' }, t('mini.all_even'))])) : null);
}
