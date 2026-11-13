// "Nearby": files and messages straight between devices.
// - Android app, no internet needed: Bluetooth + Wi-Fi through Google Nearby Connections (the transfer itself lives in NearbyBridge.java).
// - A room: one Android phone raises its own Wi-Fi and serves a page, so iPhones, computers and phones without the app can take and add files.
// - Over the internet, on every platform: see direct.js.
// Nothing here goes to the server. The module also runs on the offline page of the app (apps/mobile/www), so it may not import the chat.
import { h, clear, formatBytes, formatDuration } from './dom.js';
import { t } from './i18n.js';
import { S } from './state.js';
import { icon } from './icons.js';
import { avatar, confirmDialog, modal, toast } from './ui.js';
import { qrCanvas } from './qr.js';
import { api } from './net.js';
import { checkProof, makeProof, refreshTicket } from './identity.js';
import { lanBlocked, lanLabel, lanPeers, lanSend, lanSetOpen, lanSetReceiving, onLan } from './lan.js';
import { openPairing } from './pair.js';
import { barList, clearFinishedBars, deleteDirect, directBlob, directSaved, directSupported, finishedBars, listDirect, noteInChat, onBars, sendDirect, setBar, speedText } from './direct.js';

const native = () => window.SuhbatNative;
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const put = (el, ...kids) => el.append(...kids.flat().filter((k) => k !== null && k !== undefined && k !== false));
// the app from version 0.2.25 on; an older one (it updates itself soon) is treated like a browser
export const nativeApp = () => { try { return !!native()?.nearbyDeviceId; } catch { return false; } };
export const nearbyAvailable = () => { try { return nativeApp() && native().nearbySupported(); } catch { return false; } };
const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const kv = (k) => { try { return native().nearbyKvGet(k) || ''; } catch { return ''; } };
const kvSet = (k, v) => { try { native().nearbyKvSet(k, v); } catch { /* not the app */ } };

// ---------------------------------------------------------------- who is who
const clip = (s, bytes) => {
  const enc = new TextEncoder();
  let out = String(s);
  while (enc.encode(out).length > bytes) out = out.slice(0, -1);
  return out;
};
const deviceId = () => native().nearbyDeviceId();
const myName = () => S.me?.name || kv('name') || t('nb.my_phone');

/**
 * What a phone says about itself over the air. The name of a person is said aloud only while the Nearby screen is open;
 * the rest of the time just a salted hash, which only somebody who knows this person can match.
 */
const endpointAll = () => clip(`${deviceId()}|a|${S.me?.id || 0}|${myName()}`, 120);
const endpointRoom = (name) => clip(`${deviceId()}|r|${name}`, 120);
async function sha(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function endpointContacts() {
  const salt = Math.random().toString(36).slice(2, 8);
  return `${deviceId()}|c|${salt}|${await sha(`${salt}:${S.me.id}`)}`;
}

function parseEndpoint(s) {
  const p = String(s || '').split('|');
  const did = p[0] || String(s);
  if (p[1] === 'a') return { did, mode: 'a', uid: Number(p[2]) || 0, name: p.slice(3).join('|') || did };
  if (p[1] === 'r') return { did, mode: 'r', name: p.slice(2).join('|') || did };
  if (p[1] === 'c') return { did, mode: 'c', salt: p[2], hash: p[3], name: '' };
  return { did, mode: 'a', uid: 0, name: did };
}

// contacts: remembered, because they are needed exactly when there is no internet
function contacts() {
  const now = [...S.chats.values()].filter((c) => c.type === 'direct' && c.peer && !c.peer.is_bot && c.peer.id !== S.me?.id).map((c) => ({ id: c.peer.id, name: c.peer.name, chat: c.id }));
  if (now.length) { kvSet('contacts', JSON.stringify(now)); return now; }
  return parse(kv('contacts'), []);
}
const contactOf = (uid) => contacts().find((c) => c.id === uid) || null;

// ---------------------------------------------------------------- state fed by the native events
const found = new Map();       // endpoint id -> { did, mode, uid, name, contact }
const connected = new Map();   // endpoint id -> { did, name, code, nonce, uid, verified, auto, room }
const live = new Map();        // transfer id -> latest progress
const parts = new Map();       // long text in pieces: id -> { n, got: [] }
let view = null;               // the open screen
let screenOpen = false;
let pendingAfterPerm = null;

const eidOfDid = (did) => [...connected].find(([, p]) => p.did === did)?.[0] || null;
let sheetRedraw = null;
const redraw = () => { view?.redraw?.(); sheetRedraw?.(); };

/** Is this person within reach right now? */
export function nearbyPerson(uid) {
  for (const [id, p] of connected) if (p.verified && p.uid === uid) return { eid: id, did: p.did, connected: true };
  for (const [id, p] of found) if (p.contact?.id === uid) return { eid: id, did: p.did, connected: false };
  return null;
}

async function onFound(id, name) {
  const p = parseEndpoint(name);
  if (p.mode === 'c') {
    if (!crypto.subtle) return;
    for (const c of contacts()) {
      if (await sha(`${p.salt}:${c.id}`) === p.hash) { p.contact = c; p.uid = c.id; p.name = c.name; break; }
    }
    if (!p.contact) return; // a stranger's phone in contacts-only mode: not for us
  } else if (p.mode === 'a' && p.uid) {
    p.contact = contactOf(p.uid);
    if (p.contact) p.name = p.contact.name;
  }
  found.set(id, p);
  redraw();
}

function askConnection(ev) {
  if (ev.incoming === '1' && !receivingOn()) { native().nearbyReject(ev.id); return; }
  const p = parseEndpoint(ev.name);
  // a contact connects at once; the signed identity is checked right after, before anything is sent
  const claimed = p.mode === 'c' ? found.get(ev.id)?.contact : p.uid ? contactOf(p.uid) : null;
  let contact = claimed;
  if (!contact && p.mode === 'c') {
    (async () => {
      for (const c of contacts()) if (await sha(`${p.salt}:${c.id}`) === p.hash) { contact = c; break; }
      if (contact) { accepted.set(ev.id, { auto: true, claim: contact.id }); native().nearbyAccept(ev.id); } else native().nearbyReject(ev.id);
    })();
    return;
  }
  if (contact) {
    accepted.set(ev.id, { auto: true, claim: contact.id });
    native().nearbyAccept(ev.id);
    return;
  }
  let answered = false;
  let m = null;
  const done = (ok) => {
    if (answered) return;
    answered = true;
    if (ok) { accepted.set(ev.id, { auto: false }); native().nearbyAccept(ev.id); } else native().nearbyReject(ev.id);
    m?.close();
  };
  m = modal({
    title: ev.incoming === '1' ? t('nb.wants') : t('nb.confirm'),
    onClose: () => done(false),
    body: [h('p', null, ev.incoming === '1' ? t('nb.wants_text', { name: p.name }) : t('nb.confirm_text', { name: p.name })),
      h('div', { class: 'nb-code', 'aria-label': t('nb.code') }, ev.code), h('p', { class: 'muted' }, t('nb.code_hint')),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => done(false) }, t('nb.no')),
        h('button', { class: 'btn', type: 'button', onclick: () => done(true) }, t('nb.yes')))],
  });
}
const accepted = new Map();

function onConnected(ev) {
  const e = parseEndpoint(ev.name);
  const a = accepted.get(ev.id) || {};
  accepted.delete(ev.id);
  const prev = found.get(ev.id);
  const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
  const p = { did: e.did, name: prev?.name || e.name || e.did, code: ev.code, nonce, auto: !!a.auto, claim: a.claim, room: ev.room === '1' || e.mode === 'r', guest: ev.guest === '1' };
  connected.set(ev.id, p);
  found.delete(ev.id);
  native().nearbyLabel(ev.id, p.name);
  native().nearbySend(ev.id, JSON.stringify({ k: 'hi', n: nonce }));
  if (p.auto) {
    setTimeout(() => { if (connected.get(ev.id) === p && !p.verified) askDigits(ev.id, p); }, 8000);
  } else {
    native().nearbyReady(ev.id);
    flushTexts(ev.id);
    if (!p.room && !p.guest) toast(`${t('nb.connected')}: ${p.name}`);
  }
}

/** A contact whose signed identity could not be checked (it was never online with this version): the people compare the digits instead. */
function askDigits(eid, p) {
  let answered = false;
  const done = (ok) => {
    if (answered) return;
    answered = true;
    m.close();
    if (!ok) { native().nearbyDisconnect(eid); return; }
    p.auto = false;
    native().nearbyReady(eid);
    flushWaiting(p);
    flushTexts(eid);
  };
  const m = modal({
    title: t('nb.confirm'),
    onClose: () => done(false),
    body: [h('p', null, t('nb.confirm_text', { name: p.name })),
      h('div', { class: 'nb-code', 'aria-label': t('nb.code') }, p.code), h('p', { class: 'muted' }, t('nb.code_hint')),
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => done(false) }, t('nb.no')),
        h('button', { class: 'btn', type: 'button', onclick: () => done(true) }, t('nb.yes')))],
  });
}

function flushWaiting(p) {
  const list = p.waiting || [];
  p.waiting = [];
  for (const ev of list) {
    if (p.verified && contactOf(p.uid)) native().nearbyAcceptFile(ev.tid, true);
    else askFile(ev);
  }
}

async function onAuth(eid, j) {
  const p = connected.get(eid);
  if (!p) return;
  const who = await checkProof(j, p.nonce, p.code);
  if (!who) return;
  if (p.claim && p.claim !== who.uid) { native().nearbyDisconnect(eid); toast(t('nb.not_verified', { name: p.name }), 6000); return; }
  p.verified = true;
  p.uid = who.uid;
  p.name = who.name;
  native().nearbyLabel(eid, who.name);
  if (contactOf(who.uid)) native().nearbyTrust(eid);
  else native().nearbyReady(eid);
  flushWaiting(p);
  flushTexts(eid);
  redraw();
}

function incomingText(eid, text) {
  const p = connected.get(eid);
  if (!p) return;
  const clean = String(text).slice(0, 1_000_000);
  native().nearbySaveText(p.did, p.name, 'in', clean);
  if (view?.chat?.did === p.did) view.reloadChat?.();
  else toast(`${t('nb.title')} · ${p.name}: ${clean.slice(0, 80)}`, 5000);
}

function onBytes(eid, data) {
  const j = parse(data, null);
  if (!j) return;
  if (j.k === 'hi') {
    const p = connected.get(eid);
    if (p && typeof j.n === 'string') makeProof(j.n, p.code).then((m) => native().nearbySend(eid, JSON.stringify(m))).catch(() => {});
  } else if (j.k === 'auth') onAuth(eid, j);
  else if (j.k === 't' && typeof j.text === 'string') incomingText(eid, j.text);
  else if (j.k === 'tx' && typeof j.s === 'string' && Number.isInteger(j.i) && Number.isInteger(j.n) && j.n > 0 && j.n <= 64) {
    const key = `${eid}:${j.id}`;
    const e = parts.get(key) || { n: j.n, got: [] };
    e.got[j.i] = j.s;
    parts.set(key, e);
    if (e.got.filter((x) => x !== undefined).length === e.n) { parts.delete(key); incomingText(eid, e.got.join('')); }
  }
}

const RISKY = /\.(apk|exe|msi|bat|cmd|scr|js|vbs|jar|ps1)$/i;

function askFile(ev) {
  if (!receivingOn()) { native().nearbyAcceptFile(ev.tid, false); return; }
  const p = connected.get(ev.id);
  if (p?.auto && !p.verified) { (p.waiting ||= []).push(ev); return; } // its identity is being checked this very moment
  let answered = false;
  const reply = (yes) => { if (answered) return; answered = true; native().nearbyAcceptFile(ev.tid, yes); m.close(); };
  const m = modal({
    title: t('nb.file_offer'),
    onClose: () => reply(false),
    body: [
      h('p', null, t('nb.file_offer_text', { name: p?.name || '' })),
      h('p', null, h('b', null, ev.name), ` · ${formatBytes(Number(ev.size) || 0)}`),
      RISKY.test(ev.name) ? h('p', { class: 'nb-warn' }, t('nb.risky')) : null,
      h('div', { class: 'row', style: { justifyContent: 'flex-end', gap: '8px' } },
        h('button', { class: 'btn secondary', type: 'button', onclick: () => reply(false) }, t('nb.no')),
        h('button', { class: 'btn', type: 'button', onclick: () => reply(true) }, t('nb.accept_file'))),
    ],
  });
}

function drawLive(tid) {
  const v = live.get(tid);
  if (!v) { setBar(`n-${tid}`, null); return; }
  setBar(`n-${tid}`, {
    title: v.name || t('nb.file'),
    note: speedText(v.bps) || (v.state ? t(STATE_KEY[v.state] || 'nb.st_active') : ''),
    pct: v.size ? Math.round(v.done * 100 / v.size) : 0,
    actions: [{ label: t('common.cancel'), onclick: () => { native().nearbyCancel(tid); live.delete(tid); drawLive(tid); } }],
  });
}

const STATE_KEY = { pending: 'nb.st_pending', offered: 'nb.st_offered', active: 'nb.st_active', paused: 'nb.st_paused', verifying: 'nb.st_verifying', failed: 'nb.st_failed', done: 'nb.st_done' };
const noted = () => parse(kv('noted'), []);
function onItem(ev) {
  const tid = ev.tid;
  const moving = ['pending', 'offered', 'active', 'verifying'].includes(ev.state);
  if (moving) {
    live.set(tid, { ...(live.get(tid) || { done: ev.done, bps: 0 }), name: ev.name, size: ev.size, state: ev.state });
    drawLive(tid);
  } else if (live.has(tid)) {
    live.delete(tid);
    drawLive(tid);
  }
  if (moving && ev.dir === 'in' && view?.tab?.() === 'near' && !view.chat) view.goTo('live'); // something is coming: the radar has done its job
  if (ev.state === 'paused') view?.transfers?.();
  // a file sent from a chat leaves a line there, also when the internet comes back much later
  if (ev.dir === 'out' && ev.state === 'done' && ev.chat_id > 0 && S.me) {
    const n = noted();
    if (!n.includes(tid)) {
      kvSet('noted', JSON.stringify([...n.slice(-200), tid]));
      noteInChat(ev.chat_id, ev.name, ev.size);
    }
  }
}

window.__nearby = (ev) => {
  if (!ev) return;
  switch (ev.type) {
    case 'perm':
      if (ev.granted === '1') { const f = pendingAfterPerm; pendingAfterPerm = null; f?.(); }
      else toast(t('nb.perm_denied'), 6000);
      break;
    case 'found': onFound(ev.id, ev.name); return;
    case 'lost': found.delete(ev.id); break;
    case 'stopped': found.clear(); break;
    case 'request': askConnection(ev); break;
    case 'connected': onConnected(ev); break;
    case 'refused': toast(t('nb.refused'), 4000); break;
    case 'disconnected': connected.delete(ev.id); break;
    case 'bytes': onBytes(ev.id, ev.data); break;
    case 'offer': askFile(ev); break;
    case 'item': onItem(ev); view?.transfers?.(); return;
    case 'progress': {
      const v = live.get(ev.tid) || {};
      live.set(ev.tid, { ...v, done: Number(ev.done), size: Number(ev.size), bps: Number(ev.bps) });
      drawLive(ev.tid);
      view?.transfers?.();
      return;
    }
    case 'file':
      live.delete(ev.tid);
      drawLive(ev.tid);
      if (view?.goTo && ['near', 'live'].includes(view.tab())) { view.goTo('got'); toast(t('nb.received_ok', { name: ev.name }), 3000); return; }
      toast(t('nb.received_ok', { name: ev.name }), 7000, view ? null : () => openNearby('got'));
      view?.reloadChat?.();
      break;
    case 'sent': view?.reloadChat?.(); break;
    case 'declined': toast(ev.why === 'nospace' ? t('nb.peer_no_space') : t('nb.declined_generic'), 5000); break;
    case 'nospace': toast(t('nb.no_space', { name: ev.name }), 6000); break;
    case 'transfer_failed': toast(t('nb.transfer_failed'), 5000); break;
    case 'saved': toast(ev.ok === '1' ? t('nb.saved_gallery') : t('nb.save_failed'), 4000); break;
    case 'shared': openSharedSheet(); return;
    case 'picked': view?.onPicked?.(); return;
    case 'room': view?.roomChanged?.(); return;
    case 'error': if (!['discover', 'advertise'].includes(ev.where) || screenOpen) toast(`${t('nb.error')} (${ev.where}${ev.code ? ` ${ev.code}` : ''})`, 6000); break;
    default:
  }
  redraw();
};

// ---------------------------------------------------------------- "Receive files": off means nobody can reach this device, it can still send
const RECEIVE_KEY = 'suhbat.nearby.receive';
function receivingOn() {
  try { return localStorage.getItem(RECEIVE_KEY) !== '0'; } catch { return true; }
}
function setReceiving(on) {
  try { localStorage.setItem(RECEIVE_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  lanSetReceiving(on);
  if (nearbyAvailable() && screenOpen && !roomOn()) native().nearbyStart(endpointAll(), on, true);
  if (!screenOpen) tick();
}
lanSetReceiving(receivingOn());

// ---------------------------------------------------------------- staying findable by contacts while the app is in front
async function tick() {
  if (!nearbyAvailable() || screenOpen || roomOn()) return;
  if (document.hidden) { native().nearbyStopFinding(); return; }
  if (!S.me || kv('auto') === '0' || !receivingOn() || !native().nearbyHasPermissions() || !crypto.subtle) return;
  refreshTicket();
  native().nearbyStart(await endpointContacts(), true, true);
}
document.addEventListener('visibilitychange', tick);
setTimeout(tick, 2500);

const roomOn = () => { try { return !!parse(native().nearbyRoomInfo(), {}).on; } catch { return false; } };

function restoreState() {
  if (!nativeApp()) return;
  const st = parse(native().nearbyState(), {});
  for (const f of st.found || []) onFound(f.id, f.name);
  for (const c of st.connected || []) {
    const e = parseEndpoint(c.name);
    const nonce = b64(crypto.getRandomValues(new Uint8Array(16)));
    connected.set(c.id, { did: e.did, name: c.label || e.name || e.did, code: c.code, nonce, room: c.room });
    native().nearbySend(c.id, JSON.stringify({ k: 'hi', n: nonce }));
  }
  for (const it of st.transfers || []) if (['active', 'verifying'].includes(it.state)) onItem(it);
}

/** The first run of this version: conversations of older versions move to the app's own storage. */
function importOld() {
  if (kv('imported')) return;
  kvSet('imported', '1');
  try {
    const rq = indexedDB.open('suhbat-nearby', 1);
    rq.onupgradeneeded = () => { const d = rq.result; d.createObjectStore('msgs', { keyPath: 'k', autoIncrement: true }).createIndex('peer', 'peer'); d.createObjectStore('peers', { keyPath: 'id' }); };
    rq.onsuccess = () => {
      const all = rq.result.transaction('msgs').objectStore('msgs').getAll();
      all.onsuccess = () => { if (all.result?.length) native().nearbyImportOld(JSON.stringify(all.result)); rq.result.close(); };
    };
  } catch { /* nothing to move */ }
}

if (nativeApp()) {
  try { importOld(); restoreState(); } catch { /* the rest of the app must start anyway */ }
  setTimeout(() => { if (parse(native().nearbySharedInfo(), {}).files?.length || parse(native().nearbySharedInfo(), {}).text) openSharedSheet(); }, 1500);
}

// ---------------------------------------------------------------- the counter
const totals = () => {
  const n = nativeApp() ? parse(native().nearbyStats(), {}) : {};
  const d = directSaved();
  return { bytes: (n.bytes || 0) + d.bytes, files: (n.files || 0) + d.files };
};
function savedBanner() {
  const s = totals();
  return h('div', { class: 'nb-saved' }, icon('bolt', 22),
    h('div', null, h('b', null, t('nb.saved_title', { size: formatBytes(s.bytes) })), h('small', { class: 'muted' }, t('nb.saved_files', { n: s.files }))));
}

// ---------------------------------------------------------------- from a chat
function pickWeb(onFiles, accept = '') {
  const input = h('input', { type: 'file', multiple: true, hidden: true, accept: accept || null, onchange: () => { onFiles([...input.files]); input.remove(); } });
  document.body.append(input);
  input.click();
}

/** The way a file can go to this person right now, for the menu of a personal chat. */
export function directRoute(chat) {
  const uid = chat?.peer?.id;
  if (chat?.type !== 'direct' || !uid || chat.peer.is_bot) return null;
  if (nearbyAvailable() && nearbyPerson(uid)) return 'nearby';
  return directSupported() && S.net === 'online' ? 'online' : null;
}

/** "Send directly" in a chat: past the server. Nearby first; then over the internet; a normal upload when no direct path exists. */
export function sendFromChat(chat, attachFiles) {
  const route = directRoute(chat);
  if (route === 'nearby') {
    const who = nearbyPerson(chat.peer.id);
    native().nearbyPickFiles(JSON.stringify([who.did]), chat.id);
    if (!who.connected) { accepted.set(who.eid, { auto: true, claim: chat.peer.id }); native().nearbyConnect(who.eid); }
    return;
  }
  if (route === 'online') {
    pickWeb((files) => sendDirect(chat.id, files, { fallback: (list) => attachFiles(chat.id, list) }));
    return;
  }
  toast(t('nb.no_route', { name: chat.peer?.name || '' }), 6000);
}

// ---------------------------------------------------------------- "Share" from another app
const CHAT_LIMIT = 8;
function openSharedSheet() {
  const info = parse(native().nearbySharedInfo(), {});
  const files = info.files || [];
  if (!files.length && !info.text) return;
  const total = files.reduce((a, f) => a + (f.size || 0), 0);
  const body = h('div', { class: 'nb' });
  let sent = false;
  const m = modal({ title: t('nb.share_title'), className: 'drive', body: [body], onClose: () => { sheetRedraw = null; if (!sent) native().nearbyClearShared(); if (!screenOpen) tick(); } });
  const done = () => { sent = true; m.close(); };
  const toChat = async (chatId) => {
    done();
    try {
      if (info.text && !files.length) { await api('POST', `/api/chats/${chatId}/messages`, { text: info.text.slice(0, 4000), client_id: crypto.randomUUID() }); }
      else {
        const list = [];
        for (const f of files) list.push(new File([await (await fetch(`/__nb/shared/${f.i}`)).blob()], f.name, { type: f.mime === 'null' ? '' : f.mime }));
        native().nearbyClearShared();
        const { attachFiles } = await import('./chat.js');
        window.__openChat?.(chatId);
        attachFiles(chatId, list);
      }
    } catch { toast(t('nb.transfer_failed'), 5000); }
  };
  const toPeer = (id, did, connectedNow) => {
    if (info.text && !files.length) {
      if (connectedNow) { sendText(id, info.text); native().nearbySaveText(did, connected.get(id).name, 'out', info.text); native().nearbyClearShared(); done(); toast(t('nb.delivered', { name: '' })); }
      return;
    }
    native().nearbySendShared(JSON.stringify([did]));
    if (!connectedNow) { const p = found.get(id); if (p?.contact) accepted.set(id, { auto: true, claim: p.contact.id }); native().nearbyConnect(id); }
    done();
    toast(t('nb.queued'));
  };
  const draw = () => {
    clear(body);
    const near = [...connected].map(([id, p]) => ({ id, did: p.did, name: p.name, on: true })).concat([...found].filter(([, p]) => p.mode !== 'r').map(([id, p]) => ({ id, did: p.did, name: p.name, on: false })));
    put(body,
      files.length ? h('p', null, h('b', null, files.length === 1 ? files[0].name : t('nb.n_files', { n: files.length })), ` · ${formatBytes(total)}`) : h('p', null, info.text.slice(0, 200)),
      h('h3', null, t('nb.found')),
      ...(near.length ? near.map((p) => h('button', { class: 'cal-row', type: 'button', onclick: () => toPeer(p.id, p.did, p.on) },
        icon('bolt', 20), h('span', { class: 'cal-main' }, h('b', null, p.name), h('small', { class: 'muted' }, t('nb.no_traffic'))))) : [h('p', { class: 'muted' }, t('nb.nobody'))]),
      ...lanPeers().map((p) => h('button', { class: 'cal-row', type: 'button', onclick: async () => {
        done();
        const list = [];
        for (const f of files) list.push(new File([await (await fetch(`/__nb/shared/${f.i}`)).blob()], f.name, { type: f.mime === 'null' ? '' : f.mime }));
        native().nearbyClearShared();
        lanSend(p.lid, list);
      } }, icon('bolt', 20), h('span', { class: 'cal-main' }, h('b', null, p.self ? t('nb.lan_my_device') : lanLabel(p)), h('small', { class: 'muted' }, t('nb.lan_title'))))),
      roomOn() && files.length ? h('button', { class: 'btn secondary', type: 'button', onclick: () => { native().nearbySendShared('["room"]'); done(); toast(t('nb.queued')); } }, t('nb.to_room')) : null,
      S.chats.size ? h('h3', null, t('nb.to_chat')) : null,
      ...[...S.chats.values()].sort((a, b) => (b.last_message?.created_at || 0) - (a.last_message?.created_at || 0)).slice(0, CHAT_LIMIT).map((c) => h('button', { class: 'cal-row', type: 'button', onclick: () => toChat(c.id) },
        h('span', { class: 'cal-main' }, h('b', null, c.type === 'direct' ? c.peer?.name : c.title)))));
  };
  sheetRedraw = draw;
  const stopLan = onLan(draw);
  const closeSheet = m.close;
  m.close = () => { stopLan(); if (!screenOpen) lanSetOpen(false); closeSheet(); };
  lanSetOpen(true);
  draw();
  ensureSearching(() => draw());
}

function ensureSearching(after) {
  if (!nearbyAvailable()) return;
  if (!native().nearbyHasPermissions()) { pendingAfterPerm = () => ensureSearching(after); native().nearbyStart(endpointAll(), true, true); return; }
  native().nearbyStart(endpointAll(), !roomOn(), true);
  after?.();
}

// ---------------------------------------------------------------- text
const waitingTexts = new Map(); // device -> texts to send as soon as it is connected and known
function queueText(did, name, text) {
  const eid = eidOfDid(did);
  const p = eid && connected.get(eid);
  if (p && (p.verified || !p.auto) && sendText(eid, text)) { native().nearbySaveText(did, name, 'out', text); return; }
  waitingTexts.set(did, [...(waitingTexts.get(did) || []), { name, text }]);
}
function flushTexts(eid) {
  const p = connected.get(eid);
  const list = p && waitingTexts.get(p.did);
  if (!list) return;
  waitingTexts.delete(p.did);
  for (const x of list) if (sendText(eid, x.text)) native().nearbySaveText(p.did, x.name, 'out', x.text);
}
const TEXT_PIECE = 20000;
function sendText(id, text) {
  if (new TextEncoder().encode(text).length <= 28000) return native().nearbySend(id, JSON.stringify({ k: 't', text }));
  const pieces = [];
  for (let i = 0; i < text.length; i += TEXT_PIECE / 2) pieces.push(text.slice(i, i + TEXT_PIECE / 2));
  if (pieces.length > 64) return false;
  const pid = Math.random().toString(36).slice(2, 8);
  return pieces.every((s, i) => native().nearbySend(id, JSON.stringify({ k: 'tx', id: pid, i, n: pieces.length, s })));
}

// ---------------------------------------------------------------- the screen
const isImage = (m) => /^image\//.test(m || '') && !/svg/.test(m);
const isVideo = (m) => /^video\//.test(m || '');
const isAudio = (m) => /^audio\//.test(m || '');

export async function openNearby(startTab = 'near') {
  if (view?.m) return;
  const heading = h('div', { class: 'nbx-head' });
  const content = h('div', { class: 'nb-content nbx-body' });
  const body = h('div', { class: 'nb nbx-wrap' }, heading, content);
  let tab = startTab;
  let draft = null;     // what is being prepared on the "send" screen
  let sendTarget = null;
  const urls = [];
  const m = modal({
    title: t('nb.title'),
    className: 'nbx',
    bare: true,
    body: [body],
    onClose: () => {
      screenOpen = false;
      stopBars?.();
      view?.lanStop?.();
      lanSetOpen(false);
      document.body.classList.remove('nb-open');
      if (draft?.kind === 'nearby') try { native().nearbyClearShared(); } catch { /* not the app */ }
      urls.forEach((u) => URL.revokeObjectURL(u));
      window.removeEventListener('suhbat:direct-received', onDirect);
      clearFinishedBars();
      view = null;
      tick();
    },
  });
  const onDirect = () => { if (tab === 'got') draw(); else if (tab === 'near' || tab === 'live') goTo('got'); };
  window.addEventListener('suhbat:direct-received', onDirect);
  screenOpen = true;
  document.body.classList.add('nb-open');
  view = { m, chat: null, tab: () => tab, goTo: (x) => goTo(x) };
  let onBarChange = null;
  const stopBars = onBars(() => onBarChange?.());

  const goTo = (next) => { tab = next; view.chat = null; draw(); };
  const header = (title, sub, ent, back = () => goTo('near')) => put(clear(heading),
    h('button', { class: 'icon-btn nbx-back', type: 'button', 'aria-label': t('nb.back'), onclick: back }, icon('back', 24)),
    ent ? avatar(ent) : null,
    h('div', { class: 'nbx-title' }, h('b', null, title), sub ? h('small', null, sub) : null),
  );
  const draw = () => {
    view.transfers = null;
    view.reloadChat = null;
    view.roomChanged = null;
    view.onPicked = null;
    view.lanStop?.();
    view.lanStop = null;
    onBarChange = null;
    view.redraw = () => {};
    heading.hidden = false;
    if (tab === 'got') { header(t('nb.tab_got')); drawReceived(); }
    else if (tab === 'room') { header(t('nb.tab_room')); drawRoom(); }
    else if (tab === 'send') drawSend();
    else if (tab === 'live') drawLive2();
    else if (view.chat) { heading.hidden = true; drawChat(view.chat); }
    else drawHome();
  };

  // ---- who can be reached right now: one list, however they are connected
  const entityOf = (uid, name) => {
    const peer = [...S.chats.values()].find((c) => c.type === 'direct' && c.peer?.id === uid)?.peer;
    return peer ? { ...peer, online: true } : { id: uid || name?.length || 0, name: name || '', online: true };
  };
  function targets() {
    const out = [];
    const uids = new Set();
    for (const p of lanPeers()) {
      if (p.uid) uids.add(p.uid);
      const name = p.self ? t('nb.lan_my_device') : lanLabel(p);
      out.push({ key: `l${p.lid}`, kind: 'lan', lid: p.lid, name, ent: entityOf(p.uid, name), note: t('nb.lan_title') });
    }
    if (nearbyAvailable()) {
      for (const [eid, p] of connected) {
        if (p.room || (p.uid && uids.has(p.uid))) continue;
        if (p.uid) uids.add(p.uid);
        out.push({ key: `n${eid}`, kind: 'nearby', eid, did: p.did, connected: true, name: p.name, ent: entityOf(p.uid, p.name), note: t('nb.near_note') });
      }
      for (const [eid, p] of found) {
        if (p.mode === 'r' || connected.has(eid) || (p.contact && uids.has(p.contact.id))) continue;
        if (p.contact) uids.add(p.contact.id);
        out.push({ key: `n${eid}`, kind: 'nearby', eid, did: p.did, connected: false, contact: p.contact, name: p.name, ent: entityOf(p.contact?.id || p.uid, p.name), note: t('nb.near_note') });
      }
    }
    if (directSupported() && S.net === 'online') {
      for (const c of S.chats.values()) {
        if (c.type !== 'direct' || !c.peer?.online || c.peer.is_bot || uids.has(c.peer.id)) continue;
        out.push({ key: `o${c.id}`, kind: 'online', chat: c, name: c.peer.name, ent: c.peer, note: t('chat.online') });
      }
    }
    return out;
  }

  const ROUTE = { nearby: 'nb.route_near', lan: 'nb.route_lan', online: 'nb.route_online' };

  // ---- the first screen: a radar, who is there, and the way to everything else
  function radioHints() {
    if (!nearbyAvailable()) return null;
    const r = parse(native().nearbyRadios(), {});
    const off = [];
    if (r.wifi === false) off.push(t('nb.turn_wifi'));
    if (r.bt === false) off.push(t('nb.turn_bt'));
    if (r.loc === false) off.push(t('nb.turn_loc'));
    return off.length ? h('p', { class: 'nb-warn' }, t('nb.turn_on', { what: off.join(', ') })) : null;
  }

  const SLOTS = [[-128, 40], [-38, 42], [52, 40], [142, 42], [-84, 30], [98, 30]];

  function drawHome() {
    header(t('nb.title'), null, null, () => m.close());
    clear(content);
    const dots = h('div', { class: 'nbr-dots' });
    const radar = h('div', { class: 'nbr', 'aria-hidden': 'true' },
      h('i', { class: 'nbr-ring r3' }), h('i', { class: 'nbr-ring r2' }), h('i', { class: 'nbr-ring r1' }), h('i', { class: 'nbr-sweep' }),
      h('img', { class: 'nbr-me', src: '/icon.svg?v=2', alt: '' }), dots);
    const status = h('b', { class: 'nbx-status', role: 'status' });
    const sub = h('small', { class: 'nbx-sub' });
    const live2 = h('div');
    const list = h('div', { class: 'nbx-card nbx-people' });
    const extra = h('div', { class: 'nbx-extra' });

    const fill = () => {
      const all = targets();
      clear(dots).append(...all.slice(0, SLOTS.length).map((x, i) => {
        const [deg, r] = SLOTS[i];
        const a = avatar(x.ent);
        a.classList.add('nbr-peer');
        a.style.left = `${50 + r * Math.cos(deg * Math.PI / 180)}%`;
        a.style.top = `${50 + r * Math.sin(deg * Math.PI / 180)}%`;
        return a;
      }));
      const near = all.filter((x) => x.kind !== 'online').length;
      status.textContent = near ? t('nb.found_n', { n: near }) : t('nb.searching_short');
      sub.textContent = nearbyAvailable() ? t('nb.radar_near') : t('nb.radar_wifi');
      clear(list).append(...(all.length ? all.map((x) => h('div', { class: 'nbx-person' }, avatar(x.ent),
        h('span', { class: 'drive-text' }, h('b', null, x.name), h('small', { class: 'muted' }, x.note)),
        h('button', { class: 'btn small', type: 'button', onclick: () => { sendTarget = x; startDraft(x); goTo('send'); } }, t('nb.send_btn')))) : [h('p', { class: 'muted nbx-empty' }, t('nb.lan_hint'))]));
      const rooms = nearbyAvailable() ? [...found].filter(([id, p]) => !connected.has(id) && p.mode === 'r') : [];
      const blocked = lanBlocked();
      const hints = radioHints();
      put(clear(extra),
        hints,
        blocked ? h('p', { class: 'nb-warn' }, t('nb.lan_blocked')) : null,
        nativeApp() && !nearbyAvailable() ? h('p', { class: 'nb-warn' }, t('nb.no_play_services')) : null,
        rooms.length ? h('div', { class: 'nbx-card' }, rooms.map(([id, p]) => h('div', { class: 'nbx-person' },
          h('span', { class: 'nbx-ico' }, icon('wifi', 22)),
          h('span', { class: 'drive-text' }, h('b', null, p.name), h('small', { class: 'muted' }, t('nb.room_label'))),
          h('button', { class: 'btn small', type: 'button', onclick: () => { native().nearbyJoinRoom(id); toast(t('nb.joining')); } }, t('nb.join'))))) : null);
    };
    const fillLive = () => {
      const n = barList().length;
      put(clear(live2), n ? h('button', { class: 'nbx-row nbx-live', type: 'button', onclick: () => goTo('live') }, icon('download', 22),
        h('span', { class: 'drive-text' }, h('b', null, t('nb.transfers')), h('small', { class: 'muted' }, t('nb.n_moving', { n }))), icon('chevron', 18)) : null);
    };
    fill();
    fillLive();
    view.lanStop = onLan(fill);
    view.redraw = fill;
    onBarChange = fillLive;

    const receive = h('input', { class: 'nbx-switch', type: 'checkbox', checked: receivingOn(), 'aria-label': t('nb.receive_title'), onchange: (e) => { setReceiving(e.target.checked); } });
    const total = totals();
    put(content,
      radar,
      h('div', { class: 'nbx-center' }, status, sub),
      live2,
      list,
      extra,
      h('label', { class: 'nbx-row' }, h('span', { class: 'nbx-ico' }, icon('send', 22)),
        h('span', { class: 'drive-text' }, h('b', null, t('nb.receive_title')), h('small', { class: 'muted' }, t('nb.receive_text'))), receive),
      typeof RTCPeerConnection === 'function' ? h('button', { class: 'btn nbx-qr', type: 'button', onclick: openPairing }, icon('qr', 20), t('nb.pair_open')) : null,
      h('div', { class: 'nbx-tiles' },
        h('button', { class: 'nbx-tile', type: 'button', onclick: () => goTo('got') }, icon('download', 22), h('span', null, t('nb.tab_got'))),
        nativeApp() ? h('button', { class: 'nbx-tile', type: 'button', onclick: () => goTo('room') }, icon('users', 22), h('span', null, t('nb.tab_room'))) : null),
      h('div', { class: 'nbx-row nbx-saved' }, h('span', { class: 'nbx-ico' }, icon('bolt', 22)),
        h('span', { class: 'drive-text' }, h('b', null, t('nb.saved_title', { size: formatBytes(total.bytes) })), h('small', { class: 'muted' }, t('nb.saved_files', { n: total.files })))));
    if (nearbyAvailable() && S.me) {
      const recent = parse(native().nearbyRecent(), []).filter((p) => p.id !== 'room-guest' && p.id !== 'wifi');
      if (recent.length) {
        content.append(h('h3', null, t('nb.recent')), h('div', { class: 'nbx-card' }, recent.slice(0, 8).map((p) => {
          const name = parseEndpoint(p.name).name || p.name;
          return h('button', { class: 'nbx-person nbx-plain', type: 'button', onclick: () => { view.chat = { did: p.id, name }; draw(); } },
            avatar({ id: name.length, name }), h('span', { class: 'drive-text' }, h('b', null, name), h('small', { class: 'muted' }, new Date(p.last).toLocaleString())));
        })));
      }
    }
  }

  // ---- what to send
  function startDraft(target) {
    if (draft?.kind === 'nearby') native().nearbyClearShared();
    draft = { kind: target.kind, items: [], text: '' };
  }

  const held = () => parse(native().nearbySharedInfo(), {}).files || [];

  /** A small picture of the file: the file itself for photos and videos, its type otherwise. */
  function thumbOf(name, mime, src) {
    const ext = (String(name).split('.').pop() || '').slice(0, 4).toUpperCase();
    if (src && isImage(mime)) return h('img', { class: 'nbx-thumb', src, alt: '' });
    if (src && isVideo(mime)) {
      const time = h('small', { class: 'nbx-time' });
      const v = h('video', { src: `${src}#t=0.5`, preload: 'metadata', muted: true, playsInline: true, onloadedmetadata: () => { if (Number.isFinite(v.duration)) time.textContent = formatDuration(v.duration); } });
      return h('span', { class: 'nbx-thumb' }, v, time);
    }
    const kind = /PDF/.test(ext) ? 'pdf' : /ZIP|RAR|7Z|TAR|GZ/.test(ext) ? 'zip' : /TXT|DOC|DOCX|RTF|MD/.test(ext) ? 'doc' : /XLS|XLSX|CSV/.test(ext) ? 'xls' : isVideo(mime) ? 'vid' : isImage(mime) ? 'img' : 'bin';
    return h('span', { class: `nbx-tile-file ${kind}` }, ext && ext !== String(name).toUpperCase() ? ext : icon('file', 20));
  }

  function drawSend() {
    const target = sendTarget;
    if (!target || !draft) { goTo('near'); return; }
    header(t('nb.send_to', { name: target.name }), null, null, () => {
      if (draft?.kind === 'nearby') native().nearbyClearShared();
      draft = null;
      goTo('near');
    });
    clear(content);
    const list = h('div', { class: 'nbx-card nbx-files' });
    const total = h('p', { class: 'muted nbx-total' });
    const sendBtn = h('button', { class: 'btn nbx-send', type: 'button', onclick: send }, icon('send', 20), t('nb.send_btn'));
    const usesHold = () => draft.kind === 'nearby' && !!native().nearbyPickHold;

    const rows = () => {
      if (draft.kind === 'nearby' && usesHold()) return held().map((f) => ({ name: f.name, size: f.size, mime: f.mime === 'null' ? '' : f.mime, src: `/__nb/shared/${f.i}`, remove: () => { native().nearbySharedRemove(f.i); fill(); } }));
      return draft.items.map((f, i) => {
        f.src ||= URL.createObjectURL(f);
        if (!urls.includes(f.src)) urls.push(f.src);
        return { name: f.name, size: f.size, mime: f.type, src: f.src, remove: () => { draft.items.splice(i, 1); fill(); } };
      });
    };
    function fill() {
      const all = rows();
      const bytes = all.reduce((a, f) => a + (f.size || 0), 0);
      const textBytes = draft.text ? new TextEncoder().encode(draft.text).length : 0;
      const row = (thumb, name, size, remove) => h('div', { class: 'nbx-file' }, thumb,
        h('span', { class: 'drive-text' }, h('b', null, name), h('small', { class: 'muted' }, size)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.delete'), onclick: remove }, '✕'));
      clear(list).append(...all.map((f) => row(thumbOf(f.name, f.mime, f.src), f.name, formatBytes(f.size || 0), f.remove)));
      if (draft.text) list.append(row(thumbOf('Текст.txt', 'text/plain'), draft.text.slice(0, 40), formatBytes(textBytes), () => { draft.text = ''; fill(); }));
      if (!all.length && !draft.text) list.append(h('p', { class: 'muted nbx-empty' }, t('nb.send_pick')));
      total.textContent = all.length || draft.text ? t('nb.send_total', { size: formatBytes(bytes + textBytes) }) : '';
      sendBtn.disabled = !all.length && !draft.text;
    }
    view.onPicked = fill;

    const pick = (accept, mime) => {
      if (draft.kind === 'nearby') {
        if (usesHold()) native().nearbyPickHold(mime);
        else { native().nearbyPickFiles(JSON.stringify([target.did]), target.kind === 'nearby' ? 0 : 0); connectIfNeeded(target); draft = null; goTo('live'); } // an app of version 0.2.25: the file goes as soon as it is chosen
        return;
      }
      pickWeb((files) => { draft.items.push(...files); fill(); }, accept);
    };
    const typing = () => {
      const ta = h('textarea', { class: 'input', rows: 5, maxLength: 1_000_000, value: draft.text, 'aria-label': t('nb.type_text') });
      const w = modal({ title: t('nb.type_text'), body: [ta, h('button', { class: 'btn', type: 'button', style: { width: '100%', marginTop: '8px' }, onclick: () => { draft.text = ta.value.trim(); w.close(); fill(); } }, t('common.ok'))] });
    };
    const kindBtn = (ico, label, fn) => h('button', { class: 'nbx-kind', type: 'button', onclick: fn }, icon(ico, 24), h('span', null, label));
    put(content,
      h('div', { class: 'nbx-kinds' },
        kindBtn('image', t('nb.f_photo'), () => pick('image/*', 'image/*')),
        kindBtn('video', t('nb.f_video'), () => pick('video/*', 'video/*')),
        kindBtn('file', t('nb.f_file'), () => pick('', '*/*')),
        kindBtn('edit', t('nb.f_text'), typing)),
      list, total, sendBtn,
      h('div', { class: 'nbx-row nbx-route' }, h('span', { class: 'nbx-ico' }, icon('bolt', 20)), h('span', { class: 'drive-text' }, h('b', null, t(ROUTE[draft.kind])))));
    fill();

    function send() {
      if (draft.kind === 'lan') {
        const files = [...draft.items];
        if (draft.text) files.push(new File([draft.text], 'Текст.txt', { type: 'text/plain' }));
        lanSend(target.lid, files);
      } else if (draft.kind === 'online') {
        const files = [...draft.items];
        if (draft.text) files.push(new File([draft.text], 'Текст.txt', { type: 'text/plain' }));
        import('./chat.js').then(({ attachFiles }) => sendDirect(target.chat.id, files, { fallback: (list2) => attachFiles(target.chat.id, list2) }));
      } else {
        if (held().length) native().nearbySendShared(JSON.stringify([target.did]));
        if (draft.text) queueText(target.did, target.name, draft.text);
        connectIfNeeded(target);
      }
      draft = null;
      goTo('live');
    }
  }

  function connectIfNeeded(target) {
    if (target.connected) return;
    if (target.contact) accepted.set(target.eid, { auto: true, claim: target.contact.id });
    native().nearbyConnect(target.eid);
  }

  // ---- what is moving
  function drawLive2() {
    const target = sendTarget;
    header(target?.name || t('nb.transfers'), target ? target.note : null, target?.ent);
    clear(content);
    const list = h('div', { class: 'nbx-card nbx-files' });
    const title = h('b', { class: 'nbx-status' });
    const speed = h('small', { class: 'nbx-sub' });
    const fill = () => {
      const bars = barList();
      const finished = finishedBars();
      const moving = bars.find((b) => b.pct > 0);
      title.textContent = bars.length ? t('nb.moving_title') : finished.length ? t('nb.done_title') : t('nb.nothing_moving');
      speed.textContent = moving?.note || '';
      clear(list).append(
        ...bars.map((b) => h('div', { class: 'nbx-file' }, thumbOf(b.title, ''),
          h('span', { class: 'drive-text' }, h('b', null, b.title),
            h('small', { class: 'muted' }, `${b.pct > 0 ? `${b.pct}%` : ''}${b.pct > 0 && b.note ? ' · ' : ''}${b.note || ''}`),
            h('span', { class: 'nb-track' }, h('i', { class: 'nb-bar', style: { width: `${b.pct}%` } }))),
          ...(b.actions || []).map((a) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': a.label, title: a.label, onclick: a.onclick }, '✕')))),
        ...finished.map((b) => h('div', { class: 'nbx-file' }, thumbOf(b.title, ''),
          h('span', { class: 'drive-text' }, h('b', null, b.title), h('small', { class: 'muted' }, t('nb.st_done'))),
          h('span', { class: 'nbx-ok' }, icon('check', 18)))));
      if (!bars.length && !finished.length) list.append(h('p', { class: 'muted nbx-empty' }, t('nb.nothing_moving_hint')));
      done.hidden = bars.length > 0 || !finished.length;
      phones.classList.toggle('idle', !bars.length);
    };
    const done = h('button', { class: 'btn nbx-send', type: 'button', onclick: () => { clearFinishedBars(); sendTarget = null; goTo('near'); } }, icon('check', 20), t('nb.done_title'));
    const phones = h('div', { class: 'nbx-phones', 'aria-hidden': 'true' }, h('i', { class: 'nbx-phone' }), h('span', { class: 'nbx-wave' }, icon('wifi', 28)), h('i', { class: 'nbx-phone' }));
    fill();
    onBarChange = fill;
    put(content,
      phones,
      h('div', { class: 'nbx-center' }, title, speed),
      list,
      done,
      target ? h('div', { class: 'nbx-row nbx-route' }, h('span', { class: 'nbx-ico' }, icon('bolt', 20)), h('span', { class: 'drive-text' }, h('b', null, t(ROUTE[target.kind])))) : null);
  }

  // ---- a conversation
  const previewOf = (rec) => {
    if (rec.dir !== 'in' || rec.state !== 'done') return null;
    const url = `/__nb/item/${rec.id}`;
    if (isImage(rec.mime)) return h('img', { class: 'nb-thumb', src: url, alt: rec.name, loading: 'lazy' });
    if (isVideo(rec.mime)) return h('video', { class: 'nb-thumb', src: url, controls: true, preload: 'metadata', playsInline: true });
    if (isAudio(rec.mime)) return h('audio', { src: url, controls: true });
    return null;
  };

  const bubble = (rec) => {
    const mine = rec.dir === 'out';
    if (rec.kind === 'file') {
      const v = live.get(rec.tid);
      const done = v?.done ?? rec.done ?? 0;
      return h('div', { class: `nb-msg ${mine ? 'out' : 'in'}` },
        h('div', { class: 'nb-file' }, previewOf(rec), h('span', null, `\u{1F4CE} ${rec.name}`),
          h('small', { class: 'muted' }, `${formatBytes(rec.size || 0)}${rec.state !== 'done' ? ` · ${t(STATE_KEY[rec.state] || 'nb.st_active')}` : ''}`),
          !['done', 'failed'].includes(rec.state) ? h('span', { class: 'nb-track' }, h('i', { class: 'nb-bar', style: { width: `${rec.size ? Math.round(done * 100 / rec.size) : 0}%` } })) : null,
          !mine && rec.state === 'done' ? h('button', { class: 'btn small', type: 'button', onclick: () => openItem(rec) }, t('nb.open')) : null,
          mine && rec.state === 'failed' ? h('button', { class: 'btn small', type: 'button', onclick: () => native().nearbyRetry(rec.tid) }, t('nb.retry')) : null),
        h('small', { class: 'nb-time' }, new Date(rec.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    }
    return h('div', { class: `nb-msg ${mine ? 'out' : 'in'}` }, h('span', null, rec.text),
      h('small', { class: 'nb-time' }, new Date(rec.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
  };

  function drawChat(chat) {
    clear(content);
    const list = h('div', { class: 'nb-list' });
    const fill = () => {
      clear(list).append(...parse(native().nearbyItems(chat.did), []).map(bubble));
      list.scrollTop = list.scrollHeight;
    };
    const input = h('textarea', { class: 'input', rows: 1, maxLength: 1_000_000, placeholder: t('chat.write'), 'aria-label': t('chat.write') });
    const online = () => eidOfDid(chat.did);
    const send = () => {
      const text = input.value.trim();
      const id = online();
      if (!text) return;
      if (!id) { toast(t('nb.offline_peer')); return; }
      if (!sendText(id, text)) { toast(t('nb.too_long')); return; }
      native().nearbySaveText(chat.did, chat.name, 'out', text);
      input.value = '';
      fill();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    const state = h('small', { class: 'muted' }, online() ? t('nb.connected') : t('nb.offline_peer'));
    content.append(
      h('div', { class: 'nb-head' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('nb.back'), onclick: () => { view.chat = null; draw(); } }, icon('back', 22)),
        h('b', null, chat.name), state),
      list,
      h('div', { class: 'nb-compose' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('chat.attach'), onclick: () => native().nearbyPickFiles(JSON.stringify([chat.did]), 0) }, icon('plus', 22)),
        input, h('button', { class: 'btn', type: 'button', onclick: send }, icon('send', 20))));
    fill();
    let queued = 0;
    const refill = () => { if (queued) return; queued = setTimeout(() => { queued = 0; if (view?.chat === chat) { fill(); state.textContent = online() ? t('nb.connected') : t('nb.offline_peer'); } }, 400); };
    view.transfers = refill;
    view.reloadChat = refill;
    const prev = view.redraw;
    view.redraw = () => { if (view.chat === chat) refill(); else prev(); };
  }

  // ---- everything that came in
  let filter = 'all';
  async function drawReceived() {
    clear(content);
    const nat = nativeApp() ? parse(native().nearbyReceived(), []) : [];
    const direct = await listDirect();
    const rows = [...nat.map((x) => ({ ...x, src: 'n', from: parseEndpoint(x.peer_name).name || x.peer_name })), ...direct.map((x) => ({ ...x, src: 'd' }))].sort((a, b) => b.ts - a.ts);
    const pass = (x) => filter === 'all' || (filter === 'photo' && isImage(x.mime)) || (filter === 'video' && isVideo(x.mime)) || (filter === 'file' && !isImage(x.mime) && !isVideo(x.mime));
    const chip = (id, label) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(filter === id), onclick: () => { filter = id; drawReceived(); } }, label);
    content.append(savedBanner(), h('div', { class: 'task-tabs' }, chip('all', t('nb.f_all')), chip('photo', t('nb.f_photo')), chip('video', t('nb.f_video')), chip('file', t('nb.f_file'))));
    const shown = rows.filter(pass);
    if (!shown.length) { content.append(h('p', { class: 'muted' }, t('nb.got_empty'))); return; }
    const grid = h('div', { class: 'nb-got' });
    content.append(grid);
    for (const it of shown) grid.append(await receivedCard(it));
  }

  async function urlOf(it) {
    if (it.src === 'n') return `/__nb/item/${it.id}`;
    const u = URL.createObjectURL(await directBlob(it));
    urls.push(u);
    return u;
  }

  function openItem(it) {
    const go = () => { if (!native().nearbyOpenItem(it.id)) toast(t('nb.cannot_open')); };
    if (RISKY.test(it.name)) confirmDialog(t('nb.risky'), { okLabel: t('nb.open') }).then((yes) => { if (yes) go(); });
    else go();
  }

  /** The web view keeps these files to itself; here they move to the app, where they can be opened, shared and saved to the gallery. */
  async function toPhone(it) {
    toast(t('nb.moving'));
    try {
      const blob = await directBlob(it);
      const handle = native().nearbyImportBegin(it.name, it.mime || '', it.from || '');
      const STEP = 3 * 1024 * 1024; // a multiple of 3: the pieces of base64 can be decoded one by one
      for (let pos = 0; pos < blob.size; pos += STEP) {
        const text = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] || '');
          r.onerror = () => reject(r.error);
          r.readAsDataURL(blob.slice(pos, pos + STEP));
        });
        if (!native().nearbyImportChunk(handle, text)) throw new Error('write');
      }
      const id = Number(native().nearbyImportEnd(handle));
      if (id <= 0) throw new Error('save');
      await deleteDirect(it.id);
      drawReceived();
    } catch { toast(t('nb.save_failed'), 5000); }
  }

  async function receivedCard(it) {
    let media = null;
    try {
      if (isImage(it.mime)) media = h('img', { class: 'nb-thumb', src: await urlOf(it), alt: it.name, loading: 'lazy' });
      else if (isVideo(it.mime)) media = h('video', { class: 'nb-thumb', src: await urlOf(it), controls: true, preload: 'metadata', playsInline: true });
      else if (isAudio(it.mime)) media = h('audio', { src: await urlOf(it), controls: true });
    } catch { /* the file is gone: the card still lets it be removed */ }
    const download = async () => {
      const a = h('a', { href: await urlOf(it), download: it.name });
      document.body.append(a);
      a.click();
      a.remove();
    };
    const remove = async () => {
      if (!await confirmDialog(t('nb.delete_ask', { name: it.name }), { danger: true })) return;
      if (it.src === 'n') native().nearbyDeleteItem(it.id); else await deleteDirect(it.id);
      drawReceived();
    };
    return h('div', { class: 'nb-card' }, media,
      h('b', null, it.name),
      h('small', { class: 'muted' }, `${formatBytes(it.size)} · ${it.from || ''} · ${new Date(it.ts).toLocaleDateString()}`),
      h('div', { class: 'nb-acts' },
        it.src === 'n'
          ? [h('button', { class: 'btn small', type: 'button', onclick: () => openItem(it) }, t('nb.open')),
            !it.gallery ? h('button', { class: 'btn small secondary', type: 'button', onclick: () => native().nearbySaveItem(it.id) }, t('nb.to_gallery')) : null,
            h('button', { class: 'btn small secondary', type: 'button', onclick: () => native().nearbyShareItem(it.id) }, t('nb.share'))]
          : nativeApp()
            ? [h('button', { class: 'btn small', type: 'button', onclick: () => toPhone(it) }, t('nb.to_phone'))]
            : [h('button', { class: 'btn small', type: 'button', onclick: download }, t('nb.download'))],
        h('button', { class: 'btn small secondary', type: 'button', onclick: remove }, t('common.delete'))));
  }

  // ---- a room
  function drawRoom() {
    clear(content);
    const info = parse(native().nearbyRoomInfo(), {});
    view.roomChanged = () => { if (tab === 'room') drawRoom(); };
    if (!info.on) {
      const name = h('input', { class: 'input', maxLength: 40, value: kv('room') || t('nb.room_default', { name: myName() }), 'aria-label': t('nb.room_name') });
      const start = () => {
        const n = name.value.trim() || t('nb.room_default', { name: myName() });
        kvSet('room', n);
        pendingAfterPerm = start;
        native().nearbyRoomStart(n, endpointRoom(n));
        setTimeout(() => { if (parse(native().nearbyRoomInfo(), {}).on) { pendingAfterPerm = null; drawRoom(); } }, 300);
      };
      content.append(h('p', { class: 'muted' }, t('nb.room_intro')), h('label', null, t('nb.room_name'), name), h('button', { class: 'btn', type: 'button', onclick: start }, t('nb.open_room')));
      return;
    }
    const step = (title, text, qr) => h('div', { class: 'nb-step' }, h('b', null, title), text ? h('small', { class: 'muted' }, text) : null, qr ? qrCanvas(qr, 240) : null);
    put(content,
      h('div', { class: 'nb-head' }, h('b', null, info.name), h('small', { class: 'muted' }, t('nb.room_guests', { n: info.guests || 0 }))),
      h('div', { class: 'nb-steps' },
        info.wifi_qr ? step(t('nb.step_wifi'), `${info.ssid} · ${info.pass}`, info.wifi_qr) : null,
        info.url ? step(info.wifi_qr ? t('nb.step_page') : t('nb.step_same_wifi'), info.url, info.url) : h('p', { class: 'nb-warn' }, t('nb.room_no_network'))),
      info.hotspot_error ? h('p', { class: 'nb-warn' }, t('nb.hotspot_failed')) : null,
      h('button', { class: 'btn', type: 'button', onclick: () => native().nearbyRoomPick() }, t('nb.add_files')),
      h('h3', null, t('nb.room_files')),
      ...((info.files || []).length ? info.files.map((f) => h('div', { class: 'drive-row' }, h('span', { class: 'drive-text' }, h('b', null, f.name), h('small', { class: 'muted' }, formatBytes(f.size))))) : [h('p', { class: 'muted' }, t('nb.room_empty'))]),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => { if (await confirmDialog(t('nb.close_room_ask'), { danger: true })) { native().nearbyRoomStop(); drawRoom(); } } }, t('nb.close_room')));
  }

  draw();
  lanSetOpen(true);
  if (nearbyAvailable()) {
    pendingAfterPerm = () => { if (screenOpen && !roomOn()) { native().nearbyStart(endpointAll(), true, true); draw(); } };
    if (!roomOn()) {
      refreshTicket();
      if (native().nearbyStart(endpointAll(), true, true) === 'ok') pendingAfterPerm = null;
    }
  }
}
