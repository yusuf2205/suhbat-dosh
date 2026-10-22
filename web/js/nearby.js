// "Nearby": messages and files between phones that are close to each other, with no internet at all
// (Android app only: Bluetooth + Wi-Fi Direct through Google Nearby Connections). A conversation lives on the two
// devices only; nothing goes to the server.
import { h, clear, formatBytes } from './dom.js';
import { t } from './i18n.js';
import { S } from './state.js';
import { icon } from './icons.js';
import { modal, toast } from './ui.js';

const native = () => window.SuhbatNative;
export const nearbyAvailable = () => { try { return !!native()?.nearbyStart && native().nearbySupported(); } catch { return false; } };

// ---------------------------------------------------------------- identity and storage
function deviceId() {
  try {
    let id = localStorage.getItem('suhbat.nearby.id');
    if (!id) { id = Math.random().toString(36).slice(2, 8); localStorage.setItem('suhbat.nearby.id', id); }
    return id;
  } catch { return 'dev000'; }
}
const myName = () => (S.me?.name || localStorage.getItem('suhbat.nearby.name') || 'Suhbat').slice(0, 40);
const endpointName = () => `${deviceId()}|${myName()}`;
const parseEndpoint = (s) => { const i = String(s).indexOf('|'); return i > 0 ? { did: s.slice(0, i), name: s.slice(i + 1) || s.slice(0, i) } : { did: String(s), name: String(s) }; };

let dbp = null;
function db() {
  dbp ||= new Promise((resolve, reject) => {
    try {
      const rq = indexedDB.open('suhbat-nearby', 1);
      rq.onupgradeneeded = () => {
        const d = rq.result;
        const m = d.createObjectStore('msgs', { keyPath: 'k', autoIncrement: true });
        m.createIndex('peer', 'peer');
        d.createObjectStore('peers', { keyPath: 'id' });
      };
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    } catch (e) { reject(e); }
  });
  return dbp;
}
const run = async (store, mode, fn) => {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, mode);
    const r = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(r?.result);
    tx.onerror = () => reject(tx.error);
  });
};
const saveMsg = (m) => run('msgs', 'readwrite', (s) => s.add(m)).catch(() => {});
const savePeer = (p) => run('peers', 'readwrite', (s) => s.put(p)).catch(() => {});
const history = (peer) => run('msgs', 'readonly', (s) => s.index('peer').getAll(peer)).then((x) => (x || []).sort((a, b) => a.ts - b.ts)).catch(() => []);
const peersList = () => run('peers', 'readonly', (s) => s.getAll()).then((x) => (x || []).sort((a, b) => b.last - a.last)).catch(() => []);

// ---------------------------------------------------------------- state fed by the native events
const found = new Map();       // endpointId -> { did, name }
const connected = new Map();   // endpointId -> { did, name }
let searching = false;
let view = null;               // the open dialog { m, body, chat: { eid, did } | null, redraw(), addMessage(msg) }
const prompts = new Set();

const peerOf = (eid) => connected.get(eid) || found.get(eid);
const eidOfDid = (did) => [...connected].find(([, p]) => p.did === did)?.[0] || null;

async function incoming(eid, msg) {
  const p = peerOf(eid) || { did: eid, name: eid };
  const rec = { peer: p.did, name: p.name, dir: 'in', ts: Date.now(), ...msg };
  await saveMsg(rec);
  await savePeer({ id: p.did, name: p.name, last: rec.ts });
  if (view?.chat?.did === p.did) view.addMessage(rec);
  else toast(`${t('nb.title')} · ${p.name}: ${rec.kind === 'file' ? `\u{1F4CE} ${rec.fileName}` : String(rec.text).slice(0, 80)}`, 5000);
}

function askConnection(ev) {
  if (prompts.has(ev.id)) return;
  prompts.add(ev.id);
  const p = parseEndpoint(ev.name);
  found.set(ev.id, p);
  let m = null;
  let answered = false;
  const done = (ok) => {
    if (answered) return;
    answered = true;
    prompts.delete(ev.id);
    if (ok) native().nearbyAccept(ev.id); else native().nearbyReject(ev.id);
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

window.__nearby = (ev) => {
  if (!ev) return;
  switch (ev.type) {
    case 'started': searching = true; break;
    case 'stopped': searching = false; found.clear(); break;
    case 'perm':
      if (ev.granted === '1') native().nearbyStart(endpointName());
      else toast(t('nb.perm_denied'), 6000);
      break;
    case 'found': found.set(ev.id, parseEndpoint(ev.name)); break;
    case 'lost': found.delete(ev.id); break;
    case 'request': askConnection(ev); break;
    case 'connected': {
      const p = parseEndpoint(ev.name || '');
      connected.set(ev.id, p);
      found.delete(ev.id);
      savePeer({ id: p.did, name: p.name, last: Date.now() });
      toast(`${t('nb.connected')}: ${p.name}`);
      break;
    }
    case 'refused': toast(t('nb.refused'), 4000); break;
    case 'disconnected': connected.delete(ev.id); break;
    case 'bytes': {
      try {
        const j = JSON.parse(ev.data);
        if (j.k === 't' && typeof j.text === 'string') incoming(ev.id, { kind: 'text', text: j.text.slice(0, 4000) });
      } catch { /* not ours */ }
      break;
    }
    case 'file': incoming(ev.id, { kind: 'file', fileName: ev.name, size: Number(ev.size) || 0, path: ev.path }); break;
    case 'sending': {
      const p = peerOf(ev.id);
      if (p) {
        const rec = { peer: p.did, name: p.name, dir: 'out', ts: Date.now(), kind: 'file', fileName: ev.name, size: Number(ev.size) || 0, pid: ev.pid };
        saveMsg(rec);
        if (view?.chat?.did === p.did) view.addMessage(rec);
      }
      break;
    }
    case 'progress': view?.progress?.(ev.pid, Number(ev.pct)); break;
    case 'sent': view?.progress?.(ev.pid, 100); break;
    case 'transfer_failed': toast(t('nb.transfer_failed'), 5000); break;
    case 'error': toast(`${t('nb.error')} (${ev.where}${ev.code ? ` ${ev.code}` : ''})`, 6000); searching = ['advertise', 'discover'].includes(ev.where) ? false : searching; break;
    default:
  }
  view?.redraw?.();
};

// ---------------------------------------------------------------- the dialog
function startSearch() {
  const r = native().nearbyStart(endpointName());
  if (r === 'unsupported') toast(t('nb.unsupported_device'), 6000);
  else if (r === 'ok') searching = true;
  view?.redraw();
}

export async function openNearby() {
  if (!nearbyAvailable()) {
    modal({ title: t('nb.title'), body: [h('p', null, t('nb.only_android')), h('p', { class: 'muted' }, t('nb.only_android_why'))] });
    return;
  }
  const body = h('div', { class: 'nb' });
  const state = { chat: null, recent: await peersList() };
  const m = modal({ title: t('nb.title'), className: 'drive', body: [body], onClose: () => { native().nearbyStopFinding(); searching = false; view = null; } });

  const bubble = (rec) => {
    const mine = rec.dir === 'out';
    const bar = rec.kind === 'file' && mine ? h('i', { class: 'nb-bar' }) : null;
    const el = h('div', { class: `nb-msg ${mine ? 'out' : 'in'}`, dataset: { pid: rec.pid || '' } },
      rec.kind === 'file'
        ? h('div', { class: 'nb-file' }, h('span', null, `\u{1F4CE} ${rec.fileName}`), h('small', { class: 'muted' }, formatBytes(rec.size || 0)),
          !mine && rec.path ? h('button', { class: 'btn small', type: 'button', onclick: () => { if (!native().nearbyOpenFile(rec.path)) toast(t('nb.cannot_open')); } }, t('nb.open')) : null,
          bar ? h('span', { class: 'nb-track' }, bar) : null)
        : h('span', null, rec.text),
      h('small', { class: 'nb-time' }, new Date(rec.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })));
    return el;
  };

  const drawList = () => {
    clear(body);
    const dev = [...found].filter(([id]) => !connected.has(id));
    body.append(
      h('p', { class: 'muted' }, t('nb.intro')),
      h('div', { class: 'row', style: { gap: '8px', marginBottom: '8px' } },
        searching
          ? h('button', { class: 'btn secondary', type: 'button', onclick: () => { native().nearbyStopFinding(); searching = false; drawList(); } }, t('nb.stop'))
          : h('button', { class: 'btn', type: 'button', onclick: startSearch }, `${t('nb.search')}`),
        connected.size ? h('button', { class: 'btn link', type: 'button', onclick: () => { native().nearbyStopAll(); connected.clear(); drawList(); } }, t('nb.disconnect_all')) : null),
      searching ? h('p', { class: 'nb-status', role: 'status' }, h('span', { class: 'tr-spin', 'aria-hidden': 'true' }), t('nb.searching')) : null,
      h('h3', null, t('nb.found')),
      ...(dev.length ? dev.map(([id, p]) => h('div', { class: 'drive-row' },
        h('span', { class: 'drive-text' }, h('b', null, p.name), h('small', { class: 'muted' }, t('nb.nearby_device'))),
        h('button', { class: 'btn small', type: 'button', onclick: () => { native().nearbyConnect(id); toast(t('nb.request_sent')); } }, t('nb.connect')))) : [h('p', { class: 'muted' }, searching ? t('nb.nobody') : t('nb.press_search'))]),
      h('h3', null, t('nb.connected_list')),
      ...(connected.size ? [...connected].map(([id, p]) => h('button', { class: 'cal-row', type: 'button', onclick: () => openChat(id, p) },
        h('span', { class: 'cal-main' }, h('b', null, p.name), h('small', { class: 'muted' }, t('nb.tap_chat'))), icon('chevron', 18))) : [h('p', { class: 'muted' }, t('nb.none_connected'))]),
      h('h3', null, t('nb.recent')),
      ...(state.recent.length ? state.recent.map((p) => h('button', { class: 'cal-row', type: 'button', onclick: () => openChat(eidOfDid(p.id), p, true) },
        h('span', { class: 'cal-main' }, h('b', null, p.name), h('small', { class: 'muted' }, new Date(p.last).toLocaleString())))) : [h('p', { class: 'muted' }, t('nb.no_history'))]));
  };

  async function openChat(eid, peer, fromHistory = false) {
    const did = peer.did || peer.id;
    const msgs = await history(did);
    const list = h('div', { class: 'nb-list' });
    const input = h('textarea', { class: 'input', rows: 1, maxLength: 4000, placeholder: t('chat.write'), 'aria-label': t('chat.write') });
    const addMessage = (rec) => { list.append(bubble(rec)); list.scrollTop = list.scrollHeight; };
    msgs.forEach((r) => list.append(bubble(r)));
    state.chat = { eid, did };
    const online = () => eidOfDid(did);
    const send = async () => {
      const text = input.value.trim();
      const id = online();
      if (!text) return;
      if (!id) { toast(t('nb.offline_peer')); return; }
      if (!native().nearbySend(id, JSON.stringify({ k: 't', text }))) { toast(t('nb.too_long')); return; }
      input.value = '';
      const rec = { peer: did, name: peer.name, dir: 'out', ts: Date.now(), kind: 'text', text };
      await saveMsg(rec);
      await savePeer({ id: did, name: peer.name, last: rec.ts });
      addMessage(rec);
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } });
    clear(body).append(
      h('div', { class: 'nb-head' }, h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('nb.back'), onclick: () => { state.chat = null; view.chat = null; drawList(); } }, icon('back', 22)),
        h('b', null, peer.name), h('small', { class: 'muted', id: 'nb-state' }, online() ? t('nb.connected') : t('nb.offline_peer'))),
      list,
      h('div', { class: 'nb-compose' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('chat.attach'), onclick: () => { const id = online(); if (id) native().nearbyPickFile(id); else toast(t('nb.offline_peer')); } }, icon('plus', 22)),
        input, h('button', { class: 'btn', type: 'button', onclick: send }, icon('send', 20))));
    view.chat = { eid, did };
    list.scrollTop = list.scrollHeight;
    void fromHistory;
  }

  view = {
    m, chat: null,
    redraw() {
      if (state.chat) {
        const s = body.querySelector('#nb-state');
        if (s) s.textContent = eidOfDid(state.chat.did) ? t('nb.connected') : t('nb.offline_peer');
      } else drawList();
    },
    addMessage(rec) { body.querySelector('.nb-list')?.append(bubble(rec)); const l = body.querySelector('.nb-list'); if (l) l.scrollTop = l.scrollHeight; },
    progress(pid, pct) { const el = body.querySelector(`.nb-msg[data-pid="${pid}"] .nb-bar`); if (el) el.style.width = `${pct}%`; },
  };
  drawList();
}
