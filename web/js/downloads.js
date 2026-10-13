// Download queue: files are fetched in ranges (resumable), at most two at a time, the file the user opened goes first.
// Also the "auto-download" policy per network type (Wi-Fi / mobile / roaming).
import { S, savePrefs } from './state.js';
import { getCachedBlob, hasCached, putCachedBlob } from './mediacache.js';

const PART = 1024 * 1024;
const PARALLEL = 2;

// ---------------------------------------------------------------- network class and auto-download policy
export const DEFAULT_AUTO = {
  wifi: { photo: true, video: true, file: true, max: 50 },
  cellular: { photo: true, video: false, file: false, max: 5 },
  roaming: { photo: false, video: false, file: false, max: 0 },
};

/** 'wifi' | 'cellular' | 'roaming' | 'none' (roaming is only known to the Android app). */
export function netClass() {
  try {
    const n = window.SuhbatNative?.networkType?.();
    if (n) return n;
  } catch { /* fall back */ }
  const c = navigator.connection;
  if (c?.type === 'cellular') return 'cellular';
  if (c?.saveData) return 'cellular';
  return 'wifi';
}

export function autoPolicy() {
  const a = S.prefs.auto || {};
  return {
    wifi: { ...DEFAULT_AUTO.wifi, ...(a.wifi || {}) },
    cellular: { ...DEFAULT_AUTO.cellular, ...(a.cellular || {}) },
    roaming: { ...DEFAULT_AUTO.roaming, ...(a.roaming || {}) },
  };
}

export function setAutoPolicy(net, patch) {
  S.prefs.auto = { ...(S.prefs.auto || {}), [net]: { ...autoPolicy()[net], ...patch } };
  savePrefs();
}

/** May this file be fetched in the background right now? kind: photo | video | file. */
export function autoAllowed(kind, size) {
  const net = netClass();
  if (net === 'none') return false;
  const p = autoPolicy()[net];
  return !!p[kind] && size <= p.max * 1048576;
}

// ---------------------------------------------------------------- queue
/** @type {Map<string, any>} */
const tasks = new Map();
const listeners = new Set();
export const onDownload = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = (t, type) => { for (const fn of listeners) { try { fn(t, type); } catch { /* UI must not break the queue */ } } };
export const listDownloads = () => [...tasks.values()];
export const downloadFor = (fileId) => tasks.get(fileId);

function set(t, state, extra = {}) { t.state = state; Object.assign(t, extra); emit(t, 'state'); }

async function runTask(t) {
  set(t, 'downloading');
  try {
    if (await hasCached(t.file.url)) { t.loaded = t.total; set(t, 'done'); return; }
    // resumable: the parts already received stay in memory while paused
    while (t.loaded < t.total && t.state === 'downloading') {
      const from = t.loaded;
      const to = Math.min(t.total - 1, from + PART - 1);
      t.ctl = new AbortController();
      const r = await fetch(t.file.url, { headers: { Range: `bytes=${from}-${to}` }, credentials: 'same-origin', signal: t.ctl.signal });
      if (r.status === 200 && from === 0) { // a server that ignores Range sends everything
        const buf = await r.blob();
        t.parts = [buf];
        t.loaded = buf.size;
        emit(t, 'progress');
        break;
      }
      if (r.status !== 206) throw Object.assign(new Error('http'), { status: r.status });
      const blob = await r.blob();
      t.parts.push(blob);
      t.loaded = from + blob.size;
      t.attempts = 0;
      emit(t, 'progress');
    }
    if (t.state !== 'downloading') return;
    const blob = new Blob(t.parts, { type: t.file.mime || '' });
    await putCachedBlob(t.file.url, blob, t.file.mime);
    t.parts = [];
    t.blob = blob;
    set(t, 'done');
  } catch (e) {
    if (t.state === 'paused' || t.state === 'cancelled') return;
    if (e.name === 'AbortError') return;
    if (e.status === 403 || e.status === 404) { set(t, 'error', { error: e.status === 403 ? 'forbidden' : 'gone' }); return; }
    t.attempts += 1;
    if (t.attempts > 5) { set(t, 'error', { error: navigator.onLine === false ? 'offline' : 'network' }); return; }
    set(t, 'queued');
    setTimeout(pump, Math.min(6000, 400 * 2 ** t.attempts));
  } finally {
    pump();
  }
}

function pump() {
  const active = [...tasks.values()].filter((t) => t.state === 'downloading').length;
  let free = PARALLEL - active;
  const queued = [...tasks.values()].filter((t) => t.state === 'queued').sort((a, b) => b.prio - a.prio || a.at - b.at);
  for (const t of queued) {
    if (free <= 0) break;
    free -= 1;
    runTask(t);
  }
}

/** prio: 2 = the user opened it, 1 = auto-download in the background. */
export function requestFile(file, prio = 2) {
  let t = tasks.get(file.id);
  if (t) {
    if (prio > t.prio) { t.prio = prio; emit(t, 'state'); }
    if (['paused', 'error'].includes(t.state)) resumeDownload(file.id);
    pump();
    return t;
  }
  t = { id: file.id, file, state: 'queued', loaded: 0, total: file.size, prio, at: Date.now(), parts: [], attempts: 0, error: '' };
  tasks.set(file.id, t);
  emit(t, 'state');
  pump();
  return t;
}

/** A finished file as a Blob (from the device cache or from the queue); rejects with an error code. */
export async function fileBlob(file, prio = 2) {
  const cached = await getCachedBlob(file.url);
  if (cached) return cached;
  const t = requestFile(file, prio);
  return new Promise((resolve, reject) => {
    const check = async (x) => {
      if (x.id !== file.id) return;
      if (x.state === 'done') {
        off();
        const b = await getCachedBlob(file.url);
        if (b) resolve(b); else resolve(x.blob || new Blob([]));
      } else if (x.state === 'error' || x.state === 'cancelled') {
        off();
        reject(Object.assign(new Error(x.error || 'cancelled'), { code: x.error || 'cancelled' }));
      }
    };
    const off = onDownload(check);
    check(t);
  });
}

export function pauseDownload(id) {
  const t = tasks.get(id);
  if (!t || !['queued', 'downloading'].includes(t.state)) return;
  set(t, 'paused');
  t.ctl?.abort();
  pump();
}

export function resumeDownload(id) {
  const t = tasks.get(id);
  if (!t || !['paused', 'error'].includes(t.state)) return;
  t.attempts = 0;
  set(t, 'queued', { error: '' });
  pump();
}

export function cancelDownload(id) {
  const t = tasks.get(id);
  if (!t) return;
  set(t, 'cancelled');
  t.ctl?.abort();
  tasks.delete(id);
}

window.addEventListener('online', () => {
  for (const t of tasks.values()) if (t.state === 'error' && t.error === 'offline') resumeDownload(t.id);
});
