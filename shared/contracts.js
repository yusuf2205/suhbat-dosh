// Shared contracts: used by the server (import) and the web client (served at /shared/contracts.js).
// Keep this file dependency-free and isomorphic.

export const LIMITS = {
  TEXT_MAX: 4000,
  NAME_MAX: 64,
  USERNAME_MIN: 5,
  USERNAME_MAX: 32,
  BIO_MAX: 200,
  STATUS_MAX: 60,
  TITLE_MAX: 64,
  DESCRIPTION_MAX: 300,
  DRAFT_MAX: 4000,
  PAGE_SIZE: 50,
  GROUP_MAX_MEMBERS: 500,
};

export const CHAT_TYPES = ['direct', 'group', 'channel'];
export const ROLES = ['owner', 'admin', 'member'];
export const PRIVACY_VALUES = ['everyone', 'contacts', 'nobody'];
export const PRIVACY_FIELDS = ['photo', 'status', 'last_seen'];
export const MESSAGE_KINDS = ['text', 'image', 'video', 'audio', 'voice', 'file', 'call', 'poll'];
export const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👎'];

// Realtime events pushed server -> client over WebSocket
export const EVENTS = {
  READY: 'ready',
  MESSAGE_NEW: 'message.new',
  MESSAGE_UPDATE: 'message.update',
  MESSAGE_DELETE: 'message.delete',
  CHAT_UPDATE: 'chat.update',
  CHAT_REMOVE: 'chat.remove',
  READ: 'read',
  DELIVERED: 'delivered',
  TYPING: 'typing',
  PRESENCE: 'presence',
  ME_UPDATE: 'me.update',
  SESSION_REVOKED: 'session.revoked',
  CALL_INCOMING: 'call.incoming',
  CALL_RINGING: 'call.ringing',
  CALL_ANSWERED: 'call.answered',
  CALL_ICE: 'call.ice',
  CALL_STATE: 'call.state',
  CALL_ENDED: 'call.ended',
};

// Client -> server WebSocket messages: { type: 'typing', chat_id }
export const CLIENT_EVENTS = { TYPING: 'typing', PING: 'ping' };
