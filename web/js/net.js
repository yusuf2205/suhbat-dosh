import { EVENTS, CLIENT_EVENTS } from '/shared/contracts.js';
import { S, currentTopic, fire } from './state.js';

export class ApiError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

/** JSON API call. Network failures throw ApiError(0, 'network'). */
export async function api(method, url, body, opts = {}) {
  let res;
  const headers = {};
  if (body !== undefined && !opts.raw) headers['content-type'] = 'application/json';
  Object.assign(headers, opts.headers || {});
  // in a group with topics every request that posts something carries the topic being looked at
  const tm = /^\/api\/chats\/(\d+)\//.exec(url);
  if (tm && method !== 'GET' && headers['x-topic'] === undefined) {
    const tp = currentTopic(Number(tm[1]));
    if (tp) headers['x-topic'] = String(tp);
  }
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: Object.keys(headers).length ? headers : undefined,
      body: opts.raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  let data = null;
  try { data = await res.json(); } catch { /* empty body */ }
  if (res.status === 401 && !url.startsWith('/api/auth/')) fire('unauthorized');
  if (!res.ok) throw new ApiError(res.status, data?.error || 'generic');
  return data;
}

// ---------------------------------------------------------------- realtime socket
let ws = null;
let retry = 0;
let pingTimer = null;
let stopped = false;

function setNet(v) {
  if (S.net !== v) {
    S.net = v;
    fire('net');
  }
}

export function connect() {
  stopped = false;
  if (ws && ws.readyState <= 1) return;
  setNet('connecting');
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch { return; }
    if (ev.type === 'pong') return;
    if (ev.type === EVENTS.READY) {
      retry = 0;
      setNet('online');
      fire('resync');
    }
    fire('ws', ev);
  };
  ws.onclose = () => {
    clearInterval(pingTimer);
    if (stopped) return;
    setNet(navigator.onLine ? 'connecting' : 'offline');
    const delay = Math.min(15000, 500 * 2 ** retry++) + Math.random() * 300;
    setTimeout(connect, delay);
  };
  ws.onerror = () => ws.close();
  clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws?.readyState === 1) ws.send(JSON.stringify({ type: CLIENT_EVENTS.PING }));
  }, 25000);
}

export function disconnect() {
  stopped = true;
  clearInterval(pingTimer);
  ws?.close();
  ws = null;
}

/** Returns false when the socket is not open (the caller decides how to react). */
export function wsSend(obj) {
  if (ws?.readyState !== 1) return false;
  ws.send(JSON.stringify(obj));
  return true;
}

/** "I am writing" (no action), or what else is going on: 'voice' / 'video' / 'file'; 'stop' ends it at once. */
export function sendTyping(chatId, action) {
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: CLIENT_EVENTS.TYPING, chat_id: chatId, ...(action ? { action } : {}) }));
}

window.addEventListener('online', () => {
  retry = 0;
  flushOutbox();   // the queued messages go at once: the sending does not wait for the live connection to come back
  if (!ws || ws.readyState > 1) connect();
  else setNet('online');
});
window.addEventListener('offline', () => setNet('offline'));

// ---------------------------------------------------------------- outbox (offline queue)
// Text messages are queued in localStorage and delivered in order once the connection returns.
// Each carries a client_id, so a retry after a lost response can never create a duplicate.
const OUTBOX_KEY = 'suhbat.outbox';
const NON_RETRIABLE = new Set([400, 403, 404, 413, 415]);

function readBox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}
function writeBox(box) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(box)); } catch { /* quota/private mode */ }
}

export const outbox = {
  all: () => readBox().filter((m) => m.user_id === S.me?.id),
  add(item) {
    const box = readBox();
    box.push({ ...item, user_id: S.me.id });
    writeBox(box);
  },
  remove(clientId) {
    writeBox(readBox().filter((m) => m.client_id !== clientId));
  },
  clearForOtherUsers() {
    writeBox(readBox().filter((m) => m.user_id === S.me?.id));
  },
};

let flushing = false;
let holdTimer = null;
export async function flushOutbox() {
  if (flushing) return;
  flushing = true;
  try {
    for (const item of outbox.all()) {
      // held back on purpose ("take it back" window): wait for it, and keep the order
      if (item.hold && item.hold > Date.now()) { clearTimeout(holdTimer); holdTimer = setTimeout(flushOutbox, item.hold - Date.now() + 50); break; }
      try {
        const r = await api('POST', `/api/chats/${item.chat_id}/messages`, {
          text: item.text, client_id: item.client_id, reply_to: item.reply_to ?? undefined, kind: item.kind ?? undefined, silent: item.silent || undefined, urgent: item.urgent || undefined,
        }, item.topic !== undefined ? { headers: { 'x-topic': String(item.topic || 0) } } : {});
        outbox.remove(item.client_id);
        fire('outbox:sent', { client_id: item.client_id, message: r.message });
      } catch (e) {
        if (e.status === 0 || e.status >= 500 || e.status === 429) break; // retry later, keep order
        if (NON_RETRIABLE.has(e.status) || e.status === 401) {
          outbox.remove(item.client_id);
          fire('outbox:failed', { client_id: item.client_id, code: e.code });
        } else {
          break;
        }
      }
    }
  } finally {
    flushing = false;
    fire('outbox');
  }
}

// A dropped network does not always close the socket promptly, so retry queued messages on a timer too.
setInterval(() => {
  if (S.me && outbox.all().length) flushOutbox();
}, 5000);
