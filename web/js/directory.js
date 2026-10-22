// Directory of public channels, groups and bots: search, join with one tap, start a chat with a bot.
import { h, clear, debounce } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { avatar, modal, toast } from './ui.js';

const KINDS = ['channel', 'group', 'bot'];

export function openDirectory() {
  let kind = 'channel';
  const q = h('input', { class: 'input', type: 'search', placeholder: t('dir.search'), 'aria-label': t('dir.search') });
  const tabs = h('div', { class: 'poll-tabs', role: 'tablist' });
  const list = h('div', { class: 'dir-list' });
  const win = modal({ title: t('dir.title'), className: 'drive', body: [q, tabs, list] });
  let seq = 0;

  const drawTabs = () => clear(tabs).append(...KINDS.map((k) => h('button', { class: 'chip', type: 'button', role: 'tab', 'aria-pressed': String(k === kind), onclick: () => { kind = k; drawTabs(); load(); } }, t(`dir.k_${k}`))));

  const load = async () => {
    const mine = ++seq;
    clear(list).append(h('p', { class: 'muted' }, t('list.loading')));
    let r;
    try { r = await api('GET', `/api/directory?kind=${kind}&q=${encodeURIComponent(q.value.trim())}`); } catch (e) { clear(list).append(h('p', { class: 'err' }, errText(e.code))); return; }
    if (mine !== seq) return;
    clear(list);
    if (!r.items.length) { list.append(h('p', { class: 'muted drive-empty' }, t(kind === 'bot' ? 'dir.none_bots' : 'dir.none'))); return; }
    for (const it of r.items) {
      const btn = kind === 'bot'
        ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
          try {
            const c = (await api('POST', '/api/chats/direct', { user_id: it.id })).chat;
            S.chats.set(c.id, c); fire('chats'); win.close(); fire('open-chat', c.id);
          } catch (e) { toast(errText(e.code)); }
        } }, t('dir.start'))
        : h('button', { class: `btn small${it.joined ? ' secondary' : ''}`, type: 'button', onclick: async () => {
          try {
            const c = (await api('POST', `/api/directory/${it.id}/join`)).chat;
            S.chats.set(c.id, c); fire('chats'); win.close(); fire('open-chat', c.id);
          } catch (e) { toast(errText(e.code)); }
        } }, it.joined ? t('dir.open') : t('dir.join'));
      list.append(h('div', { class: 'dir-row' },
        avatar(kind === 'bot' ? { id: it.id, name: it.name } : { id: it.id, name: it.title }, 'sm'),
        h('div', { class: 'dir-main' },
          h('b', { class: 'ellipsis' }, kind === 'bot' ? it.name : it.title),
          h('small', { class: 'muted' }, kind === 'bot' ? [it.username ? `@${it.username}` : '', ...it.commands.map((c) => `/${c.command || c}`)].filter(Boolean).join(' ') : `${it.members} ${t(kind === 'channel' ? 'chat.subscribers' : 'chat.members')}`),
          it.description ? h('span', { class: 'dir-desc' }, it.description) : null),
        btn));
    }
  };
  q.addEventListener('input', debounce(load, 250));
  drawTabs();
  load();
  setTimeout(() => q.focus(), 40);
}
