import fs from 'node:fs';
import { q } from './db.js';
import { thumbPath } from './files.js';
import { isOnline } from './realtime.js';
import { HttpError, now } from './util.js';

const directKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);
export { directKey };

export const getUser = (id) => q.get('SELECT * FROM users WHERE id = ?', id);

export function isContact(a, b) {
  return !!q.get('SELECT 1 AS x FROM chats WHERE direct_key = ?', directKey(a, b));
}

export function isBlockedEitherWay(a, b) {
  return !!q.get(
    'SELECT 1 AS x FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)',
    a, b, b, a,
  );
}

function canSee(owner, viewerId, field) {
  if (owner.id === viewerId) return true;
  const p = owner[`privacy_${field}`];
  if (p === 'everyone') return true;
  if (p === 'nobody') return false;
  return isContact(owner.id, viewerId);
}

export function publicUser(u, viewerId) {
  if (!u) return null;
  const photoOk = canSee(u, viewerId, 'photo');
  const statusOk = canSee(u, viewerId, 'status');
  const seenOk = canSee(u, viewerId, 'last_seen');
  return {
    id: u.id,
    name: u.name,
    username: u.username,
    bio: u.bio,
    status: statusOk ? u.status : '',
    presence: u.presence || '',
    avatar: photoOk && u.avatar_file ? `/api/users/${u.id}/avatar?v=${u.avatar_file.slice(0, 8)}` : null,
    online: seenOk ? isOnline(u.id) : false,
    last_seen: seenOk ? u.last_seen : null,
    birthday: canSee(u, viewerId, 'birthday') ? u.birthday || null : null,
    ...(u.is_bot ? { is_bot: true, commands: JSON.parse(u.bot_commands || '[]') } : {}),
  };
}

export function selfUser(u) {
  return {
    ...publicUser(u, u.id),
    phone: u.phone?.startsWith('email:') || u.phone?.startsWith('login:') ? null : u.phone,
    email: u.email || null,
    has_password: !!u.pw_hash,
    auto_reply: u.auto_reply || '',
    auto_reply_on: !!u.auto_reply_on,
    privacy: { photo: u.privacy_photo, status: u.privacy_status, last_seen: u.privacy_last_seen, birthday: u.privacy_birthday },
    is_admin: !!u.is_admin,
    created_at: u.created_at,
  };
}

export function membership(chatId, userId) {
  return q.get('SELECT * FROM members WHERE chat_id = ? AND user_id = ? AND banned = 0', chatId, userId);
}

/** 404 (not 403) for non-members so chat existence is not disclosed. */
export function requireMember(chatId, userId) {
  const m = membership(chatId, userId);
  if (!m) throw new HttpError(404, 'not_found');
  return m;
}

export const isAdmin = (m) => m.role === 'owner' || m.role === 'admin';

export function memberIds(chatId) {
  return q.all('SELECT user_id FROM members WHERE chat_id = ? AND banned = 0', chatId).map((r) => r.user_id);
}

export function directPeerId(chatId, userId) {
  return q.get('SELECT user_id FROM members WHERE chat_id = ? AND user_id != ?', chatId, userId)?.user_id ?? null;
}

// ---------------- messages ----------------

export function eventOut(row) {
  const e = q.get('SELECT * FROM events WHERE message_id = ?', row.id);
  if (!e) return null;
  const rsvp = { yes: [], maybe: [], no: [] };
  for (const r of q.all('SELECT user_id, status FROM event_rsvp WHERE event_id = ? ORDER BY rowid', e.id)) rsvp[r.status]?.push(r.user_id);
  return {
    id: e.id, title: e.title, description: e.description, location: e.location, start_at: e.start_at, end_at: e.end_at,
    meeting: !!e.meeting, canceled: !!e.canceled, creator_id: e.creator_id, rsvp,
  };
}

export function pollOut(row) {
  const p = q.get('SELECT * FROM polls WHERE message_id = ?', row.id);
  if (!p) return null;
  const options = JSON.parse(p.options);
  const votes = options.map(() => []);
  for (const v of q.all('SELECT user_id, option FROM poll_votes WHERE poll_id = ? ORDER BY rowid', p.id)) votes[v.option]?.push(v.user_id);
  const voters = new Set(q.all('SELECT DISTINCT user_id FROM poll_votes WHERE poll_id = ?', p.id).map((r) => r.user_id));
  return {
    id: p.id, kind: p.kind || 'poll', question: p.question, multiple: !!p.multiple, closed: !!p.closed, total_voters: voters.size,
    // the right answer of a quiz is revealed only when it is over (a voter gets it from /polls/:id/result)
    ...(p.kind === 'quiz' && p.closed ? { correct: p.correct, explanation: p.explanation } : {}),
    options: options.map((text, i) => ({ text, votes: votes[i] })),
  };
}



export function messageOut(row) {
  if (!row) return null;
  let file = null;
  if (row.file_id) {
    const f = q.get('SELECT id, name, mime, size, width, height FROM files WHERE id = ?', row.file_id);
    if (f) {
      file = {
        id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/api/files/${f.id}`, width: f.width, height: f.height,
        thumb: fs.existsSync(thumbPath(f.id)) ? `/api/files/${f.id}/thumb` : null,
      };
    }
  }
  let reply = null;
  if (row.reply_to) {
    const r = q.get(
      `SELECT m.id, m.text, m.kind, m.sender_id, u.name AS sender_name
       FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
      row.reply_to,
    );
    if (r) reply = { id: r.id, text: r.text.slice(0, 120), kind: r.kind, sender_id: r.sender_id, sender_name: r.sender_name };
  }
  const reactions = {};
  for (const r of q.all('SELECT emoji, user_id FROM reactions WHERE message_id = ? ORDER BY rowid', row.id)) {
    (reactions[r.emoji] ||= []).push(r.user_id);
  }
  return {
    id: row.id,
    chat_id: row.chat_id,
    sender_id: row.sender_id,
    client_id: row.client_id,
    kind: row.kind,
    text: row.text,
    reply_to: reply,
    forward_from: row.forward_from,
    file,
    duration: row.duration,
    waveform: row.waveform || null,
    markup: row.markup ? JSON.parse(row.markup) : null,
    poll: row.kind === 'poll' ? pollOut(row) : null,
    event: row.kind === 'event' ? eventOut(row) : null,
    reactions,
    edited_at: row.edited_at,
    created_at: row.created_at,
    access_until: row.access_until || null,
  };
}

export const getMessage = (id) => q.get('SELECT * FROM messages WHERE id = ?', id);

export function refreshLastMessage(chatId) {
  const last = q.get('SELECT id, created_at FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1', chatId);
  const chat = q.get('SELECT created_at FROM chats WHERE id = ?', chatId);
  q.run(
    'UPDATE chats SET last_message_id = ?, last_message_at = ? WHERE id = ?',
    last?.id ?? null, last?.created_at ?? chat.created_at, chatId,
  );
}

// ---------------- chats ----------------

export function chatOut(chatId, viewerId) {
  const c = q.get('SELECT * FROM chats WHERE id = ?', chatId);
  if (!c) return null;
  const m = membership(chatId, viewerId);
  if (!m) return null;
  const unread = q.get(
    'SELECT COUNT(*) AS n FROM messages WHERE chat_id = ? AND id > ? AND (sender_id IS NULL OR sender_id != ?)',
    chatId, Math.max(m.last_read_id, m.cleared_before || 0), viewerId,
  ).n;
  const others = q.get(
    `SELECT COALESCE(MAX(last_read_id),0) AS r, COALESCE(MAX(last_delivered_id),0) AS d
     FROM members WHERE chat_id = ? AND user_id != ? AND banned = 0`,
    chatId, viewerId,
  );
  const count = q.get('SELECT COUNT(*) AS n FROM members WHERE chat_id = ? AND banned = 0', chatId).n;
  let peer = null;
  let blocked_by_me = false;
  let blocked_me = false;
  if (c.type === 'direct') {
    const pid = directPeerId(chatId, viewerId) ?? viewerId; // a chat with yourself is the "Saved" chat
    peer = publicUser(getUser(pid), viewerId);
    blocked_by_me = !!q.get('SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?', viewerId, pid);
    blocked_me = !!q.get('SELECT 1 AS x FROM blocks WHERE user_id = ? AND blocked_id = ?', pid, viewerId);
  }
  const sc = c.type === 'direct' ? q.get('SELECT * FROM secret_chats WHERE chat_id = ?', chatId) : null;
  const last = c.last_message_id && c.last_message_id > (m.cleared_before || 0) ? messageOut(getMessage(c.last_message_id)) : null;
  const pinned = c.pinned_message_id ? messageOut(getMessage(c.pinned_message_id)) : null;
  const canPost =
    !(c.type === 'channel' && m.role === 'member') && !(m.role === 'member' && !m.can_send) && !blocked_by_me && !blocked_me;
  return {
    id: c.id,
    type: c.type,
    title: c.title,
    description: c.description,
    owner_id: c.owner_id,
    invite_code: isAdmin(m) ? c.invite_code : null,
    members_count: count,
    peer,
    blocked_by_me,
    blocked_me,
    my_role: m.role,
    muted: !!m.muted || (m.muted_until || 0) > now(),
    muted_until: (m.muted_until || 0) > now() ? m.muted_until : 0,
    archived: !!m.archived,
    ttl: c.ttl_seconds || 0,
    pinned_at: m.pinned_at || null,
    sound: m.sound || null,
    saved: c.type === 'direct' && /^(\d+):\1$/.test(c.direct_key || ''),
    secret: sc ? { state: sc.peer_pub ? 'ready' : 'pending', initiator_id: sc.initiator_id, peer_id: sc.peer_id, init_pub: sc.init_pub, peer_pub: sc.peer_pub } : null,
    can_post: canPost,
    draft: m.draft,
    unread,
    last_read_id: m.last_read_id,
    others_read_id: others.r,
    others_delivered_id: others.d,
    last_message: last,
    last_message_at: c.last_message_at,
    pinned,
    created_at: c.created_at,
  };
}

export function listChats(userId) {
  const ids = q.all(
    `SELECT c.id FROM chats c JOIN members m ON m.chat_id = c.id
     WHERE m.user_id = ? AND m.banned = 0 AND m.hidden = 0 ORDER BY (m.pinned_at IS NULL), m.pinned_at DESC, c.last_message_at DESC LIMIT 500`,
    userId,
  );
  return ids.map((r) => chatOut(r.id, userId));
}

/** Append an entry to the admin-only activity journal. Never throws into the request path. */
export function audit(actorId, action, { target_type = null, target_id = null, chat_id = null, details = null, ip = null } = {}) {
  try {
    q.run(
      'INSERT INTO audit_log (ts, actor_id, action, target_type, target_id, chat_id, details, ip) VALUES (?,?,?,?,?,?,?,?)',
      now(), actorId, action, target_type, target_id === null ? null : String(target_id), chat_id,
      details ? JSON.stringify(details) : null, ip,
    );
  } catch (e) {
    console.error('audit failed', e.message);
  }
}
