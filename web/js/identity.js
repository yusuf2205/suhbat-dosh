// A signed identity: the server says "this device key belongs to this account", so devices can check each other with no server around.
import { S } from './state.js';
import { api } from './net.js';

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };
const TICKET_KEY = 'suhbat.nearby.ticket';

function keyDb() {
  return new Promise((resolve, reject) => {
    const rq = indexedDB.open('suhbat-nearby-key', 1);
    rq.onupgradeneeded = () => rq.result.createObjectStore('k');
    rq.onsuccess = () => resolve(rq.result);
    rq.onerror = () => reject(rq.error);
  });
}
async function deviceKeys() {
  const d = await keyDb();
  const read = () => new Promise((resolve) => { const r = d.transaction('k').objectStore('k').get('pair'); r.onsuccess = () => resolve(r.result); r.onerror = () => resolve(null); });
  let pair = await read();
  if (!pair) {
    pair = await crypto.subtle.generateKey(ECDSA, false, ['sign', 'verify']); // the private part can never leave this device
    await new Promise((resolve) => { const tx = d.transaction('k', 'readwrite'); tx.objectStore('k').put(pair, 'pair'); tx.oncomplete = resolve; tx.onerror = resolve; });
  }
  return pair;
}
const readTicket = () => parse(localStorage.getItem(TICKET_KEY) || 'null', null);
const ticketBody = (x) => { try { return JSON.parse(new TextDecoder().decode(unb64(x.ticket))); } catch { return null; } };

export async function refreshTicket() {
  if (!S.me || !crypto.subtle) return;
  const cur = readTicket();
  const body = cur && ticketBody(cur);
  if (body && body.u === S.me.id && body.e > Date.now() + 7 * 86_400_000) return;
  try {
    const { kty, crv, x, y } = await crypto.subtle.exportKey('jwk', (await deviceKeys()).publicKey);
    localStorage.setItem(TICKET_KEY, JSON.stringify(await api('POST', '/api/nearby/ticket', { pub: { kty, crv, x, y } })));
  } catch { /* offline: the saved one, or none */ }
}

export async function makeProof(peerNonce, code) {
  const mine = readTicket();
  if (!mine || !crypto.subtle) return { k: 'auth' };
  const sig = await crypto.subtle.sign(SIGN, (await deviceKeys()).privateKey, new TextEncoder().encode(`${peerNonce}|${code}`));
  return { k: 'auth', ticket: mine.ticket, tsig: mine.sig, proof: b64(sig) };
}

/** The account behind the other phone, or null. The digits of this very connection are signed: somebody in the middle would see other digits. */
export async function checkProof(j, nonce, code) {
  const mine = readTicket();
  if (!mine?.server_key || !j.ticket || !j.tsig || !j.proof) return null;
  try {
    const server = await crypto.subtle.importKey('jwk', mine.server_key, ECDSA, false, ['verify']);
    if (!await crypto.subtle.verify(SIGN, server, unb64(j.tsig), new TextEncoder().encode(j.ticket))) return null;
    const body = ticketBody(j);
    if (!body || body.e < Date.now()) return null;
    const device = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: body.p.x, y: body.p.y }, ECDSA, false, ['verify']);
    if (!await crypto.subtle.verify(SIGN, device, unb64(j.proof), new TextEncoder().encode(`${nonce}|${code}`))) return null;
    return { uid: body.u, name: body.n };
  } catch { return null; }
}
