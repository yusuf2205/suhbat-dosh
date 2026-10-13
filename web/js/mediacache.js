// Device-side cache for opened images (Cache Storage) with automatic and manual clean-up.
// Videos are streamed with HTTP Range requests and left to the browser's own cache.
const NAME = 'suhbat-media-v1';
const INDEX = 'suhbat.mediaIndex';
const MAX_BYTES = 300 * 1024 * 1024;
const MAX_AGE = 30 * 24 * 3600 * 1000;
const MAX_ITEM = 40 * 1024 * 1024;

const supported = () => typeof caches !== 'undefined';

function readIndex() {
  try { return JSON.parse(localStorage.getItem(INDEX) || '{}'); } catch { return {}; }
}
function writeIndex(i) {
  try { localStorage.setItem(INDEX, JSON.stringify(i)); } catch { /* quota / private mode */ }
}

/** Blob URL for an authenticated file, served from the device cache when present. */
export async function cachedBlobUrl(url, { signal } = {}) {
  if (!supported()) return null;
  const c = await caches.open(NAME);
  let res = await c.match(url);
  if (!res) {
    const net = await fetch(url, { credentials: 'same-origin', signal });
    if (!net.ok) throw new Error(String(net.status));
    const len = Number(net.headers.get('content-length') || 0);
    if (len && len > MAX_ITEM) return null; // too big to keep: let the caller stream it
    await c.put(url, net.clone());
    res = net;
    const idx = readIndex();
    idx[url] = [Date.now(), len || 0];
    writeIndex(idx);
    prune();
  } else {
    const idx = readIndex();
    if (idx[url]) { idx[url][0] = Date.now(); writeIndex(idx); }
  }
  return URL.createObjectURL(await res.blob());
}

/** Drop old entries, then least-recently-used ones until under the size limit. */
export async function prune() {
  if (!supported()) return;
  const c = await caches.open(NAME);
  const idx = readIndex();
  const now = Date.now();
  let entries = Object.entries(idx);
  for (const [u, [ts]] of entries) {
    if (now - ts > MAX_AGE) { await c.delete(u); delete idx[u]; }
  }
  entries = Object.entries(idx).sort((a, b) => a[1][0] - b[1][0]);
  let total = entries.reduce((s, [, [, sz]]) => s + sz, 0);
  for (const [u, [, sz]] of entries) {
    if (total <= MAX_BYTES) break;
    await c.delete(u);
    delete idx[u];
    total -= sz;
  }
  writeIndex(idx);
}

export async function usage() {
  const idx = readIndex();
  const items = Object.keys(idx).length;
  const bytes = Object.values(idx).reduce((s, [, sz]) => s + sz, 0);
  let quota = null;
  try { quota = (await navigator.storage?.estimate?.()) || null; } catch { /* ignore */ }
  return { items, bytes, quota };
}

export async function clearAll() {
  if (supported()) await caches.delete(NAME);
  writeIndex({});
}

// housekeeping shortly after start
setTimeout(() => prune().catch(() => {}), 5000);

/** Is this file already on the device? */
export async function hasCached(url) {
  if (!supported()) return false;
  try { return !!(await (await caches.open(NAME)).match(url)); } catch { return false; }
}

/** The stored Blob of a cached file, or null. */
export async function getCachedBlob(url) {
  if (!supported()) return null;
  try {
    const res = await (await caches.open(NAME)).match(url);
    if (!res) return null;
    const idx = readIndex();
    if (idx[url]) { idx[url][0] = Date.now(); writeIndex(idx); }
    return await res.blob();
  } catch { return null; }
}

/** Keep a finished download (the queue assembles it from ranges). */
export async function putCachedBlob(url, blob, mime = "") {
  if (!supported()) return false;
  try {
    const c = await caches.open(NAME);
    await c.put(url, new Response(blob, { headers: { "content-type": mime || blob.type || "application/octet-stream", "content-length": String(blob.size) } }));
    const idx = readIndex();
    idx[url] = [Date.now(), blob.size];
    writeIndex(idx);
    prune();
    return true;
  } catch { return false; }
}
