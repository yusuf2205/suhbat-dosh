// Direct transfers between people: the file itself never reaches this server.
// - WebRTC signalling for a transfer over the internet is relayed between the two people of a personal chat.
// - A signed "ticket" says "this device key belongs to this account", so two phones can check each other with no internet at all.
import crypto from 'node:crypto';
import { isIP } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { q } from './db.js';
import { emit } from './realtime.js';
import { directPeerId, getUser, isBlockedEitherWay, membership } from './service.js';
import { pushToUser } from './push.js';
import { HttpError, now, rateLimit } from './util.js';

export const nearby = express.Router();

const TICKET_DAYS = 30;
const KEY_FILE = path.join(config.dataDir, 'nearby-sign.pem');
let signKey = null;

function key() {
  if (signKey) return signKey;
  try {
    signKey = crypto.createPrivateKey(fs.readFileSync(KEY_FILE));
  } catch {
    const { privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    fs.writeFileSync(KEY_FILE, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    signKey = privateKey;
  }
  return signKey;
}

const validDeviceKey = (jwk) => jwk && jwk.kty === 'EC' && jwk.crv === 'P-256' && typeof jwk.x === 'string' && typeof jwk.y === 'string' && !jwk.d
  && jwk.x.length <= 64 && jwk.y.length <= 64;

nearby.post('/nearby/ticket', (req, res) => {
  if (!rateLimit(`nearby-ticket:${req.user.id}`, 30, 3600_000)) throw new HttpError(429, 'slow_down');
  const pub = req.body?.pub;
  if (!validDeviceKey(pub)) throw new HttpError(400, 'invalid_input');
  try {
    crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y }, format: 'jwk' });
  } catch {
    throw new HttpError(400, 'invalid_input');
  }
  const ticket = Buffer.from(JSON.stringify({
    u: req.user.id, n: req.user.name, p: { x: pub.x, y: pub.y }, e: now() + TICKET_DAYS * 86_400_000,
  })).toString('base64url');
  const sig = crypto.sign('sha256', Buffer.from(ticket), { key: key(), dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const { kty, crv, x, y } = crypto.createPublicKey(key()).export({ format: 'jwk' });
  res.json({ ticket, sig, server_key: { kty, crv, x, y } });
});

// ---------------------------------------------------------------- devices on one network
// A web page cannot look around its Wi-Fi, so devices are introduced here: to those who came from the same public address, to their contacts and
// to the person's own devices. Whoever has the app open is listed; a pair is introduced only when one of the two has its "Nearby" screen open.
// A stranger's name is not told: behind one public address may be a whole provider; the devices prove to be on one network by connecting.
const LID_RE = /^[a-f0-9]{16,40}$/;
const SAME_IP_LIMIT = 40;
const lobby = new Map();   // lid -> { lid, ws, userId, name, nets, open, contacts }

/** The same home or office: the whole address for IPv4, the first 64 bits for IPv6. */
function networkOf(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '');
  if (!s) return '';
  if (!s.includes(':')) return s;
  const [left, right = ''] = s.split('::');
  const a = left ? left.split(':') : [];
  const b = right ? right.split(':') : [];
  const full = s.includes('::') ? [...a, ...Array(Math.max(0, 8 - a.length - b.length)).fill('0'), ...b] : a;
  return full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':');
}

/**
 * In production behind a proxy that is not declared (TRUST_PROXY), every visitor seems to come from the proxy's private address:
 * that says nothing about their networks, so strangers are not introduced at all (contacts and own devices still are).
 */
const INTERNAL = /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|fc|fd|fe80|::1$)/i;
function networkOfSocket(ip) {
  const s = String(ip || '').replace(/^::ffff:/i, '');
  return config.production && !config.trustProxy && INTERNAL.test(s) ? '' : networkOf(s);
}

const contactsOf = (userId) => new Set(q.all(
  "SELECT o.user_id AS id FROM members m JOIN chats c ON c.id = m.chat_id AND c.type = 'direct' JOIN members o ON o.chat_id = c.id AND o.user_id != m.user_id WHERE m.user_id = ?",
  userId,
).map((r) => r.id));

const sameNet = (a, b) => [...a.nets].some((n) => b.nets.has(n));
const related = (a, b) => a.lid !== b.lid && (a.open || b.open) && (a.userId === b.userId || sameNet(a, b) || a.contacts.has(b.userId)) && !isBlockedEitherWay(a.userId, b.userId);

/** What the socket shows, plus the addresses the device saw through STUN (one Wi-Fi may be two networks: IPv4 and IPv6). */
function netsOf(ws, claimed) {
  const out = new Set();
  const own = networkOfSocket(ws.clientIp);
  if (own) out.add(own);
  for (const ip of Array.isArray(claimed) ? claimed.slice(0, 4) : []) {
    if (typeof ip === 'string' && isIP(ip) && !INTERNAL.test(ip)) out.add(networkOf(ip));
  }
  return out;
}

function tellPeers(e) {
  if (e.ws.readyState !== 1) return;
  const all = [...lobby.values()].filter((o) => related(e, o));
  const known = all.filter((o) => o.userId === e.userId || e.contacts.has(o.userId));
  const strangers = all.filter((o) => !known.includes(o)).slice(-SAME_IP_LIMIT);
  e.ws.send(JSON.stringify({
    type: 'direct.lan.peers',
    peers: [...known, ...strangers].map((o) => ({
      lid: o.lid,
      same_ip: sameNet(e, o),
      ...(known.includes(o) ? { uid: o.userId, name: o.name, contact: o.userId !== e.userId, self: o.userId === e.userId } : {}),
    })),
  }));
}

function lanLeave(e) {
  if (!lobby.delete(e.lid)) return;
  for (const o of lobby.values()) if (related(e, o)) tellPeers(o);
}

export function lanGone(ws) {
  for (const e of lobby.values()) if (e.ws === ws) lanLeave(e);
}

function handleLan(userId, m, ws) {
  if (m.type === 'direct.lan.join') {
    if (!LID_RE.test(String(m.lid || '')) || !rateLimit(`lan-join:${userId}`, 120, 60_000)) return;
    const old = lobby.get(m.lid);
    if (old && old.userId !== userId) return;
    for (const x of lobby.values()) if (x.ws === ws && x.lid !== m.lid) lanLeave(x);
    const before = lobby.get(m.lid);
    const e = { lid: m.lid, ws, userId, name: getUser(userId)?.name || '', nets: netsOf(ws, m.nets), open: m.open === true, contacts: before?.ws === ws ? before.contacts : contactsOf(userId) };
    // those it stops being related to (the screen was closed) must hear of it as well
    const was = before ? [...lobby.values()].filter((o) => related(before, o)) : [];
    lobby.set(m.lid, e);
    tellPeers(e);
    for (const o of new Set([...was, ...[...lobby.values()].filter((x) => related(e, x))])) tellPeers(o);
  } else if (m.type === 'direct.lan.leave') {
    lanGone(ws);
  } else if (m.type === 'direct.lan.signal') {
    const from = [...lobby.values()].find((x) => x.ws === ws);
    const to = lobby.get(String(m.to || ''));
    if (!from || !to || !m.data || typeof m.data !== 'object' || !related(from, to) || !rateLimit(`lan:${userId}`, 1200, 60_000)) return;
    if (to.ws.readyState === 1) to.ws.send(JSON.stringify({ type: 'direct.lan.signal', from: from.lid, data: m.data }));
  }
}

/** One step of WebRTC signalling for a direct transfer: only between the two people of a personal chat. */
export function handleDirect(userId, m, ws) {
  if (String(m.type).startsWith('direct.lan.')) { handleLan(userId, m, ws); return; }
  const chatId = Number(m.chat_id);
  if (m.type !== 'direct.signal' || !Number.isInteger(chatId) || !m.data || typeof m.data !== 'object') return;
  if (!rateLimit(`direct:${userId}`, 600, 60_000)) return;
  const chat = q.get('SELECT type FROM chats WHERE id = ?', chatId);
  if (chat?.type !== 'direct' || !membership(chatId, userId)) return;
  const peer = directPeerId(chatId, userId);
  if (!peer || peer === userId || isBlockedEitherWay(userId, peer)) return;
  emit([peer], { type: 'direct.signal', chat_id: chatId, from: userId, data: m.data });
  // the app of the other person may be closed
  if (m.data.t === 'offer' && m.data.first === true) {
    const name = getUser(userId)?.name || 'Suhbat-dosh';
    pushToUser(peer, { title: name, body: `\u26A1 ${String(m.data.name || '').slice(0, 100)}`, chat_id: chatId, tag: `direct-${chatId}` }, { ttl: 300 });
  }
}
