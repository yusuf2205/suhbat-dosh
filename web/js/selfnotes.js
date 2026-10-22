// Notes to myself: the notes that live in my Saved chat, listed and searchable in one place, each with its version history.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { fmtDay, fmtTime, modal, toast } from './ui.js';
import { openNote, openNoteCreate } from './notes.js';

async function savedChatId() {
  const known = [...S.chats.values()].find((c) => c.saved);
  if (known) return known.id;
  const r = await api('POST', '/api/chats/saved');
  S.chats.set(r.chat.id, r.chat);
  fire('chats');
  return r.chat.id;
}

export function openSelfNotes() {
  const search = h('input', { class: 'input', type: 'search', placeholder: t('sn.search'), 'aria-label': t('sn.search') });
  const list = h('div', { class: 'sn-list', role: 'list' });
  let timer = 0;
  const load = async () => {
    let r;
    try { r = await api('GET', `/api/notes/mine?q=${encodeURIComponent(search.value.trim())}`); } catch (e) { toast(errText(e.code)); return; }
    clear(list);
    if (!r.notes.length) { list.append(h('p', { class: 'muted', style: { textAlign: 'center', padding: '24px 8px' } }, search.value ? t('sn.none_found') : t('sn.empty'))); return; }
    list.append(...r.notes.map((n) => h('button', { class: 'list-item clickable sn-row', type: 'button', role: 'listitem', onclick: () => { openNote(n.id, n.title); } },
      h('span', { class: 'grow' }, h('b', null, n.title), h('br'), h('span', { class: 'muted sn-preview' }, n.preview || t('note.empty'))),
      h('small', { class: 'muted' }, `${fmtDay(n.updated_at)} ${fmtTime(n.updated_at)}`))));
  };
  search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 200); });
  const win = modal({
    title: t('sn.title'), className: 'sn-modal',
    body: [h('p', { class: 'muted' }, t('sn.hint')), search,
      h('button', { class: 'btn', type: 'button', style: { width: '100%', margin: '8px 0' }, onclick: async () => {
        try { const id = await savedChatId(); win.close(); openNoteCreate(id); } catch (e) { toast(errText(e.code)); }
      } }, `+ ${t('sn.new')}`), list],
  });
  load();
  return win;
}
