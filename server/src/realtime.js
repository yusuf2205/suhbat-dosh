import { WebSocketServer } from 'ws';
import { CLIENT_EVENTS, EVENTS } from '../../shared/contracts.js';
import { log } from './util.js';
import { BUILD_ID } from './build.js';

// userId -> Set<ws>
const conns = new Map();
let hooks = {};

export const connectionCount = () => conns.size;
export const isOnline = (userId) => (conns.get(userId)?.size || 0) > 0;

export function emit(userIds, event) {
  const payload = JSON.stringify(event);
  for (const id of new Set(userIds)) {
    const set = conns.get(id);
    if (!set) continue;
    for (const ws of set) if (ws.readyState === 1) ws.send(payload);
  }
}

export function dropSession(sessionId) {
  for (const set of conns.values()) {
    for (const ws of set) {
      if (ws.sessionId === sessionId) {
        ws.send(JSON.stringify({ type: EVENTS.SESSION_REVOKED }));
        ws.close(4001, 'revoked');
      }
    }
  }
}

/**
 * hooks: {
 *   authenticate(req) -> { user, session } | null
 *   originOk(req) -> boolean
 *   onOnline(userId), onOffline(userId), onTyping(userId, chatId)
 * }
 */
export function attach(server, h) {
  hooks = h;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 65536 });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url.startsWith('/ws')) return socket.destroy();
    const auth = hooks.originOk(req) ? hooks.authenticate(req) : null;
    if (!auth) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return socket.destroy();
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = auth.user.id;
      ws.sessionId = auth.session.id;
      wss.emit('connection', ws);
    });
  });

  wss.on('connection', (ws) => {
    const wasOnline = isOnline(ws.userId);
    if (!conns.has(ws.userId)) conns.set(ws.userId, new Set());
    conns.get(ws.userId).add(ws);
    ws.isAlive = true;
    ws.on('pong', () => (ws.isAlive = true));
    ws.send(JSON.stringify({ type: EVENTS.READY, user_id: ws.userId, build: BUILD_ID }));
    if (!wasOnline) hooks.onOnline(ws.userId);

    let msgCount = 0;
    const resetter = setInterval(() => (msgCount = 0), 5000);

    ws.on('message', (raw) => {
      if (++msgCount > 200) return;
      let m;
      try {
        m = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (m?.type === CLIENT_EVENTS.PING) ws.send('{"type":"pong"}');
      else if (m?.type === CLIENT_EVENTS.TYPING && Number.isInteger(m.chat_id)) hooks.onTyping(ws.userId, m.chat_id);
      else if (typeof m?.type === 'string' && m.type.startsWith('call.')) hooks.onSignal?.(ws.userId, m);
      else if (typeof m?.type === 'string' && m.type.startsWith('gcall.')) hooks.onGroupSignal?.(ws.userId, m);
    });

    ws.on('close', () => {
      clearInterval(resetter);
      const set = conns.get(ws.userId);
      set?.delete(ws);
      if (set && set.size === 0) {
        conns.delete(ws.userId);
        hooks.onOffline(ws.userId);
      }
    });
    ws.on('error', (e) => log('debug', 'ws error', { err: e.message }));
  });

  const hb = setInterval(() => {
    for (const set of conns.values()) {
      for (const ws of set) {
        if (!ws.isAlive) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        ws.ping();
      }
    }
  }, 30_000);
  hb.unref();
  return wss;
}
