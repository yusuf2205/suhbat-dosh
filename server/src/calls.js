import { q } from './db.js';
import { emit, isOnline } from './realtime.js';
import { audit, directPeerId, getUser, isBlockedEitherWay, membership, publicUser } from './service.js';
import { postMessage } from './api.js';
import { now } from './util.js';
import { focusMutes, pushToUser } from './push.js';

// 1:1 audio/video calls. The server only relays WebRTC signalling (SDP + ICE) between the two
// participants and keeps a history entry in the chat; media flows peer-to-peer (or via TURN).
const calls = new Map();   // callId -> call
const busy = new Map();    // userId -> callId
const RING_MS = 45_000;
const ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const other = (call, userId) => (userId === call.caller ? call.callee : call.caller);

function finish(call, reason) {
  if (!calls.delete(call.id)) return;
  clearTimeout(call.timer);
  clearTimeout(call.graceTimer);
  busy.delete(call.caller);
  busy.delete(call.callee);
  const answered = !!call.answeredAt;
  const duration = answered ? Math.max(1, Math.round((now() - call.answeredAt) / 1000)) : 0;
  const status = answered ? 'ended'
    : reason === 'decline' ? 'declined'
      : reason === 'busy' ? 'busy'
        : reason === 'cancel' ? 'cancelled'
          : 'missed';
  emit([call.caller, call.callee], { type: 'call.ended', call_id: call.id, reason: status, duration });

  const chat = q.get('SELECT * FROM chats WHERE id = ?', call.chatId);
  const caller = getUser(call.caller);
  if (chat && caller) {
    postMessage({ chat, user: caller, kind: 'call', text: `${status}${call.video ? ':video' : ''}`, duration });
  }
  audit(call.caller, 'call.end', {
    chat_id: call.chatId, target_type: 'user', target_id: call.callee,
    details: { status, duration, video: call.video },
  });
}

function invite(userId, m) {
  const reject = (reason) => emit([userId], { type: 'call.ended', call_id: String(m.call_id || ''), reason, duration: 0 });
  if (!ID_RE.test(String(m.call_id || '')) || typeof m.sdp !== 'string' || m.sdp.length > 30_000) return;
  const chatId = Number(m.chat_id);
  const chat = Number.isInteger(chatId) ? q.get('SELECT * FROM chats WHERE id = ?', chatId) : null;
  if (!chat || chat.type !== 'direct' || !membership(chatId, userId)) return reject('forbidden');
  const peer = directPeerId(chatId, userId);
  if (!peer || peer === userId) return reject('forbidden');
  if (isBlockedEitherWay(userId, peer)) return reject('blocked');
  if (calls.has(m.call_id)) return;
  if (busy.has(userId) || busy.has(peer)) return reject('busy');
  if (getUser(peer)?.presence === 'busy') return reject('busy'); // "busy" status: calls are declined politely
  if (focusMutes(getUser(peer), { senderId: userId, call: true })) return reject('busy'); // focus mode: only chosen people can call

  const call = {
    id: m.call_id, chatId, caller: userId, callee: peer, video: !!m.video, startedAt: now(), answeredAt: 0, timer: null,
  };
  calls.set(call.id, call);
  busy.set(userId, call.id);
  busy.set(peer, call.id);
  audit(userId, 'call.start', { chat_id: chatId, target_type: 'user', target_id: peer, details: { video: call.video } });

  const incoming = {
    type: 'call.incoming', call_id: call.id, chat_id: chatId, video: call.video, sdp: m.sdp,
    from: publicUser(getUser(userId), peer),
  };
  if (!isOnline(peer)) {
    // the callee's app is closed or asleep (typical for an iPhone): wake it with a push and keep ringing;
    // the call is handed over as soon as the app connects. Without any push device: a missed call.
    const caller = getUser(userId);
    const pushed = pushToUser(peer, {
      title: caller?.name || 'Suhbat-dosh', body: call.video ? '📹 Входящий видеозвонок' : '📞 Входящий звонок',
      chat_id: chatId, tag: `call-${call.id}`, call: true,
    }, { ttl: 45 });
    if (pushed) {
      call.pending = incoming;
      call.timer = setTimeout(() => finish(call, 'missed'), RING_MS);
      emit([userId], { type: 'call.ringing', call_id: call.id });
      return;
    }
    emit([userId], { type: 'call.ringing', call_id: call.id, offline: true });
    call.timer = setTimeout(() => finish(call, 'missed'), 4000);
    return;
  }
  call.timer = setTimeout(() => finish(call, 'missed'), RING_MS);
  emit([peer], incoming);
  emit([userId], { type: 'call.ringing', call_id: call.id });
}

export function handleSignal(userId, m) {
  const call = calls.get(String(m.call_id || ''));
  switch (m.type) {
    case 'call.invite':
      return invite(userId, m);
    case 'call.answer': {
      if (!call || call.callee !== userId || call.answeredAt || typeof m.sdp !== 'string' || m.sdp.length > 30_000) return undefined;
      call.answeredAt = now();
      clearTimeout(call.timer);
      emit([call.caller], { type: 'call.answered', call_id: call.id, sdp: m.sdp });
      emit([call.callee], { type: 'call.state', call_id: call.id, state: 'active' }); // stops ringing on other devices
      return undefined;
    }
    case 'call.ice': {
      if (!call || (userId !== call.caller && userId !== call.callee)) return undefined;
      const c = m.candidate;
      if (c !== null && (typeof c !== 'object' || JSON.stringify(c).length > 3000)) return undefined;
      emit([other(call, userId)], { type: 'call.ice', call_id: call.id, candidate: c });
      return undefined;
    }
    case 'call.reneg': {
      // ICE restart after a network change: the other side must answer with its own description
      if (!call || (userId !== call.caller && userId !== call.callee) || !call.answeredAt) return undefined;
      if (!['offer', 'answer', 'restart'].includes(m.kind)) return undefined;
      if (m.kind !== 'restart' && (typeof m.sdp !== 'string' || m.sdp.length > 30_000)) return undefined;
      emit([other(call, userId)], { type: 'call.reneg', call_id: call.id, kind: m.kind, sdp: m.kind === 'restart' ? '' : m.sdp });
      return undefined;
    }
    case 'call.caption': {
      // live subtitles: only text, relayed to the other side of an answered call
      if (!call || (userId !== call.caller && userId !== call.callee) || !call.answeredAt) return undefined;
      const text = typeof m.text === 'string' ? m.text.trim().slice(0, 300) : '';
      if (!text) return undefined;
      emit([other(call, userId)], { type: 'call.caption', call_id: call.id, text, lang: String(m.lang || '').slice(0, 8), final: !!m.final });
      return undefined;
    }
    case 'call.media': {
      // "my camera / screen is on or off": lets the other side show the avatar instead of a frozen frame
      if (!call || (userId !== call.caller && userId !== call.callee) || !call.answeredAt) return undefined;
      emit([other(call, userId)], { type: 'call.media', call_id: call.id, video: !!m.video, screen: !!m.screen });
      return undefined;
    }
    case 'call.stats': {
      // technical figures only (no media, no content): helps to find echo / lag / freezes
      const id = String(m.call_id || '');
      const num = (v, max) => (Number.isFinite(v) ? Math.max(0, Math.min(max, Math.round(v * 10) / 10)) : null);
      const s = m.stats || {};
      audit(userId, 'call.quality', {
        target_type: 'call', target_id: id.slice(0, 64),
        details: {
          rtt_ms: num(s.rtt_ms, 60000), rtt_max_ms: num(s.rtt_max_ms, 60000), loss_pct: num(s.loss_pct, 100), jitter_ms: num(s.jitter_ms, 60000),
          kbps_in: num(s.kbps_in, 100000), kbps_out: num(s.kbps_out, 100000), width: num(s.width, 8192), height: num(s.height, 8192),
          fps: num(s.fps, 240), codec: typeof s.codec === 'string' ? s.codec.slice(0, 24) : null, relay: !!s.relay,
          quality_mode: ['auto', 'high', 'save'].includes(s.mode) ? s.mode : null, reconnects: num(s.reconnects, 100),
          duration: num(s.duration, 86400), samples: num(s.samples, 100000), failed: s.failed === true ? true : undefined,
        },
      });
      return undefined;
    }
    case 'call.end': {
      if (!call || (userId !== call.caller && userId !== call.callee)) return undefined;
      let reason = 'hangup';
      if (!call.answeredAt) reason = userId === call.caller ? 'cancel' : (m.reason === 'busy' ? 'busy' : 'decline');
      finish(call, reason);
      return undefined;
    }
    default:
      return undefined;
  }
}

/** A participant lost all connections: the call cannot continue. */
const GRACE_MS = 25_000;
export function handleOffline(userId) {
  const id = busy.get(userId);
  const call = id ? calls.get(id) : null;
  if (!call) return;
  if (call.pending && userId === call.callee) return; // still ringing through the push: the timer decides
  if (!call.answeredAt) {
    finish(call, userId === call.caller ? 'cancel' : 'missed');
    return;
  }
  // in an active call: wait for the device to come back before giving up
  clearTimeout(call.graceTimer);
  call.graceTimer = setTimeout(() => finish(call, 'hangup'), GRACE_MS);
}

export function handleOnline(userId) {
  const id = busy.get(userId);
  const call = id ? calls.get(id) : null;
  if (call?.pending && userId === call.callee && !call.answeredAt) {
    // the callee opened the app from the push notification: ring now
    emit([userId], call.pending);
    return;
  }
  if (call?.graceTimer) {
    clearTimeout(call.graceTimer);
    call.graceTimer = null;
    emit([userId], { type: 'call.resumed', call_id: call.id });
  }
}

export function recentCalls(userId, limit = 100) {
  return q.all(
    `SELECT m.* FROM messages m JOIN members mb ON mb.chat_id = m.chat_id AND mb.user_id = ? AND mb.banned = 0
     WHERE m.kind = 'call' ORDER BY m.id DESC LIMIT ?`, userId, limit,
  );
}
