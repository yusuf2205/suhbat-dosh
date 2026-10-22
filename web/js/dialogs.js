import { showQr } from './qr.js';
import { LIMITS, PRIVACY_VALUES } from '/shared/contracts.js';
import { h, clear, debounce, uuid } from './dom.js';
import { t, errText, LANGS, getLang } from './i18n.js';
import { S, fire, savePrefs, chatTitle, isMuted } from './state.js';
import { icon } from './icons.js';
import { api } from './net.js';
import { avatar, confirmDialog, fmtLastSeen, modal, popMenu, previewText, toast } from './ui.js';
import { openFolders, quietSettings } from './extras.js';
import { updatesSection } from './updates.js';
import { openMediaPanel, storageSection } from './viewer.js';
import { callSettingsSection, startCall } from './call.js';

const fail = (e) => toast(errText(e.code));

// ---------------------------------------------------------------- people search (shared)
function userPicker({ onPick, exclude = new Set(), placeholder = t('new.search_ph') }) {
  const results = h('div', { role: 'list' });
  const hint = h('div', { class: 'muted', style: { padding: '6px 2px' } }, t('new.hint_min'));
  const input = h('input', { class: 'input', type: 'search', placeholder, 'aria-label': placeholder });
  const run = debounce(async () => {
    const term = input.value.trim();
    clear(results);
    hint.hidden = term.length >= 2;
    if (term.length < 2) return;
    try {
      const r = await api('GET', `/api/users/search?q=${encodeURIComponent(term)}`);
      if (input.value.trim() !== term) return;
      const users = r.users.filter((u) => !exclude.has(u.id));
      if (!users.length) results.append(h('div', { class: 'empty' }, t('list.nothing')));
      for (const u of users) {
        results.append(h('button', { class: 'list-item clickable', type: 'button', role: 'listitem', onclick: () => onPick(u) },
          avatar(u, 'sm'), h('span', { class: 'grow' }, h('b', null, u.name), h('br'), h('span', { class: 'muted' }, u.username ? `@${u.username}` : ''))));
      }
    } catch (e) { fail(e); }
  }, 300);
  input.addEventListener('input', run);
  return { el: h('div', null, input, hint, results), input };
}

async function openDirect(user) {
  try {
    if (await openSecretByDefault(user)) return;
    const r = await api('POST', '/api/chats/direct', { user_id: user.id });
    S.chats.set(r.chat.id, r.chat);
    fire('chats');
    fire('open-chat', r.chat.id);
  } catch (e) { fail(e); }
}

export function openNewChat() {
  const m = modal({ title: t('new.title'), body: [] });
  const picker = userPicker({ onPick: async (u) => { m.close(); await openDirect(u); } });
  m.setBody(picker.el, h('button', { class: 'btn secondary', type: 'button', style: { width: '100%', marginTop: '12px' }, onclick: () => { m.close(); openBotFather(); } }, `🤖 ${t('bots.father')}`));
  picker.input.focus();
}

export function openNewGroup(type) {
  const chosen = new Map();
  const title = h('input', { class: 'input', placeholder: t('new.title_ph'), maxLength: LIMITS.TITLE_MAX, 'aria-label': t('new.title_ph') });
  const desc = h('textarea', { class: 'input', placeholder: t('new.desc_ph'), maxLength: LIMITS.DESCRIPTION_MAX, rows: 2, 'aria-label': t('new.desc_ph') });
  const chips = h('div', { class: 'sel-chips' });
  const err = h('div', { class: 'err', role: 'alert' });
  const redraw = () => {
    clear(chips).append([...chosen.values()].map((u) =>
      h('button', { class: 'chip', type: 'button', 'aria-label': `${u.name} ✕`, onclick: () => { chosen.delete(u.id); redraw(); } }, `${u.name} ✕`)));
  };
  const picker = userPicker({ onPick: (u) => { chosen.set(u.id, u); redraw(); } });
  const create = h('button', { class: 'btn', type: 'button' }, t('new.create'));
  const secure = h('input', { type: 'checkbox', id: 'new-e2e' });
  const secureRow = type === 'group' && e2eSupported()
    ? h('label', { class: 'focus-row', for: 'new-e2e' }, h('span', null, h('b', null, `🔒 ${t('e2e.create')}`), h('small', { class: 'muted' }, t('e2e.create_hint'))), secure) : null;
  const m = modal({
    title: type === 'channel' ? t('new.channel') : t('new.group'),
    body: [
      h('div', { class: 'field' }, title), h('div', { class: 'field' }, desc), ...(secureRow ? [secureRow] : []),
      h('h3', null, t('new.members')), chips, picker.el, err,
      h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } }, create),
    ],
  });
  create.onclick = async () => {
    err.textContent = '';
    if (!title.value.trim()) { err.textContent = t('new.title_ph'); title.focus(); return; }
    create.disabled = true;
    try {
      if (secure.checked) await registerDevice(); // the key of this device must exist before the group does
      const r = await api('POST', '/api/chats', {
        type, title: title.value.trim(), description: desc.value.trim(), member_ids: [...chosen.keys()], ...(secure.checked ? { e2e: true } : {}),
      });
      S.chats.set(r.chat.id, r.chat);
      if (r.chat.secret?.group) await syncGroup(r.chat);
      fire('chats');
      m.close();
      fire('open-chat', r.chat.id);
    } catch (e) {
      err.textContent = errText(e.code);
      create.disabled = false;
    }
  };
  title.focus();
}

// ---------------------------------------------------------------- settings
export { openSettings } from './settings.js';
import { formatBirthday, isBirthdayToday, photoGrid } from './settings.js';
import { openBotFather } from './bots.js';
import { e2eSupported, registerDevice, syncGroup } from './e2egroup.js';
import { openSecretByDefault } from './secret.js';

function shortUA(ua = '') {
  const br = /(Edg|Chrome|Firefox|Safari|OPR)\//.exec(ua)?.[1];
  const os = /(Windows|Android|iPhone|iPad|Mac OS X|Linux)/.exec(ua)?.[1];
  return [br === 'Edg' ? 'Edge' : br === 'OPR' ? 'Opera' : br, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

// ---------------------------------------------------------------- chat info
export function openInfo(chatId) {
  const m = modal({ title: t('chat.info'), body: h('div', { class: 'empty' }, t('list.loading')) });
  return renderInfo(m, chatId);
}

/** target: { setBody(...nodes), close() } — a modal, or the docked info pane on wide screens. */
export async function renderInfo(m, chatId) {
  const draw = async () => {
    let data;
    try { data = await api('GET', `/api/chats/${chatId}`); } catch (e) { fail(e); m.close(); return; }
    const { chat, members } = data;
    S.chats.set(chat.id, chat);
    S.members.set(chat.id, members);
    members.forEach((x) => S.users.set(x.user.id, x.user));
    fire('chats');
    const isAdmin = chat.my_role === 'owner' || chat.my_role === 'admin';
    let counts = null;
    try { counts = await api('GET', `/api/chats/${chat.id}/media/counts`); } catch { /* optional */ }
    const nodes = [];
    if (chat.type === 'direct') {
      const p = chat.peer;
      const infoRow = (value, cap) => h('div', { class: 'sinfo' }, h('div', { class: 'sinfo-main' }, h('div', { class: 'sinfo-value' }, value), h('div', { class: 'sinfo-cap' }, cap)));
      nodes.push(h('div', { class: 'st-hero' }, avatar(p, 'xl'), h('h3', null, p.name),
        h('div', { class: p.online ? 'accent' : 'muted' }, p.is_bot ? t('bots.label') : p.online ? t('chat.online') : p.last_seen ? fmtLastSeen(p.last_seen) : t('chat.last_seen_hidden'))));
      const rows = [];
      if (p.bio) rows.push(infoRow(p.bio, t('settings.bio')));
      if (p.birthday) rows.push(infoRow(`${isBirthdayToday(p.birthday) ? '\u{1F382} ' : ''}${formatBirthday(p.birthday)}`, t('st.birthday')));
      if (p.username) rows.push(infoRow(`@${p.username}`, t('settings.username')));
      if (p.status) rows.push(infoRow(p.status, t('settings.status')));
      if (rows.length) nodes.push(h('div', { class: 'sgroup' }, ...rows));
      if (p.avatar) nodes.push(h('div', { class: 'sheading' }, t('st.album')), h('div', { class: 'sgroup album' }, photoGrid(p.id, false)));
    } else {
      nodes.push(h('div', { style: { textAlign: 'center' } }, h('div', { style: { display: 'inline-block' } }, avatar({ id: chat.id, name: chat.title }, 'lg')),
        h('h2', null, chat.title),
        chat.description ? h('p', { class: 'muted' }, chat.description) : null,
        h('div', { class: 'muted' }, `${chat.members_count} ${chat.type === 'channel' ? t('chat.subscribers') : t('chat.members')}`)));
      if (isAdmin) nodes.push(h('button', { class: 'btn secondary', type: 'button', onclick: () => editChat(chat, draw) }, t('info.edit')));
    }
    const act = (ico, label, onclick, extra = '') => h('button', { type: 'button', class: extra, onclick }, icon(ico, 22), h('span', null, label));
    const muted = isMuted(chat);
    const actions = [
      act(muted ? 'bell' : 'bell', muted ? t('ctx.unmute') : t('info.act_sound'), () => api('PATCH', `/api/chats/${chat.id}/me`, muted ? { muted: false, muted_until: 0 } : { muted: true, muted_until: 0 }).then(draw).catch(fail)),
    ];
    if (chat.type === 'direct' && !chat.saved) {
      actions.unshift(act('video', t('info.act_video'), () => { startCall(chat.id, true); }));
      actions.unshift(act('phone', t('info.act_call'), () => { startCall(chat.id, false); }));
    }
    actions.push(act('grid', t('info.act_media'), () => openMediaPanel(chat.id)));
    nodes.push(h('div', { class: 'info-actions' }, actions));
    if (counts) {
      const rows = [['photos', 'image'], ['videos', 'video'], ['files', 'clip'], ['audio', 'mic'], ['voice', 'mic'], ['links', 'info']]
        .filter(([k]) => counts[k] > 0);
      if (rows.length) {
        nodes.push(h('div', { class: 'info-counts' }, rows.map(([k, ico]) => h('button', { type: 'button', onclick: () => openMediaPanel(chat.id) },
          icon(ico === 'image' ? 'grid' : ico, 20), h('span', null, h('b', null, String(counts[k])), ' ', t(`info.cnt_${k}`))))));
      }
    }

    if (chat.type === 'direct') {
      nodes.push(h('button', { class: `btn ${chat.blocked_by_me ? 'secondary' : 'danger'}`, type: 'button', onclick: async () => {
        await api(chat.blocked_by_me ? 'DELETE' : 'POST', `/api/blocks/${chat.peer.id}`).catch(fail);
        draw();
      } }, chat.blocked_by_me ? t('chat.unblock') : t('info.block')));
    } else {
      if (chat.my_role === 'owner' && !chat.secret && !chat.imported) {
        const pub = h('input', { type: 'checkbox', checked: !!chat.public });
        pub.addEventListener('change', async () => {
          try { const r = await api('POST', `/api/chats/${chat.id}/public`, { public: pub.checked }); S.chats.set(r.chat.id, r.chat); fire('chats'); } catch (e) { pub.checked = !pub.checked; fail(e); }
        });
        nodes.push(h('label', { class: 'focus-row' }, h('span', null, h('b', null, t('dir.make_public')), h('small', { class: 'muted' }, t('dir.make_public_hint'))), pub));
      }
      if (isAdmin && chat.invite_code) {
        const link = `${location.origin}/#/join/${chat.invite_code}`;
        nodes.push(h('h3', null, t('info.invite')), h('div', { class: 'invite' }, link),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast(t('info.copied')); } catch { /* ignore */ } } }, t('info.copy')),
            h('button', { class: 'btn secondary', type: 'button', onclick: () => showQr(chat.title || t('info.invite'), link) }, t('qr.show')),
            h('button', { class: 'btn link', type: 'button', onclick: async () => { await api('POST', `/api/chats/${chat.id}/invite/reset`).catch(fail); draw(); } }, t('info.reset'))));
      }
      if (isAdmin) {
        const picker = userPicker({
          exclude: new Set(members.map((x) => x.user.id)),
          onPick: async (u) => { await api('POST', `/api/chats/${chat.id}/members`, { user_id: u.id }).catch(fail); draw(); },
        });
        nodes.push(h('h3', null, t('info.add')), picker.el);
      }
      nodes.push(h('h3', null, `${t('info.members')} (${members.filter((x) => !x.banned).length})`));
      for (const mem of members) nodes.push(memberRow(chat, mem, draw));
      nodes.push(h('div', { style: { marginTop: '16px' } }, h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!(await confirmDialog(t('info.leave_confirm'), { okLabel: t('info.leave'), danger: true }))) return;
        await api('DELETE', `/api/chats/${chat.id}/members/${S.me.id}`).catch(fail);
        S.chats.delete(chat.id);
        fire('chat-removed', chat.id);
        m.close();
      } }, t('info.leave'))));
    }
    m.setBody(nodes);
  };
  draw();
}

function memberRow(chat, mem, redraw) {
  const u = mem.user;
  const me = chat.my_role;
  const tags = [];
  if (mem.role === 'owner') tags.push(h('span', { class: 'tag' }, t('info.owner')));
  if (mem.role === 'admin') tags.push(h('span', { class: 'tag' }, t('info.admin')));
  if (mem.banned) tags.push(h('span', { class: 'tag' }, t('info.banned')));
  if (!mem.can_send && mem.role === 'member' && !mem.banned) tags.push(h('span', { class: 'tag' }, t('info.restricted')));
  const canManage = u.id !== S.me.id && mem.role !== 'owner' && (me === 'owner' || (me === 'admin' && mem.role === 'member'));
  const row = h('div', { class: 'list-item' }, avatar(u, 'sm'),
    h('span', { class: 'grow' }, h('b', null, u.name), ' ', tags, h('br'), h('span', { class: 'muted' }, u.username ? `@${u.username}` : '')));
  if (canManage) {
    const btn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': u.name, 'aria-haspopup': 'menu' }, '⋯');
    btn.onclick = () => {
      const call = (method, url, body) => api(method, url, body).then(redraw, fail);
      const base = `/api/chats/${chat.id}/members/${u.id}`;
      const items = [];
      if (mem.banned) {
        items.push({ label: t('info.unban'), onClick: () => call('PATCH', base, { banned: false }) });
      } else {
        if (me === 'owner') {
          items.push({ label: mem.role === 'admin' ? t('info.remove_admin') : t('info.make_admin'), onClick: () => call('PATCH', base, { role: mem.role === 'admin' ? 'member' : 'admin' }) });
        }
        if (chat.type === 'group') {
          items.push({ label: mem.can_send ? t('info.restrict') : t('info.allow'), onClick: () => call('PATCH', base, { can_send: !mem.can_send }) });
        }
        items.push({ label: t('info.kick'), danger: true, onClick: () => call('DELETE', base) });
        items.push({ label: t('info.ban'), danger: true, onClick: () => call('DELETE', `${base}?ban=1`) });
      }
      popMenu(btn, items);
    };
    row.append(btn);
  }
  return row;
}

function editChat(chat, redraw) {
  const title = h('input', { class: 'input', value: chat.title, maxLength: LIMITS.TITLE_MAX });
  const desc = h('textarea', { class: 'input', rows: 3, maxLength: LIMITS.DESCRIPTION_MAX }, chat.description);
  const m = modal({
    title: t('info.edit'),
    body: [h('div', { class: 'field' }, title), h('div', { class: 'field' }, desc),
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        try { await api('PATCH', `/api/chats/${chat.id}`, { title: title.value, description: desc.value }); m.close(); redraw(); } catch (e) { fail(e); }
      } }, t('settings.save'))],
  });
}

// ---------------------------------------------------------------- in-chat search / forward / join
export function openChatSearch(chatId) {
  const results = h('div', { role: 'list' });
  const input = h('input', { class: 'input', type: 'search', placeholder: t('chat.search_ph'), 'aria-label': t('chat.search_ph') });
  const m = modal({ title: t('chat.search'), body: [input, results] });
  input.addEventListener('input', debounce(async () => {
    const term = input.value.trim();
    clear(results);
    if (term.length < 2) return;
    try {
      const r = await api('GET', `/api/search/messages?q=${encodeURIComponent(term)}&chat_id=${chatId}`);
      if (!r.messages.length) results.append(h('div', { class: 'empty' }, t('list.nothing')));
      for (const msg of r.messages) {
        results.append(h('button', { class: 'list-item clickable', type: 'button', role: 'listitem', onclick: () => { m.close(); fire('jump', { chatId, msgId: msg.id }); } },
          h('span', { class: 'grow' }, h('span', { class: 'muted' }, `${S.users.get(msg.sender_id)?.name ?? ''} · ${new Date(msg.created_at).toLocaleString()}`), h('br'), previewText(msg))));
      }
    } catch (e) { fail(e); }
  }, 300));
}

export function openForward(msgOrList) {
  const list = Array.isArray(msgOrList) ? msgOrList : [msgOrList];
  const m = modal({ title: t('msg.forward_to'), body: [] });
  const chats = [...S.chats.values()].filter((c) => c.can_post)
    .sort((a, b) => b.last_message_at - a.last_message_at);
  m.setBody(chats.map((c) => h('button', {
    class: 'list-item clickable', type: 'button',
    onclick: async () => {
      try {
        for (const msg of list) await api('POST', `/api/chats/${c.id}/messages`, { forward_of: msg.id, client_id: uuid() });
        toast(t('msg.forwarded'));
        m.close();
      } catch (e) { fail(e); }
    },
  }, avatar(c.type === 'direct' ? c.peer : { id: c.id, name: c.title }, 'sm'), h('span', { class: 'grow' }, chatTitle(c)))));
}

export async function openJoin(code) {
  try {
    const r = await api('GET', `/api/invite/${encodeURIComponent(code)}`);
    const c = r.chat;
    const m = modal({
      title: t('join.title'),
      body: h('div', { style: { textAlign: 'center' } },
        h('div', { style: { display: 'inline-block' } }, avatar({ id: c.id, name: c.title }, 'lg')),
        h('h2', null, c.title), c.description ? h('p', { class: 'muted' }, c.description) : null,
        h('p', { class: 'muted' }, t('common.members_n', { n: c.members_count })),
        r.banned ? h('div', { class: 'err' }, errText('user_banned'))
          : r.already_member ? h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); fire('open-chat', c.id); } }, t('join.already'))
            : h('button', { class: 'btn', type: 'button', onclick: async () => {
              try {
                const j = await api('POST', `/api/invite/${encodeURIComponent(code)}/join`);
                S.chats.set(j.chat.id, j.chat);
                fire('chats');
                m.close();
                fire('open-chat', j.chat.id);
              } catch (e) { fail(e); }
            } }, t('join.join'))),
    });
  } catch {
    toast(t('join.invalid'));
  }
}

// Shown only inside the native apps (Android/iOS/desktop), which load this client from the user's own server.
function shellSection() {
  const ua = navigator.userAgent;
  if (!ua.includes('SuhbatShell/')) return [];
  const body = [h('h3', null, t('settings.server')), h('div', { class: 'muted', style: { marginBottom: '8px' } }, location.origin)];
  if (ua.includes('SuhbatShell/mobile')) {
    const home = /Android/i.test(ua) ? 'https://localhost/?change=1' : 'capacitor://localhost/?change=1';
    body.push(h('button', { class: 'btn secondary', type: 'button', onclick: () => { location.href = home; } }, t('settings.server_change')));
  } else {
    body.push(h('div', { class: 'muted' }, t('settings.server_hint')));
  }
  return body;
}
