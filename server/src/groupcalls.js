// Group audio/video calls for group chats: a full mesh of WebRTC connections (every participant connects to every other).
// The server only keeps who is in which room and relays signalling; media flows peer-to-peer (or via TURN).
// Practical limit is ROOM_MAX participants because each one uploads its stream to every other.
import { q } from './db.js';
import { currentIceServers } from './turn.js';
import { emit } from './realtime.js';
import { audit, getUser, memberIds, membership, publicUser } from './service.js';
import { now } from './util.js';

export const ROOM_MAX = 6;
const rooms = new Map(); // chatId -> { chatId, video, startedAt, startedBy, parts: Map<userId, { audio, video }> }

const view = (r) => ({
  chat_id: r.chatId, video: r.video, room: !!r.room, started_at: r.startedAt, started_by: r.startedBy,
  participants: [...r.parts.entries()].map(([id, s]) => ({ id, name: getUser(id)?.name || '', audio: s.audio, video: s.video })),
});

function announce(r) {
  emit(memberIds(r.chatId), { type: 'gcall.state', ...view(r) });
}
const announceEnded = (chatId) => emit(memberIds(chatId), { type: 'gcall.state', chat_id: chatId, participants: [], ended: true });

function inRoom(userId) {
  for (const r of rooms.values()) if (r.parts.has(userId)) return r;
  return null;
}

export function leave(userId, chatId = null) {
  const r = chatId === null ? inRoom(userId) : rooms.get(chatId);
  if (!r || !r.parts.delete(userId)) return;
  for (const id of r.parts.keys()) emit([id], { type: 'gcall.peer_left', chat_id: r.chatId, user_id: userId });
  if (r.parts.size === 0) {
    rooms.delete(r.chatId);
    audit(r.startedBy, 'gcall.end', { chat_id: r.chatId, details: { seconds: Math.round((now() - r.startedAt) / 1000) } });
    announceEnded(r.chatId);
  } else {
    announce(r);
  }
}

export function activeFor(userId) {
  const out = [];
  for (const r of rooms.values()) if (membership(r.chatId, userId)) out.push(view(r));
  return out;
}

export function handleGroupSignal(userId, m) {
  const chatId = Number(m.chat_id);
  switch (m.type) {
    case 'gcall.join': {
      if (!Number.isInteger(chatId)) return;
      const chat = q.get('SELECT * FROM chats WHERE id = ?', chatId);
      const reject = (reason) => emit([userId], { type: 'gcall.rejected', chat_id: chatId, reason });
      if (!chat || chat.type !== 'group' || !membership(chatId, userId)) return reject('forbidden');
      const other = inRoom(userId);
      if (other && other.chatId !== chatId) return reject('busy');
      let r = rooms.get(chatId);
      if (!r) {
        r = { chatId, video: !!m.video, room: !!m.room && !m.video, startedAt: now(), startedBy: userId, parts: new Map() };
        rooms.set(chatId, r);
        audit(userId, 'gcall.start', { chat_id: chatId, details: { video: r.video, room: r.room } });
      }
      if (!r.parts.has(userId) && r.parts.size >= ROOM_MAX) return reject('full');
      const peers = [...r.parts.keys()].filter((id) => id !== userId);
      r.parts.set(userId, { audio: true, video: !!m.video });
      emit([userId], {
        type: 'gcall.joined', chat_id: chatId, peers: peers.map((id) => publicUser(getUser(id), userId)), ice_servers: currentIceServers(), max: ROOM_MAX,
      });
      for (const id of peers) emit([id], { type: 'gcall.peer_joined', chat_id: chatId, user: publicUser(getUser(userId), id), video: !!m.video });
      announce(r);
      return;
    }
    case 'gcall.signal': {
      const r = rooms.get(chatId);
      const to = Number(m.to);
      if (!r || !r.parts.has(userId) || !r.parts.has(to) || to === userId) return;
      const d = m.data;
      if (!d || typeof d !== 'object') return;
      const ok = (d.type === 'offer' || d.type === 'answer') ? typeof d.sdp === 'string' && d.sdp.length < 60_000
        : d.type === 'ice' && (d.candidate === null || (typeof d.candidate === 'object' && JSON.stringify(d.candidate).length < 2000));
      if (!ok) return;
      emit([to], { type: 'gcall.signal', chat_id: chatId, from: userId, data: d });
      return;
    }
    case 'gcall.media': {
      const r = rooms.get(chatId);
      const s = r?.parts.get(userId);
      if (!s) return;
      s.audio = m.audio !== false;
      s.video = !!m.video;
      for (const id of r.parts.keys()) if (id !== userId) emit([id], { type: 'gcall.peer_media', chat_id: chatId, user_id: userId, audio: s.audio, video: s.video });
      announce(r);
      return;
    }
    case 'gcall.leave':
      leave(userId, Number.isInteger(chatId) ? chatId : null);
      return;
    default:
  }
}
