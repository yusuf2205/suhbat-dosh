// Group calls (up to 6 people): a mesh of peer-to-peer WebRTC connections, signalling over the WebSocket.
import { h, clear, formatDuration } from './dom.js';
import { t } from './i18n.js';
import { S, chatTitle, fire } from './state.js';
import { api, wsSend } from './net.js';
import { icon } from './icons.js';
import { avatar, beep, toast } from './ui.js';
import { inCall } from './call.js';

let cur = null; // { chatId, local, video, peers: Map(userId -> peer), ui, started, timer, ice }
S.gcalls ||= new Map(); // chatId -> { participants: [{id,name,audio,video}], video, started_by }

export const inGroupCall = () => !!cur;
export const groupCallOf = (chatId) => S.gcalls.get(chatId) || null;

export async function refreshGroupCalls() {
  try {
    const r = await api('GET', '/api/gcalls');
    S.gcalls = new Map(r.rooms.map((x) => [x.chat_id, x]));
    fire('gcalls');
  } catch { /* offline */ }
}

// ---------------------------------------------------------------- events from the server
export function handleGroupCallEvent(ev) {
  switch (ev.type) {
    case 'gcall.state': {
      const had = S.gcalls.has(ev.chat_id);
      if (ev.ended || !ev.participants?.length) S.gcalls.delete(ev.chat_id);
      else S.gcalls.set(ev.chat_id, ev);
      if (!had && S.gcalls.has(ev.chat_id) && !ev.room && ev.started_by !== S.me.id && cur?.chatId !== ev.chat_id) {
        const c = S.chats.get(ev.chat_id);
        toast(`${ev.participants.find((p) => p.id === ev.started_by)?.name || ''} ${t('gcall.started')} · ${c ? chatTitle(c) : ''}`, 6000);
        if (S.prefs.sound) beep();
      }
      fire('gcalls');
      if (cur?.chatId === ev.chat_id) drawTiles();
      break;
    }
    case 'gcall.rejected':
      toast(t(`gcall.err_${ev.reason}`) || t('err.generic'), 5000);
      if (cur?.chatId === ev.chat_id) teardown();
      break;
    case 'gcall.joined':
      if (cur?.chatId !== ev.chat_id) break;
      if (Array.isArray(ev.ice_servers) && ev.ice_servers.length) cur.ice = ev.ice_servers;
      for (const u of ev.peers) {
        S.users.set(u.id, u);
        makePeer(u, true).catch(() => {});
      }
      drawTiles();
      break;
    case 'gcall.peer_joined':
      if (cur?.chatId !== ev.chat_id) break;
      S.users.set(ev.user.id, ev.user);
      addRosterOnly(ev.user, ev.video);
      beep();
      break;
    case 'gcall.peer_left':
      if (cur?.chatId !== ev.chat_id) break;
      dropPeer(ev.user_id);
      break;
    case 'gcall.peer_media': {
      const p = cur?.chatId === ev.chat_id ? cur.peers.get(ev.user_id) : null;
      if (p) { p.audio = ev.audio; p.video = ev.video; drawTiles(); }
      break;
    }
    case 'gcall.signal':
      if (cur?.chatId === ev.chat_id) onSignal(ev.from, ev.data).catch(() => {});
      break;
    default:
  }
}

// ---------------------------------------------------------------- peers
function newPeer(user) {
  const p = {
    user, pc: null, stream: new MediaStream(), audio: true, video: false, queued: [], remoteSet: false,
  };
  cur.peers.set(user.id, p);
  return p;
}

function addRosterOnly(user, video) {
  if (cur.peers.has(user.id)) return;
  const p = newPeer(user);
  p.video = !!video;
  drawTiles();
}

function attach(p) {
  const pc = new RTCPeerConnection({ iceServers: cur.ice });
  p.pc = pc;
  pc.onicecandidate = (e) => {
    wsSend({ type: 'gcall.signal', chat_id: cur.chatId, to: p.user.id, data: { type: 'ice', candidate: e.candidate ? e.candidate.toJSON() : null } });
  };
  pc.ontrack = (e) => {
    if (!p.stream.getTracks().includes(e.track)) p.stream.addTrack(e.track);
    drawTiles();
  };
  pc.onconnectionstatechange = () => {
    p.state = pc.connectionState;
    if (pc.connectionState === 'failed') { try { pc.restartIce(); } catch { /* ignore */ } }
    drawTiles();
  };
  return pc;
}

/** Wire local audio/video into every transceiver; the video one is always present, so the camera can start later. */
function feed(pc, offerer) {
  const a = cur.local.getAudioTracks()[0] || null;
  const v = cur.local.getVideoTracks()[0] || null;
  if (offerer) {
    if (a) pc.addTrack(a, cur.local); else pc.addTransceiver('audio', { direction: 'recvonly' });
    pc.addTransceiver('video', { direction: 'sendrecv', streams: [cur.local] });
  }
  for (const tr of pc.getTransceivers()) {
    const kind = tr.receiver.track.kind;
    if (kind === 'audio' && a) { tr.direction = 'sendrecv'; tr.sender.replaceTrack(a).catch(() => {}); }
    if (kind === 'video') { tr.direction = 'sendrecv'; if (v) tr.sender.replaceTrack(v).catch(() => {}); }
  }
}

async function makePeer(user, offerer) {
  let p = cur.peers.get(user.id);
  if (!p) p = newPeer(user);
  if (!p.pc) attach(p);
  if (offerer) {
    feed(p.pc, true);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    wsSend({ type: 'gcall.signal', chat_id: cur.chatId, to: user.id, data: { type: 'offer', sdp: p.pc.localDescription.sdp } });
  }
  drawTiles();
  return p;
}

async function onSignal(from, d) {
  let p = cur.peers.get(from);
  if (!p) p = newPeer(S.users.get(from) || { id: from, name: '…' });
  if (!p.pc) attach(p);
  const pc = p.pc;
  if (d.type === 'offer') {
    await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
    p.remoteSet = true;
    feed(pc, false);
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    wsSend({ type: 'gcall.signal', chat_id: cur.chatId, to: from, data: { type: 'answer', sdp: pc.localDescription.sdp } });
    for (const c of p.queued.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  } else if (d.type === 'answer') {
    await pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
    p.remoteSet = true;
    for (const c of p.queued.splice(0)) await pc.addIceCandidate(c).catch(() => {});
  } else if (d.type === 'ice' && d.candidate) {
    if (p.remoteSet) await pc.addIceCandidate(d.candidate).catch(() => {});
    else p.queued.push(d.candidate);
  }
  drawTiles();
}

function dropPeer(id) {
  const p = cur?.peers.get(id);
  if (!p) return;
  try { p.pc?.close(); } catch { /* ignore */ }
  cur.peers.delete(id);
  drawTiles();
}

// ---------------------------------------------------------------- local media + UI
export async function joinGroupCall(chatId, video = false, { room = false } = {}) {
  const c = S.chats.get(chatId);
  if (!c || c.type !== 'group') return;
  if (cur) { if (cur.chatId === chatId) { cur.ui.classList.remove('min'); return; } return toast(t('gcall.err_busy')); }
  if (room) video = false;
  if (inCall()) return toast(t('gcall.err_busy'));
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) return toast(t('call.insecure'), 6000);
  let local;
  try {
    local = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 }, facingMode: 'user' } : false,
    });
  } catch {
    return toast(t('call.mic_denied'), 6000);
  }
  cur = {
    chatId, local, video, peers: new Map(), ui: null, started: Date.now(), timer: null,
    ice: [{ urls: ['stun:stun.l.google.com:19302'] }], audioOn: true, room,
  };
  buildUi(c);
  wsSend({ type: 'gcall.join', chat_id: chatId, video, room });
  fire('gcalls');
}

function buildUi(c) {
  const grid = h('div', { class: 'gc-grid' });
  const time = h('span', { class: 'gc-time' }, '0:00');
  const mic = h('button', { class: 'gc-btn', type: 'button', 'aria-label': t('call.mute') }, icon('mic', 24));
  const cam = h('button', { class: 'gc-btn', type: 'button', 'aria-label': t('call.camera_on') }, icon('video', 24));
  const end = h('button', { class: 'gc-btn end', type: 'button', 'aria-label': t('gcall.leave') }, icon('phone', 24));
  const min = h('button', { class: 'gc-btn small', type: 'button', 'aria-label': t('gcall.minimize'), onclick: () => cur.ui.classList.toggle('min') }, icon('back', 20));
  mic.onclick = () => {
    cur.audioOn = !cur.audioOn;
    cur.local.getAudioTracks().forEach((x) => { x.enabled = cur.audioOn; });
    mic.classList.toggle('off', !cur.audioOn);
    announce();
    drawTiles();
  };
  cam.onclick = () => toggleCamera(cam);
  end.onclick = () => leaveGroupCall();
  const nat = window.SuhbatNative;
  let spkOn = cur.video;
  const spk = nat?.setSpeaker ? h('button', { class: 'gc-btn', type: 'button', 'aria-label': t('call.speaker_on'), onclick: () => {
    spkOn = !spkOn;
    try { nat.setSpeaker(spkOn); } catch { /* ignore */ }
    spk.classList.toggle('off', !spkOn);
  } }, icon('speaker', 24)) : null;
  if (spk && !spkOn) spk.classList.add('off');
  try { nat?.callAudio?.(true, spkOn); } catch { /* ignore */ }
  cur.ui = h('div', { class: 'gcall', role: 'dialog', 'aria-label': t('gcall.title') },
    h('div', { class: 'gc-head' }, min, h('b', { class: 'ellipsis' }, `${cur.room ? t('room.title') : t('gcall.title')} · ${chatTitle(c)}`), time),
    (cur.dock = h('div', { class: 'gc-dock' })),
    grid,
    h('div', { class: 'gc-controls' }, mic, cam, ...(spk ? [spk] : []), end));
  cur.grid = grid;
  cur.cam = cam;
  cur.timeEl = time;
  cur.timer = setInterval(() => { time.textContent = formatDuration((Date.now() - cur.started) / 1000); }, 1000);
  if (!cur.local.getVideoTracks().length) cam.classList.add('off');
  if (cur.room) cur.ui.classList.add('min', 'room'); // a room is a quiet strip in the corner, not a full screen
  document.body.append(cur.ui);
  cur.meter = setInterval(measure, 140);
  drawTiles();
}

// ---------------------------------------------------------------- who is speaking
function levelOf(entry) {
  if (!entry.an) return 0;
  entry.an.getByteTimeDomainData(entry.buf);
  let sum = 0;
  for (const v of entry.buf) sum += ((v - 128) / 128) ** 2;
  return Math.sqrt(sum / entry.buf.length);
}

function meterFor(id, stream) {
  cur.meters ||= new Map();
  const have = cur.meters.get(id);
  if (have?.stream === stream && have.tracks === stream.getAudioTracks().length) return have;
  if (!stream || !stream.getAudioTracks().length) return null;
  try {
    cur.ac ||= new (window.AudioContext || window.webkitAudioContext)();
    const an = cur.ac.createAnalyser();
    an.fftSize = 512;
    cur.ac.createMediaStreamSource(stream).connect(an);
    const e = { stream, an, buf: new Uint8Array(an.fftSize), tracks: stream.getAudioTracks().length };
    cur.meters.set(id, e);
    return e;
  } catch { return null; }
}

function measure() {
  if (!cur) return;
  const speaking = new Set();
  const mine = meterFor(S.me.id, cur.local);
  if (mine && cur.audioOn && levelOf(mine) > 0.04) speaking.add(S.me.id);
  for (const p of cur.peers.values()) {
    const m = meterFor(p.user.id, p.stream);
    if (m && p.audio !== false && levelOf(m) > 0.04) speaking.add(p.user.id);
  }
  const same = cur.speaking && cur.speaking.size === speaking.size && [...speaking].every((x) => cur.speaking.has(x));
  cur.speaking = speaking;
  if (same) return;
  for (const [id, t0] of cur.tiles || []) t0.el.classList.toggle('speaking', speaking.has(id));
  for (const el of cur.dock?.children || []) el.classList.toggle('speaking', speaking.has(Number(el.dataset.uid)));
}

function announce() {
  const v = cur.local.getVideoTracks().some((x) => x.readyState === 'live');
  wsSend({ type: 'gcall.media', chat_id: cur.chatId, audio: cur.audioOn, video: v });
}

async function toggleCamera(btn) {
  const tracks = cur.local.getVideoTracks();
  if (tracks.length) {
    for (const tr of tracks) { tr.stop(); cur.local.removeTrack(tr); }
    for (const p of cur.peers.values()) for (const s of p.pc?.getSenders() || []) if (s.track?.kind === 'video') s.replaceTrack(null).catch(() => {});
    btn.classList.add('off');
  } else {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 }, facingMode: 'user' } });
      const tr = st.getVideoTracks()[0];
      cur.local.addTrack(tr);
      for (const p of cur.peers.values()) {
        const tv = p.pc?.getTransceivers().find((x) => x.receiver.track.kind === 'video');
        if (tv) { tv.direction = 'sendrecv'; await tv.sender.replaceTrack(tr).catch(() => {}); }
      }
      btn.classList.remove('off');
    } catch { toast(t('call.cam_denied'), 5000); }
  }
  announce();
  drawTiles();
}

/** One persistent tile per participant (re-creating <video> would restart playback on every state change). */
function tileFor(user, local) {
  cur.tiles ||= new Map();
  let t0 = cur.tiles.get(user.id);
  if (!t0) {
    const vid = h('video', { autoplay: true, playsInline: true });
    vid.muted = !!local;
    const name = h('div', { class: 'gc-name' });
    const el = h('div', { class: 'gc-tile' }, vid, h('div', { class: 'gc-avatar' }, avatar(user, 'lg')), name);
    t0 = { el, vid, name };
    cur.tiles.set(user.id, t0);
  }
  return t0;
}

function paint(t0, user, { stream, local, audio, video, connecting }) {
  if (stream && t0.vid.srcObject !== stream) t0.vid.srcObject = stream;
  const cam = !!video && !!stream && stream.getVideoTracks().length > 0;
  t0.el.classList.toggle('has-video', cam);
  t0.el.classList.toggle('connecting', !!connecting);
  clear(t0.name).append(...[audio === false ? h('span', { class: 'gc-muted' }, icon('mic', 14)) : null, local ? t('gcall.you') : user.name].filter(Boolean));
}

function drawTiles() {
  if (!cur?.grid) return;
  const order = [];
  const camOn = cur.local.getVideoTracks().some((x) => x.readyState === 'live');
  const mine = tileFor(S.me, true);
  paint(mine, S.me, { stream: cur.local, local: true, audio: cur.audioOn, video: camOn });
  order.push(mine.el);
  const live = new Set([S.me.id]);
  for (const p of cur.peers.values()) {
    live.add(p.user.id);
    const t0 = tileFor(p.user, false);
    paint(t0, p.user, { stream: p.stream, audio: p.audio, video: p.video, connecting: p.pc && p.pc.connectionState !== 'connected' });
    order.push(t0.el);
  }
  for (const id of [...cur.tiles.keys()]) if (!live.has(id)) cur.tiles.delete(id);
  if (cur.dock) {
    clear(cur.dock).append(...[S.me, ...[...cur.peers.values()].map((p) => p.user)].map((u) => h('div', { class: `gc-dock-user${cur.speaking?.has(u.id) ? ' speaking' : ''}`, dataset: { uid: String(u.id) }, title: u.name }, avatar(u, 'sm'))));
  }
  order.forEach((el, i) => { if (cur.grid.children[i] !== el) cur.grid.insertBefore(el, cur.grid.children[i] || null); });
  for (const ch of [...cur.grid.children]) if (!order.includes(ch)) ch.remove();
  cur.grid.dataset.n = String(Math.min(order.length, 6));
}

export function leaveGroupCall() {
  if (!cur) return;
  wsSend({ type: 'gcall.leave', chat_id: cur.chatId });
  teardown();
}

function teardown() {
  try { window.SuhbatNative?.callAudio?.(false, false); } catch { /* ignore */ }
  if (!cur) return;
  clearInterval(cur.timer);
  clearInterval(cur.meter);
  try { cur.ac?.close(); } catch { /* ignore */ }
  for (const p of cur.peers.values()) { try { p.pc?.close(); } catch { /* ignore */ } }
  cur.local.getTracks().forEach((x) => x.stop());
  cur.ui?.remove();
  cur = null;
  fire('gcalls');
}

export const groupCallChatId = () => cur?.chatId ?? null;
