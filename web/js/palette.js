// Quick search and commands (Ctrl+K, or pull the chat list down on a phone): one field to open a chat or a person,
// find a message, or run an action, all from the keyboard.
import { h, clear, debounce } from './dom.js';
import { t } from './i18n.js';
import { S, chatTitle, fire } from './state.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { avatar, modal, previewText } from './ui.js';

const lazy = (path, fn, ...args) => async () => { const m = await import(path); return m[fn](...args); };
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');

/** Every token of the query must appear; earlier and word-start matches rank higher. 0 = no match. */
export function score(query, text) {
  const q = norm(query).split(/\s+/).filter(Boolean);
  const s = norm(text);
  if (!q.length) return 1;
  let total = 0;
  for (const tok of q) {
    const i = s.indexOf(tok);
    if (i < 0) return 0;
    total += 10 - Math.min(8, i / 4) + (i === 0 || s[i - 1] === ' ' ? 6 : 0);
  }
  return total / q.length;
}

function actions() {
  const c = S.active ? S.chats.get(S.active) : null;
  const list = [
    ['menu.new_chat', 'compose', lazy('./dialogs.js', 'openNewChat')],
    ['menu.new_group', 'users', lazy('./dialogs.js', 'openNewGroup', 'group')],
    ['menu.new_channel', 'chat', lazy('./dialogs.js', 'openNewGroup', 'channel')],
    ['task.title', 'tasks', lazy('./tasks.js', 'openTasks')],
    ['sn.title', 'edit', lazy('./selfnotes.js', 'openSelfNotes')],
    ['focus.title', 'moon', lazy('./focus.js', 'openFocus')],
    ['digest.all_title', 'list', lazy('./digest.js', 'openDigestAll')],
    ['room.title_all', 'speaker', lazy('./rooms.js', 'openRooms')],
    ['ev.calendar', 'clock', lazy('./events.js', 'openCalendar')],
    ['drive.title', 'folder', lazy('./drive.js', 'openDrive')],
    ['gsearch.title', 'search', lazy('./extras.js', 'openGlobalSearch')],
    ['nav.saved', 'bookmark', lazy('./rail.js', 'openSaved')],
    ['nav.settings', 'settings', lazy('./dialogs.js', 'openSettings')],
    ['imp.title', 'telegram', lazy('./import.js', 'openImport')],
    ['scan.title', 'qr', lazy('./scanner.js', 'openScanner')],
    ['st.storage', 'disk', lazy('./storage.js', 'openStorage')],
    ['quick.title', 'chat', lazy('./quick.js', 'openQuickManager')],
    ['dir.title', 'globe', lazy('./directory.js', 'openDirectory')],
    ['acc.title', 'user', lazy('./accounts.js', 'openAccounts')],
    ['bk.title', 'download', lazy('./backup.js', 'openBackup')],
  ];
  if (c) {
    list.unshift(
      ['chat.info', 'info', lazy('./chat.js', 'toggleInfo')],
      ['task.new', 'tasks', lazy('./tasks.js', 'openTaskCreate', c.id)],
      ['note.new', 'edit', lazy('./notes.js', 'openNoteCreate', c.id)],
      ['digest.title', 'list', lazy('./digest.js', 'openDigest', c.id)],
    );
  }
  return list.map(([key, ico, run]) => ({ type: 'action', label: t(key), ico, run }));
}

export function openPalette() {
  if (document.querySelector('.palette')) return;
  const input = h('input', { class: 'input pal-input', type: 'search', placeholder: t('pal.placeholder'), 'aria-label': t('pal.placeholder'), autocomplete: 'off', spellcheck: false });
  const list = h('div', { class: 'pal-list', role: 'listbox' });
  const win = modal({ title: t('pal.title'), className: 'palette', bare: true, body: [input, list, h('div', { class: 'pal-hint muted' }, t('pal.hint'))] });
  let items = [];
  let sel = 0;
  let remote = [];
  let seq = 0;

  const run = async (it) => { win.close(); await it.run(); };
  const draw = () => {
    clear(list);
    items.forEach((it, i) => {
      list.append(h('button', { class: `pal-item${i === sel ? ' sel' : ''}`, type: 'button', role: 'option', 'aria-selected': String(i === sel), onclick: () => run(it), onmousemove: () => { if (sel !== i) { sel = i; mark(); } } },
        it.avatar ?? h('span', { class: 'pal-ico' }, icon(it.ico || 'chat', 20)),
        h('span', { class: 'pal-main' }, h('b', { class: 'ellipsis' }, it.label), it.sub ? h('small', { class: 'muted ellipsis' }, it.sub) : null),
        h('span', { class: 'pal-kind muted' }, it.kind || '')));
    });
    if (!items.length) list.append(h('p', { class: 'muted pal-empty' }, t('list.nothing')));
  };
  const mark = () => { [...list.children].forEach((el, i) => { el.classList.toggle('sel', i === sel); el.setAttribute('aria-selected', String(i === sel)); }); list.children[sel]?.scrollIntoView({ block: 'nearest' }); };

  function build() {
    const raw = input.value.trim();
    const mode = raw[0] === '>' ? 'act' : raw[0] === '@' ? 'people' : '';
    const term = mode ? raw.slice(1).trim() : raw;
    const out = [];
    if (mode !== 'people') {
      for (const a of actions()) { const s = score(term, a.label); if (s) out.push({ ...a, kind: t('pal.action'), s: s + (mode === 'act' ? 5 : -2) }); }
    }
    if (mode !== 'act') {
      for (const c of S.chats.values()) {
        if (c.secret && !c.peer && !c.title) continue;
        const title = chatTitle(c);
        const s = score(term, title);
        if (!s) continue;
        out.push({
          type: 'chat', label: title, sub: c.last_message ? previewText(c.last_message).slice(0, 60) : '', kind: c.type === 'direct' ? t('pal.person') : c.type === 'group' ? t('pal.group') : t('pal.channel'),
          avatar: avatar(c.type === 'direct' ? c.peer : { id: c.id, name: c.title }, 'sm'), s: s + 4 + (c.unread ? 3 : 0) + Math.min(3, (c.last_message_at || 0) / 1e13),
          run: () => fire('open-chat', c.id),
        });
      }
      if (mode === 'people' || term.length >= 2) {
        const have = new Set(out.filter((x) => x.type === 'chat' && x.label).map((x) => x.label));
        for (const u of S.users.values()) {
          if (u.id === S.me.id || u.is_bot || have.has(u.name)) continue;
          const s = score(term, `${u.name} ${u.username || ''}`);
          if (s && term) out.push({ type: 'person', label: u.name, sub: u.username ? `@${u.username}` : '', kind: t('pal.person'), avatar: avatar(u, 'sm'), s,
            run: async () => { const d = await import('./dialogs.js'); const r = await api('POST', '/api/chats/direct', { user_id: u.id }); S.chats.set(r.chat.id, r.chat); fire('chats'); fire('open-chat', r.chat.id); void d; } });
        }
      }
      for (const m of remote) out.push(m);
    }
    out.sort((a, b) => b.s - a.s);
    items = out.slice(0, 40);
    sel = Math.min(sel, Math.max(0, items.length - 1));
    draw();
  }

  const search = debounce(async () => {
    const raw = input.value.trim();
    const term = raw[0] === '>' || raw[0] === '@' ? '' : raw;
    const mine = ++seq;
    if (term.length < 3) { if (remote.length) { remote = []; build(); } return; }
    try {
      const r = await api('GET', `/api/search/global?q=${encodeURIComponent(term)}`);
      let meaning = [];
      if (S.cfg?.semantic && term.length >= 4) {
        // by meaning: messages that say the same in other words (only close ones; they are marked)
        try {
          const sr = await api('GET', `/api/search/semantic?q=${encodeURIComponent(term)}`);
          const best = sr.results[0]?.score || 0;
          const have = new Set(r.results.map((x) => x.message.id));
          meaning = sr.results.filter((x) => x.score >= Math.max(0.82, best - 0.04) && !have.has(x.message.id)).slice(0, 4);
        } catch { /* the usual results stay */ }
      }
      if (mine !== seq) return;
      remote = [...r.results.slice(0, 6).map((x) => ({ x, sem: false })), ...meaning.map((x) => ({ x, sem: true }))].map(({ x, sem }, i) => ({
        type: 'message', label: previewText(x.message).slice(0, 90), sub: `${x.chat_title}${x.sender_name && x.chat_type !== 'direct' ? ` · ${x.sender_name}` : ''}`,
        kind: sem ? `\u2728 ${t('sem.kind')}` : t('pal.message'), ico: sem ? 'bolt' : 'search', s: (sem ? 0.5 : 1) - i / 100,
        run: () => { fire('open-chat', x.message.chat_id); setTimeout(() => fire('jump', { chatId: x.message.chat_id, msgId: x.message.id }), 80); },
      }));
      build();
    } catch { /* the local part stays */ }
  }, 260);

  input.addEventListener('input', () => { sel = 0; build(); search(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(items.length - 1, sel + 1); mark(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); mark(); }
    else if (e.key === 'Enter' && items[sel]) { e.preventDefault(); run(items[sel]); }
  });
  build();
  setTimeout(() => input.focus(), 30);
}

/** Phone: pull the chat list down from its very top. */
export function wirePullDown() {
  let start = null;
  document.addEventListener('touchstart', (e) => {
    const list = e.target.closest?.('.chatlist');
    start = list && list.scrollTop <= 0 && e.touches.length === 1 ? { y: e.touches[0].clientY, x: e.touches[0].clientX, list } : null;
  }, { passive: true });
  document.addEventListener('touchmove', (e) => {
    if (!start) return;
    const dy = e.touches[0].clientY - start.y;
    const dx = Math.abs(e.touches[0].clientX - start.x);
    if (dy > 110 && dx < 50 && start.list.scrollTop <= 0) { start = null; openPalette(); }
  }, { passive: true });
  document.addEventListener('touchend', () => { start = null; }, { passive: true });
}
