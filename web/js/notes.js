// Shared notes: a card in the chat and an editor where everybody types into the same text at the same time.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { S, on } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';
import { NoteClient } from './notesync.js';
import { diffOp, shiftCaret } from '../../shared/ot.js';

const nameOf = (id) => (id === S.me.id ? t('task.me') : S.users.get(id)?.name || '');
const sessions = new Map(); // note id -> { client, typing }

// ---------------------------------------------------------------- the card
export function noteNode(m) {
  const n = m.note;
  return h('div', { class: 'note-card' },
    h('div', { class: 'mini-head' }, h('span', { class: 'mini-ico' }, '\u{1F4DD}'), h('b', null, n.title)),
    n.preview ? h('div', { class: 'note-preview' }, n.preview) : h('div', { class: 'note-preview muted' }, t('note.empty')),
    h('div', { class: 'note-foot' },
      h('small', { class: 'muted' }, n.updated_by ? t('note.edited_by', { name: nameOf(n.updated_by) }) : t('note.new_hint')),
      h('button', { class: 'btn small', type: 'button', onclick: () => openNote(n.id, n.title) }, t('note.open'))));
}

export function openNoteCreate(chatId) {
  const title = h('input', { class: 'input', maxLength: 80, placeholder: t('note.title_ph'), 'aria-label': t('note.title_ph') });
  const err = h('div', { class: 'err', role: 'alert' });
  const go = async () => {
    if (!title.value.trim()) { err.textContent = t('note.need_title'); return; }
    try {
      const r = await api('POST', `/api/chats/${chatId}/notes`, { title: title.value.trim() });
      win.close();
      openNote(r.message.note.id, r.message.note.title);
    } catch (e) { err.textContent = errText(e.code); }
  };
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const win = modal({ title: t('note.new'), body: [h('p', { class: 'muted' }, t('note.hint')), title, err, h('button', { class: 'btn', type: 'button', onclick: go }, t('task.create'))] });
  setTimeout(() => title.focus(), 50);
}

// ---------------------------------------------------------------- the editor
export async function openNote(id, title = '') {
  const ta = h('textarea', { class: 'note-text', spellcheck: true, 'aria-label': title || t('note.title_ph'), disabled: true, placeholder: t('note.type_here') });
  const status = h('small', { class: 'muted note-status' }, t('net.connecting'));
  const who = h('small', { class: 'note-who' });
  const win = modal({
    title: title || t('note.title'), className: 'note-editor',
    body: [h('div', { class: 'note-bar' }, status, who, h('a', { class: 'btn secondary small', href: `/api/notes/${id}/export`, download: `${title || 'note'}.txt` }, t('note.download'))), ta],
    onClose: () => { const s = sessions.get(id); if (s && !s.client.inflight && s.client.local === s.client.doc) s.client.stop(); sessions.delete(id); },
  });

  const typing = new Map();
  const showStatus = () => {
    const c = sessions.get(id)?.client;
    status.textContent = !c ? '' : (c.inflight || c.local !== c.doc) ? t('note.saving') : t('note.saved');
    const now = Date.now();
    const names = [...typing.entries()].filter(([, at]) => now - at < 4000).map(([uid]) => nameOf(uid)).filter(Boolean);
    who.textContent = names.length ? `${names.join(', ')} ${t('note.typing')}` : '';
  };

  const client = new NoteClient({
    send: (op) => api('POST', `/api/notes/${id}/op`, op),
    onText: (text) => {
      if (ta.value === text) return;
      // keep the caret where the person is typing while the text changes under it
      const op = diffOp(ta.value, text);
      const [a, b] = [ta.selectionStart, ta.selectionEnd];
      ta.value = text;
      if (op && document.activeElement === ta) ta.setSelectionRange(shiftCaret(a, op), shiftCaret(b, op));
    },
    onResync: async () => {
      try {
        const r = await api('GET', `/api/notes/${id}`);
        client.resync(r.note.body, r.note.rev);
      } catch (e) { toast(errText(e.code)); }
    },
  });
  sessions.set(id, { client });
  let first;
  try { first = (await api('GET', `/api/notes/${id}`)).note; } catch (e) { win.close(); toast(errText(e.code)); return; }
  client.init(first.body, first.rev);
  ta.disabled = false;
  ta.focus();
  ta.addEventListener('input', () => { client.edit(ta.value); showStatus(); });
  const tick = setInterval(() => { if (!ta.isConnected) clearInterval(tick); else showStatus(); }, 800);
  sessions.get(id).typing = typing;
  showStatus();
}

on('ws', (ev) => {
  if (ev.type !== 'note.op') return;
  const s = sessions.get(ev.note_id);
  if (!s) return;
  if (ev.user_id !== S.me.id) s.typing?.set(ev.user_id, Date.now());
  s.client.serverOp({ rev: ev.rev, op: ev.op, cid: ev.cid });
});
