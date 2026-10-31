// Direct transfer over the internet: a file goes from one device to the other through WebRTC, at any distance, on every platform.
// The server only passes the signalling between the two people of a personal chat and never sees the file.
// Only STUN is used: a relay would send the same bytes through paid servers, so when no direct path exists the sender is offered a normal upload.
import { h, formatBytes, uuid } from './dom.js';
import { t } from './i18n.js';
import { S } from './state.js';
import { api, flushOutbox, outbox, wsSend } from './net.js';
import { modal, toast } from './ui.js';

const SID = uuid();              // this tab or app: a person may have several devices, and the first to accept takes the file
const CHUNK = 64 * 1024;
const HIGH_WATER = 4 * 1024 * 1024;
const OPEN_TIMEOUT = 20_000;
const SLOW_ANSWER = 25_000;
const MAX_RETRIES = 5;
const OFFER_AGAIN = 8000;
const DIR = 'suhbat-direct';

export const directSupported = () => typeof RTCPeerConnection === 'function';

// ---------------------------------------------------------------- the small bar with what is moving (also used by nearby.js)
const bars = new Map();
let barRoot = null;

export function setBar(key, data) {
  if (data) bars.set(key, data); else bars.delete(key);
  if (!barRoot) {
    barRoot = h('div', { class: 'dx-bars', role: 'status' });
    document.body.append(barRoot);
  }
  barRoot.replaceChildren(...[...bars.values()].slice(-3).map((b) => h('div', { class: 'dx-bar' },
    h('div', { class: 'dx-line' }, h('b', null, b.title), b.note ? h('small', null, b.note) : null),
    b.pct >= 0 ? h('span', { class: 'nb-track' }, h('i', { class: 'nb-bar', style: { width: `${b.pct}%` } })) : null,
    b.actions?.length ? h('div', { class: 'dx-acts' }, b.actions.map((a) => h('button', { class: 'btn small secondary', type: 'button', onclick: a.onclick }, a.label))) : null)));
}

export const speedText = (bps) => (bps > 0 ? `${formatBytes(bps)}/${t('nb.sec')}` : '');

// ---------------------------------------------------------------- what came in stays on the device
let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    const rq = indexedDB.open('suhbat-direct', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('files', { keyPath: 'id' });
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
  return dbp;
}
const store = async (mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('files', mode);
    const r = fn(tx.objectStore('files'));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
};

async function opfs() {
  try { return await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true }); } catch { return null; }
}

/** Where the bytes go. On disk when the browser allows it (a broken transfer continues); otherwise in memory until the end. */
export async function openSink(tid) {
  const dir = await opfs();
  if (dir) {
    try {
      const handle = await dir.getFileHandle(tid, { create: true });
      if (handle.createWritable) {
        const offset = (await handle.getFile()).size;
        const w = await handle.createWritable({ keepExistingData: true });
        await w.seek(offset);
        return { offset, disk: true, write: (c) => w.write(c), done: () => w.close(), abort: () => w.close().catch(() => {}) };
      }
    } catch { /* memory below */ }
  }
  const parts = [];
  return { offset: 0, disk: false, write: async (c) => { parts.push(c); }, done: async () => {}, blob: (mime) => new Blob(parts, { type: mime }), abort: async () => { parts.length = 0; } };
}

export async function listDirect() {
  try { return ((await store('readonly', (s) => s.getAll())) || []).sort((a, b) => b.ts - a.ts); } catch { return []; }
}

export async function directBlob(item) {
  if (item.blob) return item.blob;
  const dir = await opfs();
  const f = await (await dir.getFileHandle(item.id)).getFile();
  return f.slice(0, f.size, item.mime || f.type);
}

export async function deleteDirect(id) {
  try { await (await opfs())?.removeEntry(id); } catch { /* already gone */ }
  await store('readwrite', (s) => s.delete(id)).catch(() => {});
}

/** A finished file joins the list of what was received. */
export async function saveDirectItem(item, sink) {
  if (!sink.disk) item.blob = sink.blob(item.mime);
  await store('readwrite', (s) => s.put(item));
}

/** Unfinished pieces nobody continued for three days are dropped. */
async function sweepParts() {
  try {
    const dir = await opfs();
    if (!dir?.entries) return;
    const known = new Set((await listDirect()).map((x) => x.id));
    // anything still being written is younger than the limit below
    for await (const [name, handle] of dir.entries()) {
      if (known.has(name) || incoming.has(name)) continue;
      if (Date.now() - (await handle.getFile()).lastModified > 3 * 86_400_000) await dir.removeEntry(name);
    }
  } catch { /* the next start */ }
}

// ---------------------------------------------------------------- the traffic counter
const SAVED_KEY = 'suhbat.direct.saved';
export function directSaved() {
  try { return JSON.parse(localStorage.getItem(SAVED_KEY)) || { bytes: 0, files: 0 }; } catch { return { bytes: 0, files: 0 }; }
}
export function addSaved(bytes) {
  const s = directSaved();
  s.bytes += bytes;
  s.files += 1;
  try { localStorage.setItem(SAVED_KEY, JSON.stringify(s)); } catch { /* private mode */ }
}

/** True when the two devices talk over the same local network: nothing went through the internet connection. */
export async function wentLocally(pc) {
  try {
    const stats = await pc.getStats();
    for (const r of stats.values()) {
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        return stats.get(r.localCandidateId)?.candidateType === 'host' && stats.get(r.remoteCandidateId)?.candidateType === 'host';
      }
    }
  } catch { /* unknown counts as not saved */ }
  return false;
}

// ---------------------------------------------------------------- a line in the chat: the file itself does not go to the server
export function noteInChat(chatId, name, size) {
  const text = `⚡ ${t('nb.chat_note', { name, size: formatBytes(size) })}`;
  const clientId = uuid();
  api('POST', `/api/chats/${chatId}/messages`, { text, client_id: clientId }).catch((e) => {
    if (e.status === 0) { outbox.add({ chat_id: chatId, text, client_id: clientId }); flushOutbox(); }
  });
}

// ---------------------------------------------------------------- signalling
let ice = null;
export async function iceServers() {
  if (ice) return ice;
  let list = [];
  try { list = (await api('GET', '/api/config')).ice_servers || []; } catch { /* the default below */ }
  const stun = list.flatMap((s) => [].concat(s.urls || s.url || [])).filter((u) => /^stuns?:/i.test(u));
  ice = [{ urls: stun.length ? stun : ['stun:stun.l.google.com:19302'] }];
  return ice;
}

const signal = (chatId, data) => wsSend({ type: 'direct.signal', chat_id: chatId, data: { ...data, from: SID } });

const outgoing = new Map();   // tid -> task
const incoming = new Map();   // tid -> task
const queues = new Map();     // chatId -> tid[]: one file at a time per chat

function newPeerConnection(task, chatId, to) {
  return iceServers().then((servers) => {
    const pc = new RTCPeerConnection({ iceServers: servers });
    pc.onicecandidate = (e) => { if (e.candidate) signal(chatId, { t: 'ice', tid: task.tid, to, c: e.candidate.toJSON() }); };
    return pc;
  });
}

const closePc = (task) => {
  clearTimeout(task.openTimer);
  try { task.dc?.close(); } catch { /* closed */ }
  try { task.pc?.close(); } catch { /* closed */ }
  task.dc = null;
  task.pc = null;
};

async function addIce(task, c) {
  if (!task.pc?.remoteDescription) { (task.iceWait ||= []).push(c); return; }
  await task.pc.addIceCandidate(c).catch(() => {});
}
async function flushIce(task) {
  for (const c of task.iceWait || []) await task.pc.addIceCandidate(c).catch(() => {});
  task.iceWait = [];
}

// ---------------------------------------------------------------- sending
export function sendDirect(chatId, files, { fallback } = {}) {
  const q = queues.get(chatId) || [];
  queues.set(chatId, q);
  for (const file of files) {
    const task = { tid: uuid(), chatId, file, size: file.size, sent: 0, retries: 0, fallback, started: 0, last: 0, bps: 0 };
    outgoing.set(task.tid, task);
    q.push(task.tid);
    drawOut(task, t('nb.waiting_accept'));
  }
  nextOut(chatId);
}

function nextOut(chatId) {
  const q = queues.get(chatId);
  if (!q?.length || outgoing.get(q[0])?.running) return;
  const task = outgoing.get(q[0]);
  if (!task) { q.shift(); nextOut(chatId); return; }
  task.running = true;
  offerFile(task);
}

function offerFile(task) {
  const send = () => signal(task.chatId, { t: 'offer', tid: task.tid, name: task.file.name, size: task.size, mime: task.file.type, first: !task.offered });
  send();
  task.offered = true;
  clearTimeout(task.slowTimer);
  task.slowTimer = setTimeout(() => { if (!task.pc) drawOut(task, t('nb.no_answer'), true); }, SLOW_ANSWER);
  // the app of the other person may be closed: they get a notification, open it, and find the offer still standing
  clearInterval(task.offerTimer);
  task.offerTimer = setInterval(() => { if (!task.pc && outgoing.has(task.tid)) send(); else clearInterval(task.offerTimer); }, OFFER_AGAIN);
}

function endOut(task) {
  clearTimeout(task.slowTimer);
  clearInterval(task.offerTimer);
  closePc(task);
  outgoing.delete(task.tid);
  setBar(`d-${task.tid}`, null);
  const q = queues.get(task.chatId);
  if (q) { const i = q.indexOf(task.tid); if (i >= 0) q.splice(i, 1); }
  nextOut(task.chatId);
}

function drawOut(task, note, offerServer = false) {
  setBar(`d-${task.tid}`, {
    title: task.file.name,
    note,
    pct: task.size ? Math.round(task.sent * 100 / task.size) : 0,
    actions: [
      ...(offerServer && task.fallback ? [{ label: t('nb.via_server'), onclick: () => { const { fallback, file } = task; signal(task.chatId, { t: 'cancel', tid: task.tid }); endOut(task); fallback([file]); } }] : []),
      { label: t('common.cancel'), onclick: () => { signal(task.chatId, { t: 'cancel', tid: task.tid }); endOut(task); } },
    ],
  });
}

async function connectOut(task, to, offset) {
  clearTimeout(task.slowTimer);
  clearInterval(task.offerTimer);
  signal(task.chatId, { t: 'taken', tid: task.tid, by: to });
  closePc(task);
  task.peerSid = to;
  task.sent = offset;
  drawOut(task, t('nb.connecting_direct'));
  const pc = await newPeerConnection(task, task.chatId, to);
  task.pc = pc;
  const dc = pc.createDataChannel('file', { ordered: true });
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = HIGH_WATER / 2;
  task.dc = dc;
  task.openTimer = setTimeout(() => {
    if (dc.readyState !== 'open') { closePc(task); drawOut(task, t('nb.no_direct_path'), true); }
  }, OPEN_TIMEOUT);
  dc.onopen = () => { clearTimeout(task.openTimer); pumpFile(task, dc, offset); };
  dc.onmessage = async (e) => {
    if (e.data !== 'ok' || task.finished) return;
    task.finished = true;
    if (await wentLocally(pc)) addSaved(task.size);
    toast(t('nb.delivered', { name: task.file.name }));
    noteInChat(task.chatId, task.file.name, task.size);
    endOut(task);
  };
  dc.onclose = () => {
    if (task.finished || task.dc !== dc) return;
    closePc(task);
    if (task.retries++ < MAX_RETRIES) { drawOut(task, t('nb.reconnecting')); setTimeout(() => { if (outgoing.has(task.tid)) offerFile(task); }, 2000); }
    else drawOut(task, t('nb.no_direct_path'), true);
  };
  await pc.setLocalDescription(await pc.createOffer());
  signal(task.chatId, { t: 'sdp', tid: task.tid, to, sdp: pc.localDescription.sdp, kind: 'offer' });
}

async function pumpFile(task, dc, offset) {
  let pos = offset;
  task.last = Date.now();
  let lastBytes = pos;
  while (pos < task.size && dc.readyState === 'open') {
    if (dc.bufferedAmount > HIGH_WATER) {
      await new Promise((r) => { dc.onbufferedamountlow = r; setTimeout(r, 1000); });
      continue;
    }
    const buf = await task.file.slice(pos, pos + CHUNK).arrayBuffer();
    if (dc.readyState !== 'open') return;
    dc.send(buf);
    pos += buf.byteLength;
    task.sent = pos;
    const now = Date.now();
    if (now - task.last > 400) {
      task.bps = (pos - lastBytes) * 1000 / (now - task.last);
      lastBytes = pos;
      task.last = now;
      drawOut(task, speedText(task.bps));
    }
  }
  if (dc.readyState === 'open') { dc.send('end'); drawOut(task, t('nb.finishing')); }
}

// ---------------------------------------------------------------- receiving
function drawIn(task, note) {
  setBar(`d-${task.tid}`, {
    title: task.name,
    note,
    pct: task.size ? Math.round(task.got * 100 / task.size) : 0,
    actions: [{ label: t('common.cancel'), onclick: () => { signal(task.chatId, { t: 'decline', tid: task.tid, to: task.senderSid }); dropIn(task, true); } }],
  });
}

async function dropIn(task, removePart) {
  closePc(task);
  incoming.delete(task.tid);
  setBar(`d-${task.tid}`, null);
  await task.sink?.abort().catch(() => {});
  if (removePart) { try { await (await opfs())?.removeEntry(task.tid); } catch { /* none */ } }
}

async function acceptIn(task) {
  task.sink ||= await openSink(task.tid);
  task.got = task.sink.offset;
  drawIn(task, t('nb.connecting_direct'));
  signal(task.chatId, { t: 'accept', tid: task.tid, to: task.senderSid, offset: task.got });
}

function askIncoming(ev, d) {
  const sender = S.chats.get(ev.chat_id)?.peer?.name || '';
  const task = { tid: d.tid, chatId: ev.chat_id, senderSid: d.from, name: String(d.name || 'file').slice(0, 200), size: Number(d.size) || 0, mime: String(d.mime || '').slice(0, 100), sender, got: 0 };
  incoming.set(d.tid, task);
  let answered = false;
  task.closeAsk = () => { answered = true; incoming.delete(d.tid); m.close(); };
  const m = modal({
    title: t('nb.file_offer'),
    onClose: () => { if (!answered) { answered = true; signal(task.chatId, { t: 'decline', tid: d.tid, to: d.from }); incoming.delete(d.tid); } },
    body: [
      h('p', null, t('nb.file_offer_text', { name: sender })),
      h('p', null, h('b', null, task.name), ` · ${formatBytes(task.size)}`),
      h('p', { class: 'muted' }, t('nb.direct_note')),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close() }, t('nb.no')),
        h('button', { class: 'btn', type: 'button', onclick: () => { answered = true; task.closeAsk = null; task.accepted = true; m.close(); acceptIn(task); } }, t('nb.accept_file'))),
    ],
  });
}

async function onOfferSdp(task, sdp) {
  closePc(task);
  const pc = await newPeerConnection(task, task.chatId, task.senderSid);
  task.pc = pc;
  pc.ondatachannel = (e) => {
    const dc = e.channel;
    dc.binaryType = 'arraybuffer';
    task.dc = dc;
    let chain = Promise.resolve();
    let last = Date.now();
    let lastBytes = task.got;
    dc.onmessage = (m) => {
      if (typeof m.data === 'string') {
        if (m.data === 'end') chain = chain.then(() => finishIn(task, dc, pc));
        return;
      }
      task.got += m.data.byteLength;
      chain = chain.then(() => task.sink.write(m.data));
      const now = Date.now();
      if (now - last > 400) {
        const bps = (task.got - lastBytes) * 1000 / (now - last);
        lastBytes = task.got;
        last = now;
        drawIn(task, speedText(bps));
      }
    };
    dc.onclose = () => { if (!task.finished && incoming.has(task.tid)) drawIn(task, t('nb.reconnecting')); };
  };
  await pc.setRemoteDescription({ type: 'offer', sdp });
  await flushIce(task);
  await pc.setLocalDescription(await pc.createAnswer());
  signal(task.chatId, { t: 'sdp', tid: task.tid, to: task.senderSid, sdp: pc.localDescription.sdp, kind: 'answer' });
}

async function finishIn(task, dc, pc) {
  if (task.got !== task.size) { toast(t('nb.transfer_failed'), 5000); await dropIn(task, true); return; }
  task.finished = true;
  await task.sink.done();
  const item = { id: task.tid, name: task.name, size: task.size, mime: task.mime, ts: Date.now(), from: task.sender, chat_id: task.chatId };
  if (!task.sink.disk) item.blob = task.sink.blob(task.mime);
  await store('readwrite', (s) => s.put(item)).catch(() => toast(t('nb.save_failed'), 5000));
  if (await wentLocally(pc)) addSaved(task.size);
  try { dc.send('ok'); } catch { /* the sender may have left */ }
  closePc(task);
  incoming.delete(task.tid);
  setBar(`d-${task.tid}`, null);
  toast(t('nb.received_ok', { name: task.name }), 5000);
  window.dispatchEvent(new Event('suhbat:direct-received'));
}

// ---------------------------------------------------------------- events from the server
export async function handleDirectSignal(ev) {
  const d = ev.data;
  if (!d || typeof d.tid !== 'string' || !/^[\w-]{8,64}$/.test(d.tid) || d.from === SID) return;
  if (d.to && d.to !== SID) { // another device of this person took it
    if (d.t !== 'ice' && incoming.has(d.tid) && !incoming.get(d.tid).pc && !incoming.get(d.tid).sink) incoming.delete(d.tid);
    return;
  }
  const out = outgoing.get(d.tid);
  const inc = incoming.get(d.tid);
  try {
    switch (d.t) {
      case 'offer':
        // the same offer again: while the question is open, nothing; after a break in a transfer that was accepted, go on
        if (inc) { if (inc.accepted) { inc.senderSid = d.from; acceptIn(inc); } } else if (directSupported()) askIncoming(ev, d);
        break;
      case 'accept':
        if (out && !out.pc) await connectOut(out, d.from, Math.min(Number(d.offset) || 0, out.size));
        break;
      case 'taken': // another device of this person took the file
        if (d.by !== SID) inc?.closeAsk?.();
        break;
      case 'decline':
        if (out) { toast(t('nb.declined_file', { name: out.file.name }), 5000); endOut(out); }
        break;
      case 'cancel':
        if (inc) { toast(t('nb.cancelled_file', { name: inc.name }), 5000); dropIn(inc, true); }
        break;
      case 'sdp':
        if (typeof d.sdp !== 'string') break;
        if (d.kind === 'offer' && inc) await onOfferSdp(inc, d.sdp);
        else if (d.kind === 'answer' && out?.pc) { await out.pc.setRemoteDescription({ type: 'answer', sdp: d.sdp }); await flushIce(out); }
        break;
      case 'ice':
        if (d.c) await addIce(out || inc || {}, d.c);
        break;
      default:
    }
  } catch { /* a broken step ends in the retry or in the offer of a normal upload */ }
}

setTimeout(sweepParts, 15_000);
