// "Suhbat-dosh" service account: system notices (new sign-in, alerts, broadcasts) arrive as a normal chat.
import { q, tx } from './db.js';
import { directKey, getUser } from './service.js';
import { now } from './util.js';

let host = { postMessage: null, pushChat: null };
export function wireNotify(h) { host = h; }

export function serviceUser() {
  let u = q.get("SELECT * FROM users WHERE phone = 'system:suhbat'");
  if (!u) {
    const r = q.run(
      "INSERT INTO users (phone, name, bio, last_seen, created_at, is_bot) VALUES ('system:suhbat', 'Suhbat-dosh', 'Служебные уведомления', ?, ?, 1)",
      now(), now(),
    );
    u = getUser(Number(r.lastInsertRowid));
  }
  return u;
}

/** One system message into the user's personal chat with the service account. */
export function serviceMessage(userId, text) {
  const svc = serviceUser();
  if (!userId || userId === svc.id || !host.postMessage) return;
  const key = directKey(svc.id, userId);
  let chat = q.get('SELECT * FROM chats WHERE direct_key = ?', key);
  let fresh = false;
  if (!chat) {
    tx(() => {
      const r = q.run("INSERT INTO chats (type, direct_key, last_message_at, created_at) VALUES ('direct', ?, ?, ?)", key, now(), now());
      const cid = Number(r.lastInsertRowid);
      for (const uid of [svc.id, userId]) q.run("INSERT INTO members (chat_id, user_id, role, joined_at) VALUES (?, ?, 'member', ?)", cid, uid, now());
    });
    chat = q.get('SELECT * FROM chats WHERE direct_key = ?', key);
    fresh = true;
  }
  host.postMessage({ chat, user: svc, text: String(text).slice(0, 4000) });
  if (fresh) host.pushChat(chat.id);
}

export function adminIds() {
  return q.all('SELECT id FROM users WHERE is_admin = 1 AND is_bot = 0 AND banned_at IS NULL').map((r) => r.id);
}

export function notifyAdmins(text) {
  for (const id of adminIds()) {
    try { serviceMessage(id, text); } catch { /* never break the caller */ }
  }
}

/** Broadcast to every real, non-banned user. Returns how many received it. */
export function broadcast(text) {
  const ids = q.all("SELECT id FROM users WHERE is_bot = 0 AND banned_at IS NULL AND phone != 'system:suhbat'").map((r) => r.id);
  let sent = 0;
  for (const id of ids) {
    try { serviceMessage(id, text); sent++; } catch { /* skip */ }
  }
  return sent;
}
