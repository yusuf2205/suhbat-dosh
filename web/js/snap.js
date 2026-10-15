// Local snapshot of the chat list and the latest messages: the app paints from it at once and
// refreshes from the network afterwards (stale-while-revalidate). Cleared on sign-out.
const DB = 'suhbat-snap';
let dbp = null;

function open() {
  dbp ||= new Promise((resolve, reject) => {
    try {
      const rq = indexedDB.open(DB, 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    } catch (e) { reject(e); }
  });
  return dbp;
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', mode);
    const r = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
  });
}

export const snapGet = (key) => tx('readonly', (s) => s.get(key)).catch(() => undefined);
export const snapSet = (key, value) => tx('readwrite', (s) => s.put(value, key)).catch(() => {});
export const snapClear = () => tx('readwrite', (s) => s.clear()).catch(() => {});

let timer = 0;
/** Debounced: remember the chat list for the next start. */
export function snapSaveBoot(getValue) {
  clearTimeout(timer);
  timer = setTimeout(() => { try { snapSet('boot', getValue()); } catch { /* ignore */ } }, 1500);
}
