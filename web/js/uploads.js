// Upload manager: chunked, resumable, with pause / resume / cancel, retries and a small queue.
// Sent files survive a reload: the blob and the upload id are kept in IndexedDB and continue where they stopped.

const DB_NAME = 'suhbat-uploads';
const STORE = 'tasks';
const CHUNK_MIN = 256 * 1024;
const CHUNK_MAX = 4 * 1024 * 1024;
const PARALLEL = 2;
const MAX_ATTEMPTS = 6;

/** @type {Map<string, any>} */
const tasks = new Map();
const listeners = new Set();
export const onUpload = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
export const getTask = (id) => tasks.get(id);
const emit = (task, type) => { for (const fn of listeners) { try { fn(task, type); } catch { /* UI errors must not stop an upload */ } } };

// ---------------------------------------------------------------- IndexedDB (best effort)
let dbp = null;
function idb() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: 'id' });
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}
async function store(mode, fn) {
  const db = await idb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, mode);
      const res = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(res?.result ?? null);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
    } catch { resolve(null); }
  });
}
const persist = (t) => store('readwrite', (s) => s.put({
  id: t.id, userId: t.userId, chatId: t.chatId, name: t.name, blob: t.blob, opts: t.opts, uploadId: t.uploadId, size: t.size, mime: t.mime, at: t.createdAt,
}));
const forget = (id) => store('readwrite', (s) => s.delete(id));

// ---------------------------------------------------------------- transport
function xhr(method, url, { body = null, headers = {}, onProgress = null, hold = null } = {}) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    if (hold) hold.abort = () => x.abort();
    x.open(method, url);
    x.withCredentials = true;
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded); };
    x.onload = () => {
      let data = null;
      try { data = JSON.parse(x.responseText); } catch { /* empty body */ }
      resolve({ status: x.status, data: data || {} });
    };
    x.onerror = () => reject(Object.assign(new Error('network'), { network: true }));
    x.onabort = () => reject(Object.assign(new Error('aborted'), { aborted: true }));
    x.ontimeout = () => reject(Object.assign(new Error('timeout'), { network: true }));
    x.timeout = 120_000;
    x.send(body);
  });
}

async function sha256Hex(blob) {
  try {
    if (!crypto?.subtle) return null;
    const buf = await blob.arrayBuffer();
    return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

// ---------------------------------------------------------------- task life cycle
function setState(t, state, extra = {}) {
  t.state = state;
  Object.assign(t, extra);
  emit(t, 'state');
}

async function ensureSession(t) {
  if (t.uploadId) {
    // the server may have moved on while we were away: ask how much it really has
    const r = await xhr('GET', `/api/uploads/${t.uploadId}`);
    if (r.status === 200) { t.sent = r.data.received; return; }
    if (r.status !== 404) throw Object.assign(new Error('status'), { status: r.status, code: r.data.error });
    t.uploadId = null; // forgotten by the server: start a fresh session
    t.sent = 0;
  }
  const r = await xhr('POST', `/api/chats/${t.chatId}/uploads`, {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: t.name, size: t.size, client_id: t.id, caption: t.opts.caption || '', voice: !!t.opts.voice,
      duration: t.opts.duration ?? undefined, reply_to: t.opts.replyTo ?? undefined, waveform: t.opts.waveform ?? undefined,
    }),
  });
  if (r.data?.done) { t.result = r.data; return; }
  if (r.status !== 200 && r.status !== 201) throw Object.assign(new Error('init'), { status: r.status, code: r.data.error });
  t.uploadId = r.data.upload_id;
  t.sent = r.data.received || 0;
  await persist(t);
}

async function sendChunks(t) {
  while (t.sent < t.size && t.state === 'uploading') {
    const end = Math.min(t.size, t.sent + t.chunk);
    const part = t.blob.slice(t.sent, end);
    const started = performance.now();
    const base = t.sent;
    const hash = part.size <= 2 * 1024 * 1024 ? await sha256Hex(part) : null; // integrity of each part
    if (t.state !== 'uploading') return;
    const hold = {};
    t.hold = hold;
    const r = await xhr('PUT', `/api/uploads/${t.uploadId}?offset=${base}`, {
      body: part, hold,
      headers: { 'content-type': 'application/octet-stream', ...(hash ? { 'x-chunk-sha256': hash } : {}) },
      onProgress: (loaded) => { t.loaded = base + loaded; emit(t, 'progress'); },
    });
    if (r.status === 409 && typeof r.data.received === 'number') { t.sent = r.data.received; continue; } // resync with the server
    if (r.status === 422) throw Object.assign(new Error('corrupt'), { retry: true }); // damaged part: send it again
    if (r.status < 200 || r.status >= 300) throw Object.assign(new Error('chunk'), { status: r.status, code: r.data.error });
    t.sent = r.data.received;
    t.loaded = t.sent;
    t.attempts = 0;
    // adapt: a quick part grows the next one, a slow part shrinks it
    const ms = performance.now() - started;
    if (ms < 1500) t.chunk = Math.min(CHUNK_MAX, t.chunk * 2);
    else if (ms > 6000) t.chunk = Math.max(CHUNK_MIN, Math.floor(t.chunk / 2));
    emit(t, 'progress');
  }
}

async function run(t) {
  if (t.state !== 'queued') return;
  setState(t, 'preparing');
  try {
    await ensureSession(t);
    if (t.state === 'cancelled' || t.state === 'paused') return;
    if (!t.result) {
      setState(t, 'uploading');
      await sendChunks(t);
      if (t.state !== 'uploading') return;
      const r = await xhr('POST', `/api/uploads/${t.uploadId}/complete`);
      if (r.status === 409 && typeof r.data.received === 'number') { t.sent = r.data.received; setState(t, 'queued'); return pump(); }
      if (r.status !== 200 && r.status !== 201) throw Object.assign(new Error('complete'), { status: r.status, code: r.data.error });
      t.result = r.data;
    }
    t.loaded = t.size;
    setState(t, 'done');
    await forget(t.id);
    t.resolve(t.result);
  } catch (e) {
    if (t.state === 'paused' || t.state === 'cancelled') return;
    if (e.aborted) return;
    const fatal = e.status && e.status >= 400 && e.status < 500 && ![408, 409, 422, 429].includes(e.status);
    if (fatal) {
      setState(t, 'error', { error: e.code || 'generic', fatal: true });
      await forget(t.id);
      t.reject(Object.assign(new Error(e.code || 'generic'), { code: e.code || 'generic', status: e.status }));
      return;
    }
    if (e.network && navigator.onLine === false) { setState(t, 'waiting'); return; }
    t.attempts += 1;
    if (t.attempts > MAX_ATTEMPTS) { setState(t, 'error', { error: e.code || 'network' }); return; }
    // short backoff, then continue from what the server has
    setState(t, 'queued', { retryIn: Math.min(8000, 500 * 2 ** t.attempts) });
    setTimeout(pump, t.retryIn);
  } finally {
    pump();
  }
}

function pump() {
  let running = [...tasks.values()].filter((t) => t.state === 'preparing' || t.state === 'uploading').length;
  for (const t of tasks.values()) {
    if (running >= PARALLEL) break;
    if (t.state === 'queued' && !t.hold?.pending) {
      running += 1;
      run(t);
    }
  }
}

// ---------------------------------------------------------------- public API
export function enqueue({ userId, chatId, blob, name, opts = {}, id, uploadId = null }) {
  const t = {
    id, userId, chatId, blob, name, opts, size: blob.size, mime: blob.type, uploadId, state: 'queued', sent: 0, loaded: 0,
    chunk: 512 * 1024, attempts: 0, createdAt: Date.now(), error: '', hold: null, result: null,
  };
  t.promise = new Promise((resolve, reject) => { t.resolve = resolve; t.reject = reject; });
  t.promise.catch(() => {}); // the UI listens to state changes; a rejected promise must not be "unhandled"
  tasks.set(id, t);
  persist(t);
  emit(t, 'state');
  pump();
  return t;
}

export function pause(id) {
  const t = tasks.get(id);
  if (!t || !['queued', 'preparing', 'uploading', 'waiting'].includes(t.state)) return;
  setState(t, 'paused');
  t.hold?.abort?.();
  pump();
}

export function resume(id) {
  const t = tasks.get(id);
  if (!t || !['paused', 'error', 'waiting'].includes(t.state)) return;
  t.attempts = 0;
  setState(t, 'queued', { error: '' });
  pump();
}

export async function cancel(id) {
  const t = tasks.get(id);
  if (!t) return;
  setState(t, 'cancelled');
  t.hold?.abort?.();
  tasks.delete(id);
  await forget(id);
  if (t.uploadId) { try { await xhr('DELETE', `/api/uploads/${t.uploadId}`); } catch { /* the server forgets it anyway */ } }
  t.reject(Object.assign(new Error('cancelled'), { aborted: true }));
  pump();
}

/** After a start: uploads of this user that were interrupted continue by themselves. */
export async function restore(userId) {
  const db = await idb();
  if (!db) return [];
  const rows = await store('readonly', (s) => s.getAll());
  const out = [];
  for (const r of rows || []) {
    if (r.userId !== userId || tasks.has(r.id) || !r.blob) continue;
    const t = enqueue({ userId, chatId: r.chatId, blob: r.blob, name: r.name, opts: r.opts || {}, id: r.id, uploadId: r.uploadId });
    out.push(t);
  }
  return out;
}

window.addEventListener('online', () => {
  for (const t of tasks.values()) if (t.state === 'waiting' || (t.state === 'error' && !t.fatal)) resume(t.id);
});
window.addEventListener('offline', () => {
  for (const t of tasks.values()) {
    if (t.state === 'uploading' || t.state === 'preparing') { t.hold?.abort?.(); setState(t, 'waiting'); }
  }
});

