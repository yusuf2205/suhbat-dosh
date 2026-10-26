// Whether the other side of a copied Telegram chat is in Telegram right now ("в сети"), or when they were last there.
// The bridge passes on what Telegram tells it; people who hide it in Telegram's privacy settings stay unknown.
import { t } from './i18n.js';
import { S, fire } from './state.js';
import { fmtLastSeen } from './ui.js';

export const tgOnline = (c) => !!(c?.imported === 'tgbridge' && c.tg?.presence && c.tg.presence.until > Date.now());

/** "в сети · Telegram", "был(а) 12:40 · Telegram", "был(а) недавно · Telegram", or '' when nothing is known. */
export function tgSeenLine(c) {
  const p = c?.imported === 'tgbridge' ? c.tg?.presence : null;
  if (!p) return '';
  const base = p.until > Date.now() ? t('chat.online') : p.seen ? fmtLastSeen(p.seen) : p.approx ? t(`tg.seen_${p.approx}`) : '';
  return base ? `${base} · Telegram` : '';
}

// an "online" that ends by itself (Telegram says until when): the dot and the line must go away without waiting for another event
let last = Date.now();
setInterval(() => {
  const nowMs = Date.now();
  for (const c of S.chats.values()) {
    const u = c.tg?.presence?.until;
    if (u && u > last && u <= nowMs) { fire('chats'); break; }
  }
  last = nowMs;
}, 15000);
