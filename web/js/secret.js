// End-to-end encrypted ("secret") chats.
//  * every device keeps its own ECDH P-256 key pair per chat; the private key never leaves this device (non-extractable, IndexedDB);
//  * both sides derive the same AES-256-GCM key with ECDH + HKDF; the server stores public keys and ciphertext only;
//  * a secret chat is bound to the two devices that created it, like in Telegram.
import { h, uuid } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u8) => { let s = ''; for (const b of u8) s += String.fromCharCode(b); return btoa(s); };
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export const secretSupported = () => !!(window.crypto?.subtle && window.indexedDB);
export const isSecret = (c) => !!c?.secret;

// ---------------------------------------------------------------- private keys on this device
let dbP = null;
function db() {
  dbP ||= new Promise((resolve, reject) => {
    const r = indexedDB.open('suhbat-secret', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys', { keyPath: 'id' });
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbP;
}
const keyId = (chatId) => `${S.me.id}:${chatId}`;
async function putKey(chatId, rec) {
  const d = await db();
  await new Promise((res, rej) => { const tx = d.transaction('keys', 'readwrite'); tx.objectStore('keys').put({ id: keyId(chatId), ...rec }); tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
}
async function getKey(chatId) {
  const d = await db();
  return new Promise((res) => { const rq = d.transaction('keys').objectStore('keys').get(keyId(chatId)); rq.onsuccess = () => res(rq.result || null); rq.onerror = () => res(null); });
}

async function newPair() {
  const kp = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
  const pub = b64(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));
  return { priv: kp.privateKey, pub };
}

// ---------------------------------------------------------------- key exchange
/** Start a secret chat with a user: a fresh key pair for this chat; the other side accepts from their device. */
export async function startSecretChat(userId) {
  if (!secretSupported()) { toast(t('secret.unsupported')); return null; }
  try {
    const kp = await newPair();
    const r = await api('POST', '/api/secret/start', { user_id: userId, pub: kp.pub });
    await putKey(r.chat.id, { priv: kp.priv, pub: kp.pub });
    S.chats.set(r.chat.id, r.chat);
    fire('chats');
    fire('open-chat', r.chat.id);
    return r.chat;
  } catch (e) {
    toast(errText(e.code));
    return null;
  }
}

/** The invited side: this device becomes the second end of the chat. */
export async function acceptSecretChat(chat) {
  try {
    const kp = await newPair();
    const r = await api('POST', `/api/secret/${chat.id}/accept`, { pub: kp.pub });
    await putKey(chat.id, { priv: kp.priv, pub: kp.pub });
    S.chats.set(chat.id, r.chat);
    cache.clear();
    fire('chats');
    return r.chat;
  } catch (e) {
    toast(errText(e.code));
    return null;
  }
}

/** 'pending-peer' (waiting for the other person) | 'invited' (you can accept) | 'ready' | 'no-key' (another device) */
export async function secretStatus(chat) {
  const sc = chat.secret;
  if (!sc) return null;
  const mine = sc.initiator_id === S.me.id;
  if (sc.state === 'pending') return mine ? ((await getKey(chat.id)) ? 'pending-peer' : 'no-key') : 'invited';
  return (await getKey(chat.id)) ? 'ready' : 'no-key';
}

// ---------------------------------------------------------------- encryption
const cache = new Map(); // chatId -> Promise<CryptoKey|null>
function chatKey(chat) {
  const ck = `${chat.id}:${chat.secret?.state}`;
  if (!cache.has(ck)) {
    cache.set(ck, (async () => {
      const sc = chat.secret;
      if (!sc || sc.state !== 'ready') return null;
      const rec = await getKey(chat.id);
      if (!rec) return null;
      const mine = sc.initiator_id === S.me.id;
      if (rec.pub !== (mine ? sc.init_pub : sc.peer_pub)) return null; // keys of a different (older) attempt
      const other = await crypto.subtle.importKey('raw', unb64(mine ? sc.peer_pub : sc.init_pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
      const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: other }, rec.priv, 256);
      const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
      return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(String(chat.id)), info: enc.encode('suhbat-secret-v1') },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
      );
    })());
  }
  return cache.get(ck);
}

/** Text or file meta -> envelope string {v, iv, ct}. */
export async function sealPayload(chat, payload) {
  const key = await chatKey(chat);
  if (!key) throw Object.assign(new Error('no key'), { code: 'secret_no_key' });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(payload)));
  return JSON.stringify({ v: 1, iv: b64(iv), ct: b64(new Uint8Array(ct)) });
}

const plain = new Map(); // message id -> payload (decrypted once)
export async function openPayload(chat, m) {
  if (m.plain !== undefined) return { t: m.plain };
  const hit = plain.get(m.id);
  if (hit) return hit;
  const key = await chatKey(chat);
  if (!key) return null;
  try {
    const e = JSON.parse(m.text);
    const buf = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(e.iv) }, key, unb64(e.ct));
    const p = JSON.parse(dec.decode(buf));
    plain.set(m.id, p);
    return p;
  } catch { return null; }
}

/** A file's bytes are encrypted separately (own IV); the IV travels in the encrypted meta. */
export async function sealBlob(chat, blob) {
  const key = await chatKey(chat);
  if (!key) throw Object.assign(new Error('no key'), { code: 'secret_no_key' });
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await blob.arrayBuffer());
  return { blob: new Blob([ct], { type: 'application/octet-stream' }), iv: b64(iv) };
}

export async function openBlob(chat, fileUrl, ivB64, mime) {
  const key = await chatKey(chat);
  if (!key) throw Object.assign(new Error('no key'), { code: 'secret_no_key' });
  const r = await fetch(fileUrl, { credentials: 'same-origin' });
  if (!r.ok) throw Object.assign(new Error('http'), { code: 'generic' });
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(ivB64) }, key, await r.arrayBuffer());
  return new Blob([pt], { type: mime || 'application/octet-stream' });
}

/** Short code to compare out loud (or by message) to be sure nobody sits in the middle. */
export async function fingerprint(chat) {
  const sc = chat.secret;
  if (!sc || sc.state !== 'ready') return '';
  const a = unb64(sc.init_pub);
  const b = unb64(sc.peer_pub);
  const all = new Uint8Array(a.length + b.length);
  all.set(a, 0);
  all.set(b, a.length);
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', all));
  return [...d.slice(0, 12)].map((x) => x.toString(16).padStart(2, '0')).join('').match(/.{4}/g).join(' ');
}

export async function showSecretInfo(chat) {
  const code = await fingerprint(chat);
  const body = h('div', null,
    h('p', null, t('secret.about')),
    code ? h('div', { class: 'fp' }, h('b', null, t('secret.fingerprint')), h('div', { class: 'fp-code' }, code), h('p', { class: 'muted' }, t('secret.compare'))) : h('p', { class: 'muted' }, t('secret.pending')),
    h('p', { class: 'muted' }, t('secret.device_bound')));
  modal({ title: t('secret.title'), body });
}

void uuid;
