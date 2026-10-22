// Keys of end-to-end encrypted groups, on this device.
//  * every device has its own ECDH key pair; the private key is not extractable and never leaves IndexedDB;
//  * a group has one AES-256-GCM key per "epoch"; the server only ever sees it wrapped separately for each device;
//  * a device that has the key wraps it for new devices (a new member, a new phone); an admin starts a new epoch
//    when somebody is removed.
import { S, fire, on } from './state.js';
import { api } from './net.js';

const enc = new TextEncoder();
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const ECDH = { name: 'ECDH', namedCurve: 'P-256' };

export const e2eSupported = () => !!(window.crypto?.subtle && window.indexedDB);

// ---------------------------------------------------------------- storage
let dbP = null;
function db() {
  dbP ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('suhbat-e2e', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('dev', { keyPath: 'id' }); r.result.createObjectStore('gk', { keyPath: 'id' }); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbP;
}
async function put(store, rec) {
  const d = await db();
  await new Promise((res, rej) => { const tx = d.transaction(store, 'readwrite'); tx.objectStore(store).put(rec); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function get(store, id) {
  const d = await db();
  return new Promise((res) => { const rq = d.transaction(store).objectStore(store).get(id); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); });
}

// ---------------------------------------------------------------- this device
let device = null; // { id, priv, pub }

/** Make sure this device has a key pair and the server knows its public part. */
export async function registerDevice() {
  if (!e2eSupported() || !S.me) return null;
  if (device && device.user === S.me.id) return device;
  let rec = await get('dev', `dev:${S.me.id}`);
  if (!rec) {
    const kp = await crypto.subtle.generateKey(ECDH, false, ['deriveBits']);
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
    const id = b64(crypto.getRandomValues(new Uint8Array(18))).replace(/\+/g, '-').replace(/\//g, '_');
    rec = { id: `dev:${S.me.id}`, devId: id, priv: kp.privateKey, pub: b64(raw) };
    await put('dev', rec);
  }
  try {
    await api('POST', '/api/e2e/devices', { id: rec.devId, pub: rec.pub, name: (navigator.userAgentData?.platform || navigator.platform || 'web').slice(0, 40) });
  } catch (e) {
    if (e.code === 'device_conflict') throw e;
    // offline: the keys exist, registration is retried next time
    return null;
  }
  device = { user: S.me.id, id: rec.devId, priv: rec.priv, pub: rec.pub };
  return device;
}

// ---------------------------------------------------------------- wrapping
async function wrapKey(devPub, raw, chatId, epoch) {
  const eph = await crypto.subtle.generateKey(ECDH, true, ['deriveBits']);
  const ephPub = b64(new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey)));
  const target = await crypto.subtle.importKey('raw', unb64(devPub), ECDH, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: target }, eph.privateKey, 256);
  const kek = await wrapKek(bits, chatId, epoch);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, raw));
  return JSON.stringify({ e: ephPub, iv: b64(iv), ct: b64(ct) });
}

async function wrapKek(bits, chatId, epoch) {
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('suhbat-e2e-wrap'), info: enc.encode(`${chatId}:${epoch}`) },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function unwrapKey(wrapped, chatId, epoch) {
  const w = JSON.parse(wrapped);
  const eph = await crypto.subtle.importKey('raw', unb64(w.e), ECDH, false, []);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: eph }, device.priv, 256);
  const kek = await wrapKek(bits, chatId, epoch);
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(w.iv) }, kek, unb64(w.ct)));
}

// ---------------------------------------------------------------- group keys
const keyCache = new Map(); // `${chat}:${epoch}` -> CryptoKey
const gkId = (chatId, epoch) => `${S.me.id}:${chatId}:${epoch}`;

async function storeKey(chatId, epoch, raw) {
  await put('gk', { id: gkId(chatId, epoch), raw });
  keyCache.delete(`${S.me.id}:${chatId}:${epoch}`);
}

export async function haveGroupKey(chatId, epoch) {
  return !!(await get('gk', gkId(chatId, epoch)));
}

/** The AES key of a group for one epoch, or null when this device does not have it (yet). */
export async function groupKey(chatId, epoch) {
  const ck = `${S.me.id}:${chatId}:${epoch}`;
  if (keyCache.has(ck)) return keyCache.get(ck);
  const rec = await get('gk', gkId(chatId, epoch));
  if (!rec) return null;
  const key = await crypto.subtle.importKey('raw', rec.raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
  keyCache.set(ck, key);
  return key;
}

const running = new Map();

/** Bring this device up to date for one encrypted group: take its keys, wrap them for others, start a new epoch when needed. */
export function syncGroup(chat) {
  if (!chat?.secret?.group || !e2eSupported()) return Promise.resolve(null);
  if (running.has(chat.id)) return running.get(chat.id);
  const p = (async () => {
    const dev = await registerDevice();
    if (!dev) return null;
    let changed = false;
    for (let round = 0; round < 2; round += 1) {
      const st = await api('GET', `/api/chats/${chat.id}/e2e?device=${encodeURIComponent(dev.id)}`);
      for (const k of st.keys) {
        if (await haveGroupKey(chat.id, k.epoch)) continue;
        try { await storeKey(chat.id, k.epoch, await unwrapKey(k.wrapped, chat.id, k.epoch)); changed = true; } catch { /* a key for another device record */ }
      }
      const admin = chat.my_role === 'owner' || chat.my_role === 'admin';
      const wrapAll = async (epoch, raw, devices) => {
        const wraps = [];
        for (const d of devices) wraps.push({ device: d.id, wrapped: await wrapKey(d.pub, raw, chat.id, epoch) });
        return wraps;
      };
      try {
        if (st.epoch === 0 && chat.my_role === 'owner') {
          const raw = crypto.getRandomValues(new Uint8Array(32));
          await api('POST', `/api/chats/${chat.id}/e2e/keys`, { epoch: 1, wraps: await wrapAll(1, raw, st.devices) });
          await storeKey(chat.id, 1, raw);
          changed = true;
        } else if (st.rotate && admin && (await haveGroupKey(chat.id, st.epoch))) {
          const raw = crypto.getRandomValues(new Uint8Array(32));
          await api('POST', `/api/chats/${chat.id}/e2e/keys`, { epoch: st.epoch + 1, wraps: await wrapAll(st.epoch + 1, raw, st.devices) });
          await storeKey(chat.id, st.epoch + 1, raw);
          changed = true;
        } else if (st.missing.length && (await haveGroupKey(chat.id, st.epoch))) {
          const raw = (await get('gk', gkId(chat.id, st.epoch))).raw;
          await api('POST', `/api/chats/${chat.id}/e2e/keys`, { epoch: st.epoch, wraps: await wrapAll(st.epoch, raw, st.devices.filter((d) => st.missing.includes(d.id))) });
        }
        break;
      } catch (e) {
        if (e.code !== 'epoch_conflict') break; // somebody was faster: look again
      }
    }
    if (changed) fire('e2e-keys', chat.id);
    return changed;
  })().catch(() => null).finally(() => running.delete(chat.id));
  running.set(chat.id, p);
  return p;
}

/** The devices of everybody in the group, as a short code to compare (it changes when a device is added or removed). */
export async function groupFingerprint(chatId) {
  const st = await api('GET', `/api/chats/${chatId}/e2e`);
  const text = st.devices.map((d) => `${d.user_id}:${d.id}:${d.pub}`).sort().join('|');
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
  return { code: [...d.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' '), devices: st.devices.length, people: new Set(st.devices.map((x) => x.user_id)).size, epoch: st.epoch };
}

// ---------------------------------------------------------------- when to look
const groups = () => [...S.chats.values()].filter((c) => c.secret?.group);

export async function startE2e() {
  if (!e2eSupported() || !S.me) return;
  try { await registerDevice(); } catch { return; }
  for (const c of groups()) { await syncGroup(c); }
}

on('ws', (ev) => {
  if (ev.type === 'e2e.need' || ev.type === 'e2e.keys') {
    const c = S.chats.get(ev.chat_id);
    if (c) syncGroup(c);
  } else if (ev.type === 'chat.update' && ev.chat?.secret?.group) {
    const c = ev.chat;
    haveGroupKey(c.id, c.secret.epoch).then((have) => { if (!have || c.secret.rotate) syncGroup(c); });
  }
});
