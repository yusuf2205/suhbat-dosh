// The same Wi-Fi, in any browser, on an iPhone, in the Android app. A web page cannot look around its network by itself, so the server
// introduces devices that share a public address, as well as a person's contacts and own devices. Whoever has the app open is reachable;
// the search itself runs only while somebody has the "Nearby" screen open. Whether they really are on one network is proved by connecting, first
// with local addresses only. Names are not told by the server: they come over the direct connection, signed by it, and a device
// whose screen is closed says only what kind of device it is. With no server at all, two devices connect by showing each other a QR code (pair.js).
import { h, formatBytes, uuid } from './dom.js';
import { t } from './i18n.js';
import { S } from './state.js';
import { wsSend } from './net.js';
import { modal, toast } from './ui.js';
import { addSaved, iceServers, openSink, saveDirectItem, setBar, speedText, wentLocally } from './direct.js';
import { checkProof, makeProof, refreshTicket } from './identity.js';

const LID = uuid().replace(/-/g, '');
const CHUNK = 256 * 1024;
const READ = 4 * 1024 * 1024;       // read from disk and write to disk in big pieces: much faster, above all on phones
const HIGH_WATER = 8 * 1024 * 1024;
const WINDOW = 64 * 1024 * 1024;    // never more than this ahead of what the receiver has on disk
const ACK_EVERY = 16 * 1024 * 1024;
const TRY_MS = [5000, 9000];        // local addresses only; then with STUN, for networks that hide or block them
const AUTH_CODE = 'lan';

const peers = new Map();            // lid -> peer
const rx = new Map();               // tid -> receiving task
const listeners = new Set();
let started = false;
let open = false;           // the "Nearby" screen is open here
let stun = null;
let nets = [];              // this device's public addresses: one Wi-Fi may look like two networks, one over IPv4 and one over IPv6

export const onLan = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const changed = () => listeners.forEach((f) => f());
const signal = (to, data) => wsSend({ type: 'direct.lan.signal', to, data });
const introduce = () => wsSend({ type: 'direct.lan.join', lid: LID, open, nets });

/** Those who proved to be on this network. */
export const lanPeers = () => [...peers.values()].filter((p) => p.ready && (p.local || p.self));
/** Devices of the same address that could not be reached directly: the router separates them (a guest network). */
export const lanBlocked = () => open && [...peers.values()].some((p) => p.failed && p.same_ip);
export const lanLabel = (p) => p.name || p.label || t('nb.nearby_device');

function publicAddresses(servers) {
  return new Promise((resolve) => {
    const found = new Set();
    let pc = null;
    const done = () => { try { pc?.close(); } catch { /* closed */ } resolve([...found]); };
    try {
      pc = new RTCPeerConnection({ iceServers: servers });
      pc.createDataChannel('x');
      pc.onicecandidate = (e) => {
        if (!e.candidate) { done(); return; }
        const m = /\styp srflx\b/.test(e.candidate.candidate) ? e.candidate.candidate.split(' ')[4] : null;
        if (m) found.add(m);
      };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(done);
      setTimeout(done, 3000);
    } catch { done(); }
  });
}

/** Runs after every connection to the server: the device is reachable as long as the app is open. */
export async function lanStart() {
  if (typeof RTCPeerConnection !== 'function' || !S.me) return;
  introduce();
  if (!started) {
    started = true;
    stun = await iceServers();
    refreshTicket();
  }
  nets = await publicAddresses(stun);
  introduce();
}

export function lanSetOpen(on) {
  if (open === on) return;
  open = on;
  introduce();
  if (on) refreshTicket();
  // this device can say its name now: tell those it is already connected to
  if (on) for (const p of peers.values()) if (p.ready && p.theirNonce) sendProof(p);
  changed();
}

const deviceLabel = () => (/iPhone|iPad/.test(navigator.userAgent) ? 'iPhone' : /Android/.test(navigator.userAgent) ? 'Android' : t('nb.computer'));

async function sendProof(p) {
  const reveal = open || p.contact || p.self || p.qr;
  const proof = reveal ? await makeProof(p.theirNonce, AUTH_CODE) : {};
  if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify({ ...proof, t: 'auth', anon: !proof.ticket, label: deviceLabel() }));
}

const busy = (p) => p.out.length > 0 || [...rx.values()].some((r) => r.peer === p);

function dropPeer(p) {
  clearTimeout(p.timer);
  try { p.dc?.close(); } catch { /* closed */ }
  try { p.pc?.close(); } catch { /* closed */ }
  peers.delete(p.lid);
}

// ---------------------------------------------------------------- finding out who is really here
function onPeers(ev) {
  const seen = new Set();
  for (const info of ev.peers || []) {
    seen.add(info.lid);
    let p = peers.get(info.lid);
    if (!p) {
      p = { lid: info.lid, out: [], attempt: 0, iceWait: [], gone: 0 };
      peers.set(info.lid, p);
      Object.assign(p, info);
      if (LID < info.lid) connect(p, 0); // one side starts; the other answers
    } else {
      clearTimeout(p.goneTimer);
      Object.assign(p, info);
      if (p.failed && LID < info.lid) connect(p, 0);
    }
  }
  for (const p of [...peers.values()]) {
    if (seen.has(p.lid) || p.qr) continue;
    if (!busy(p)) { dropPeer(p); continue; }
    // the page was reloaded or the phone changed networks: what is moving waits a little
    p.goneTimer = setTimeout(() => { failTransfers(p); dropPeer(p); changed(); }, 30_000);
  }
  changed();
}

function closeLink(p) {
  clearTimeout(p.timer);
  if (p.dc) { p.dc.onclose = null; try { p.dc.close(); } catch { /* closed */ } }
  try { p.pc?.close(); } catch { /* closed */ }
  p.dc = null;
  p.pc = null;
  p.ready = false;
  p.sending = false;
}

/** The link broke: whoever started it connects again (the other side asks for that), and the transfer continues from what is on disk. */
function linkLost(p) {
  p.ready = false;
  p.sending = false;
  if (p.qr) { failTransfers(p); dropPeer(p); changed(); return; } // no server to find each other again
  changed();
  if (!peers.has(p.lid)) return;
  if (LID < p.lid) setTimeout(() => { if (peers.has(p.lid) && !p.ready) connect(p, 0); }, 1500);
  else signal(p.lid, { t: 'relink' });
}

function newPc(p, attempt) {
  const pc = new RTCPeerConnection({ iceServers: attempt === 0 ? [] : stun || [] });
  pc.onicecandidate = (e) => { if (e.candidate) signal(p.lid, { t: 'ice', c: e.candidate.toJSON(), a: attempt }); };
  pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && p.pc === pc && p.ready) linkLost(p); };
  return pc;
}

async function connect(p, attempt) {
  closeLink(p);
  p.attempt = attempt;
  p.failed = false;
  p.iceWait = [];
  try {
    const pc = newPc(p, attempt);
    p.pc = pc;
    wireChannel(p, pc.createDataChannel('files', { ordered: true }));
    armTimeout(p, attempt);
    await pc.setLocalDescription(await pc.createOffer());
    signal(p.lid, { t: 'sdp', kind: 'offer', sdp: pc.localDescription.sdp, a: attempt });
  } catch { armTimeout(p, attempt, 0); }
}

function armTimeout(p, attempt, ms = TRY_MS[attempt]) {
  clearTimeout(p.timer);
  p.timer = setTimeout(() => {
    if (p.ready) return;
    if (LID < p.lid && attempt === 0 && stun?.length) { connect(p, 1); return; }
    p.failed = true;
    changed();
  }, ms);
}

async function onSignal(ev) {
  const p = peers.get(ev.from);
  const d = ev.data;
  if (!p || !d) return;
  try {
    if (d.t === 'sdp' && d.kind === 'offer' && typeof d.sdp === 'string') {
      closeLink(p);
      p.attempt = d.a === 1 ? 1 : 0;
      p.failed = false;
      const pc = newPc(p, p.attempt);
      p.pc = pc;
      pc.ondatachannel = (e) => wireChannel(p, e.channel);
      armTimeout(p, p.attempt, TRY_MS[1] + 2000);
      await pc.setRemoteDescription({ type: 'offer', sdp: d.sdp });
      for (const c of p.iceWait.splice(0)) await pc.addIceCandidate(c).catch(() => {});
      await pc.setLocalDescription(await pc.createAnswer());
      signal(p.lid, { t: 'sdp', kind: 'answer', sdp: pc.localDescription.sdp, a: p.attempt });
    } else if (d.t === 'sdp' && d.kind === 'answer' && typeof d.sdp === 'string' && p.pc) {
      await p.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp });
      for (const c of p.iceWait.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
    } else if (d.t === 'relink') {
      if (LID < p.lid) connect(p, 0);
    } else if (d.t === 'ice' && d.c) {
      if (p.pc?.remoteDescription) await p.pc.addIceCandidate(d.c).catch(() => {});
      else p.iceWait.push(d.c);
    }
  } catch { /* the timeout moves on to the next try */ }
}

function wireChannel(p, dc) {
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = HIGH_WATER / 2;
  p.dc = dc;
  dc.onopen = () => {
    p.nonce = uuid();
    dc.send(JSON.stringify({ t: 'hi', n: p.nonce }));
  };
  dc.onmessage = (e) => { if (typeof e.data === 'string') onControl(p, dc, e.data); else onChunk(p, e.data); };
  dc.onclose = () => {
    if (p.dc === dc) linkLost(p);
  };
}

// ---------------------------------------------------------------- what travels inside the connection
async function onControl(p, dc, text) {
  let j;
  try { j = JSON.parse(text); } catch { return; }
  switch (j.t) {
    case 'hi':
      p.theirNonce = j.n;
      await sendProof(p);
      break;
    case 'auth': {
      p.label = String(j.label || '').slice(0, 30);
      if (j.anon) {
        if (p.uid) { closeLink(p); p.failed = true; changed(); return; } // the server named this person: it must prove that
      } else {
        const who = await checkProof(j, p.nonce, AUTH_CODE);
        if (!who || (p.uid && p.uid !== who.uid)) { closeLink(p); p.failed = true; changed(); return; }
        p.uid = who.uid;
        p.name = who.name;
        p.self = who.uid === S.me?.id;
      }
      clearTimeout(p.timer);
      p.local = p.qr || p.same_ip || await wentLocally(p.pc);
      p.ready = true;
      changed();
      nextOut(p);
      break;
    }
    case 'offer': onOffer(p, j); break;
    case 'accept': startOut(p, j.tid, Number(j.offset) || 0); break;
    case 'ack': { const o = p.out[0]; if (o?.tid === j.tid) { o.acked = Number(j.got) || 0; o.wake?.(); } break; }
    case 'decline': endOut(p, j.tid, j.why === 'nospace' ? t('nb.peer_no_space') : t('nb.declined_file', { name: nameOf(p, j.tid) })); break;
    case 'end': finishIn(p, j.tid); break;
    case 'ok': {
      const o = p.out.find((x) => x.tid === j.tid);
      if (o && p.local) addSaved(o.file.size);
      endOut(p, j.tid, t('nb.delivered', { name: o?.file.name || '' }));
      break;
    }
    case 'cancel': dropIn(j.tid, true, t('nb.cancelled_file', { name: rx.get(j.tid)?.name || '' })); break;
    default:
  }
}
const nameOf = (p, tid) => p.out.find((x) => x.tid === tid)?.file.name || '';

// ---------------------------------------------------------------- sending
export function lanSend(lid, files) {
  const p = peers.get(lid);
  if (!p) return;
  for (const file of files) {
    const o = { tid: uuid(), file, sent: 0, acked: 0 };
    p.out.push(o);
    drawOut(p, o, t('nb.waiting_accept'));
  }
  nextOut(p);
}

function drawOut(p, o, note) {
  setBar(`l-${o.tid}`, {
    title: o.file.name,
    note,
    pct: o.file.size ? Math.round(o.sent * 100 / o.file.size) : 0,
    actions: [{ label: t('common.cancel'), onclick: () => { if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify({ t: 'cancel', tid: o.tid })); endOut(p, o.tid); } }],
  });
}

function nextOut(p) {
  const o = p.out[0];
  if (!o || !p.ready || p.sending || p.dc?.readyState !== 'open') return;
  p.sending = true;
  p.dc.send(JSON.stringify({ t: 'offer', tid: o.tid, name: o.file.name, size: o.file.size, mime: o.file.type }));
  // somebody may think for a while, but not for ever; the queue behind this file must not wait
  clearTimeout(o.answerTimer);
  o.answerTimer = setTimeout(() => { if (p.out[0] === o && !o.sent && !o.started) endOut(p, o.tid, t('nb.no_answer')); }, 3 * 60_000);
}

function endOut(p, tid, message) {
  const i = p.out.findIndex((x) => x.tid === tid);
  if (i < 0) return;
  const [o] = p.out.splice(i, 1);
  o.stop = true;
  o.wake?.();
  setBar(`l-${tid}`, null);
  if (message) toast(message, 5000);
  if (i === 0) { p.sending = false; nextOut(p); }
}

/** Big messages cost much less work per byte, as far as the other side agreed to take them. */
function chunkFor(pc) {
  const max = pc?.sctp?.maxMessageSize;
  if (max === undefined) return 64 * 1024;
  return max > 0 ? Math.min(CHUNK, max) : CHUNK;
}

async function startOut(p, tid, offset) {
  const o = p.out[0];
  const dc = p.dc;
  if (o?.tid !== tid || !dc) return;
  const size = o.file.size;
  const chunk = chunkFor(p.pc);
  o.started = true;
  o.sent = Math.min(offset, size);
  o.acked = o.sent;
  let last = Date.now();
  let lastBytes = o.sent;
  try {
    while (o.sent < size && !o.stop && dc.readyState === 'open') {
      const piece = await o.file.slice(o.sent, o.sent + READ).arrayBuffer();
      for (let pos = 0; pos < piece.byteLength && !o.stop;) {
        if (dc.readyState !== 'open') return;
        if (dc.bufferedAmount > HIGH_WATER) {
          await new Promise((r) => { dc.onbufferedamountlow = r; setTimeout(r, 500); });
          continue;
        }
        const part = piece.slice(pos, pos + chunk);
        dc.send(part);
        pos += part.byteLength;
        o.sent += part.byteLength;
      }
      while (o.sent - o.acked > WINDOW && !o.stop && dc.readyState === 'open') {
        await new Promise((r) => { o.wake = r; setTimeout(r, 1000); });
      }
      const now = Date.now();
      if (now - last > 400) {
        drawOut(p, o, speedText((o.sent - lastBytes) * 1000 / (now - last)));
        last = now;
        lastBytes = o.sent;
      }
    }
    if (!o.stop && dc.readyState === 'open') {
      dc.send(JSON.stringify({ t: 'end', tid }));
      drawOut(p, o, t('nb.finishing'));
      setTimeout(() => { if (p.out.includes(o) && o.sent >= size) endOut(p, tid, t('nb.transfer_failed')); }, 10 * 60_000);
    }
  } catch {
    endOut(p, tid, t('nb.transfer_failed'));
  }
}

function failTransfers(p) {
  for (const o of [...p.out]) endOut(p, o.tid, t('nb.transfer_failed'));
  for (const r of [...rx.values()]) if (r.peer === p) dropIn(r.tid, true, t('nb.transfer_failed'));
}

// ---------------------------------------------------------------- receiving
/** The app is open but behind another window. */
function notifyHidden(title, body) {
  if (!document.hidden || !('serviceWorker' in navigator) || Notification?.permission !== 'granted') return;
  navigator.serviceWorker.ready.then((r) => r.showNotification(title, { body, icon: '/icon.svg?v=2', tag: 'lan-offer' })).catch(() => {});
}

function onOffer(p, j) {
  if (typeof j.tid !== 'string' || !/^[\w-]{8,64}$/.test(j.tid)) return;
  const cur = rx.get(j.tid);
  if (cur) { resumeIn(p, cur); return; } // the same file after a break
  const task = { tid: j.tid, peer: p, name: String(j.name || 'file').slice(0, 200), size: Number(j.size) || 0, mime: String(j.mime || '').slice(0, 100), got: 0, flushed: 0, buf: [], bufBytes: 0, chain: Promise.resolve(), lastAck: 0 };
  // your own device or a contact: at once, like in a chat
  if (p.self || p.contact) { acceptIn(p, task); return; }
  notifyHidden(t('nb.file_offer'), `${lanLabel(p)}: ${task.name}`);
  let answered = false;
  const reply = (yes) => {
    if (answered) return;
    answered = true;
    m.close();
    if (yes) acceptIn(p, task);
    else p.dc?.send(JSON.stringify({ t: 'decline', tid: task.tid }));
  };
  const m = modal({
    title: t('nb.file_offer'),
    onClose: () => reply(false),
    body: [
      h('p', null, t('nb.file_offer_text', { name: lanLabel(p) })),
      h('p', null, h('b', null, task.name), ` · ${formatBytes(task.size)}`),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => reply(false) }, t('nb.no')),
        h('button', { class: 'btn', type: 'button', onclick: () => reply(true) }, t('nb.accept_file'))),
    ],
  });
}

async function acceptIn(p, task) {
  rx.set(task.tid, task);
  try {
    if (navigator.storage?.estimate) {
      const { quota = 0, usage = 0 } = await navigator.storage.estimate();
      if (quota && quota - usage < task.size) throw new Error('space');
    }
    // with the browser's share of the disk used up, opening a file may never answer
    task.sink = await Promise.race([openSink(task.tid), new Promise((_, no) => { setTimeout(() => no(new Error('no answer')), 15_000); })]);
    task.got = task.sink.offset;
    task.flushed = task.got;
    task.last = Date.now();
    task.lastBytes = task.got;
    drawIn(task, '');
    p.dc?.send(JSON.stringify({ t: 'accept', tid: task.tid, offset: task.got }));
  } catch {
    rx.delete(task.tid);
    toast(t('nb.no_space', { name: task.name }), 6000);
    p.dc?.send(JSON.stringify({ t: 'decline', tid: task.tid }));
  }
}

function resumeIn(p, task) {
  task.peer = p;
  // what did not reach the disk is sent again
  task.chain = task.chain.then(() => {
    task.buf = [];
    task.bufBytes = 0;
    task.got = task.flushed;
    p.dc?.send(JSON.stringify({ t: 'accept', tid: task.tid, offset: task.flushed }));
  });
}

function drawIn(task, note) {
  setBar(`l-${task.tid}`, {
    title: task.name,
    note,
    pct: task.size ? Math.round(task.got * 100 / task.size) : 0,
    actions: [{ label: t('common.cancel'), onclick: () => { task.peer.dc?.send(JSON.stringify({ t: 'decline', tid: task.tid })); dropIn(task.tid, true); } }],
  });
}

function flush(task) {
  if (!task.bufBytes) return;
  const blob = new Blob(task.buf);
  const bytes = task.bufBytes;
  task.buf = [];
  task.bufBytes = 0;
  task.chain = task.chain.then(() => task.sink.write(blob)).then(() => {
    task.flushed += bytes;
    if (task.flushed - task.lastAck >= ACK_EVERY) {
      task.lastAck = task.flushed;
      if (task.peer.dc?.readyState === 'open') task.peer.dc.send(JSON.stringify({ t: 'ack', tid: task.tid, got: task.flushed }));
    }
  }).catch(() => {
    // the disk or the browser's share of it is full: the sender must not go on, and neither must anything wait for this file
    if (!rx.has(task.tid)) return;
    if (task.peer.dc?.readyState === 'open') task.peer.dc.send(JSON.stringify({ t: 'decline', tid: task.tid, why: 'nospace' }));
    dropIn(task.tid, true, t('nb.no_space', { name: task.name }));
  });
}

function onChunk(p, data) {
  const task = [...rx.values()].find((r) => r.peer === p && r.sink && !r.finished);
  if (!task) return;
  task.buf.push(data);
  task.bufBytes += data.byteLength;
  task.got += data.byteLength;
  if (task.bufBytes >= READ) flush(task);
  const now = Date.now();
  if (now - task.last > 400) {
    drawIn(task, speedText((task.got - task.lastBytes) * 1000 / (now - task.last)));
    task.last = now;
    task.lastBytes = task.got;
  }
}

function finishIn(p, tid) {
  const task = rx.get(tid);
  if (!task) return;
  task.finished = true;
  flush(task);
  task.chain = task.chain.then(async () => {
    if (!rx.has(tid)) return; // it failed on the way and was already dropped
    if (task.flushed !== task.size) throw new Error('size');
    await task.sink.done();
    await saveDirectItem({ id: tid, name: task.name, size: task.size, mime: task.mime, ts: Date.now(), from: lanLabel(p) }, task.sink);
    if (p.local) addSaved(task.size);
    rx.delete(tid);
    setBar(`l-${tid}`, null);
    p.dc?.send(JSON.stringify({ t: 'ok', tid }));
    toast(t('nb.received_ok', { name: task.name }), 5000);
    window.dispatchEvent(new Event('suhbat:direct-received'));
  }).catch(() => {
    // the sender is waiting for the answer
    if (p.dc?.readyState === 'open') p.dc.send(JSON.stringify({ t: 'decline', tid, why: 'nospace' }));
    dropIn(tid, true, t('nb.no_space', { name: task.name }));
  });
}

async function dropIn(tid, removePart, message) {
  const task = rx.get(tid);
  if (!task) return;
  rx.delete(tid);
  setBar(`l-${tid}`, null);
  await task.sink?.abort?.().catch?.(() => {});
  if (removePart) { const { deleteDirect } = await import('./direct.js'); await deleteDirect(tid); }
  if (message) toast(message, 5000);
}

// ---------------------------------------------------------------- with no server: the devices show each other a code
const SDP_DROP = /^(a=msid-semantic|a=extmap-allow-mixed|a=ice-options|a=setup:actpass-unused)/;

async function packSdp(sdp) {
  const text = sdp.split(/\r?\n/).filter((l) => l && !SDP_DROP.test(l) && !(l.startsWith('a=candidate') && / tcp /i.test(l))).join('\n');
  if (typeof CompressionStream !== 'function') return `SDP0.${btoa(unescape(encodeURIComponent(text)))}`;
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  return `SDP1.${btoa(String.fromCharCode(...bytes))}`;
}

async function unpackSdp(code) {
  const s = String(code || '').trim();
  const data = s.slice(5);
  let text;
  if (s.startsWith('SDP0.')) text = decodeURIComponent(escape(atob(data)));
  else if (s.startsWith('SDP1.')) {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    text = await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  } else throw new Error('bad code');
  return `${text.split('\n').join('\r\n')}\r\n`;
}

function waitForAddresses(pc) {
  return new Promise((resolve) => {
    if (pc.iceGatheringState === 'complete') { resolve(); return; }
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') resolve(); });
    setTimeout(resolve, 2500);
  });
}

function qrPeer() {
  const p = { lid: `qr-${uuid()}`, out: [], attempt: 0, iceWait: [], qr: true, same_ip: false };
  peers.set(p.lid, p);
  p.pc = new RTCPeerConnection({ iceServers: [] });
  let resolve;
  let reject;
  const ready = new Promise((a, b) => { resolve = a; reject = b; });
  const stop = onLan(() => { if (p.ready) { stop(); clearTimeout(limit); resolve(p); } else if (p.failed) { stop(); clearTimeout(limit); reject(new Error('failed')); } });
  const limit = setTimeout(() => { stop(); dropPeer(p); changed(); reject(new Error('timeout')); }, 120_000);
  return { p, ready };
}

/** The first device: a code to show. Then finish(answer) with what the other one shows. */
export async function pairCreate() {
  const { p, ready } = qrPeer();
  wireChannel(p, p.pc.createDataChannel('files', { ordered: true }));
  await p.pc.setLocalDescription(await p.pc.createOffer());
  await waitForAddresses(p.pc);
  return {
    code: await packSdp(p.pc.localDescription.sdp),
    ready,
    finish: async (answer) => p.pc.setRemoteDescription({ type: 'answer', sdp: await unpackSdp(answer) }),
  };
}

/** The second device: reads the code and gives its answer to show. */
export async function pairAnswer(offer) {
  const { p, ready } = qrPeer();
  p.pc.ondatachannel = (e) => wireChannel(p, e.channel);
  await p.pc.setRemoteDescription({ type: 'offer', sdp: await unpackSdp(offer) });
  await p.pc.setLocalDescription(await p.pc.createAnswer());
  await waitForAddresses(p.pc);
  return { code: await packSdp(p.pc.localDescription.sdp), ready };
}

// ---------------------------------------------------------------- from the server
export function handleLanEvent(ev) {
  if (ev.type === 'direct.lan.peers') onPeers(ev);
  else if (ev.type === 'direct.lan.signal') onSignal(ev);
}
