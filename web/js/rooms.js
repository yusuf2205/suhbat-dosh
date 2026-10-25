// Voice rooms: every group has a room you can drop into and leave without ringing anybody, like a common table.
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { S, chatTitle, on } from './state.js';
import { avatar, modal } from './ui.js';
import { groupCallChatId, joinGroupCall, leaveGroupCall } from './gcall.js';

export function openRooms() {
  const list = h('div', { class: 'rooms-list' });
  const win = modal({ title: t('room.title_all'), className: 'drive', body: [h('p', { class: 'muted' }, t('room.hint')), list] });
  const draw = () => {
    if (!list.isConnected) { off(); return; }
    const groups = [...S.chats.values()].filter((c) => c.type === 'group' && !c.imported && !c.archived)
      .sort((a, b) => (S.gcalls.get(b.id)?.participants.length || 0) - (S.gcalls.get(a.id)?.participants.length || 0) || (b.last_message_at || 0) - (a.last_message_at || 0));
    clear(list);
    if (!groups.length) { list.append(h('p', { class: 'muted drive-empty' }, t('room.no_groups'))); return; }
    for (const c of groups) {
      const room = S.gcalls.get(c.id);
      const inside = groupCallChatId() === c.id;
      const who = (room?.participants || []).map((p) => S.users.get(p.id) || { id: p.id, name: p.name });
      list.append(h('div', { class: 'room-row' },
        avatar({ id: c.id, name: c.title, avatar: c.avatar }, 'sm'),
        h('div', { class: 'room-main' },
          h('b', { class: 'ellipsis' }, chatTitle(c)),
          who.length ? h('div', { class: 'room-who' }, who.slice(0, 6).map((u) => avatar(u, 'sm')), h('small', { class: 'muted' }, who.map((u) => u.name).slice(0, 3).join(', '))) : h('small', { class: 'muted' }, t('room.empty'))),
        inside
          ? h('button', { class: 'btn secondary', type: 'button', onclick: () => { leaveGroupCall(); } }, t('room.leave'))
          : h('button', { class: 'btn', type: 'button', onclick: () => { win.close(); joinGroupCall(c.id, false, { room: !room || room.room }); } }, room ? t('room.join') : t('room.open'))));
    }
  };
  const off = on('gcalls', draw);
  draw();
}

export const roomsLive = () => [...S.gcalls.values()].filter((r) => r.room && r.participants?.length).length;
