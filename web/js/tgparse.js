// Reading a Telegram Desktop export (result.json). Pure functions, no DOM: used by import.js and covered by tests.

/** Telegram stores text either as a string or as an array of strings and {type, text, href} pieces. */
export function tgText(text) {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '';
  return text.map((p) => {
    if (typeof p === 'string') return p;
    if (p?.type === 'text_link' && p.href && p.href !== p.text) return `${p.text} (${p.href})`;
    return p?.text ?? '';
  }).join('');
}

const MEDIA_KIND = {
  voice_message: 'voice', video_message: 'video_note', video_file: 'video', audio_file: 'audio', sticker: 'sticker', animation: 'video',
};

const isPlaceholder = (p) => typeof p === 'string' && /^\(.*not included.*\)$/i.test(p.trim());

/** One export message -> { key, ts, author, text, reply, forwarded, media: { path, kind, name, duration } | null, missing } or null for service messages. */
export function tgMessage(m, chatKey) {
  if (!m || m.type !== 'message') return null;
  const ts = m.date_unixtime ? Number(m.date_unixtime) * 1000 : Date.parse(m.date);
  let media = null;
  let missing = false;
  const path = m.photo || m.file;
  if (path) {
    if (isPlaceholder(path)) missing = true;
    else {
      const kind = m.photo ? 'image' : (MEDIA_KIND[m.media_type] || 'file');
      media = { path: String(path), kind, name: String(path).split('/').pop() || 'file', duration: Number(m.duration_seconds) || 0 };
    }
  }
  return {
    key: `${chatKey}:${m.id}`,
    tgId: m.id,
    ts: Number.isFinite(ts) ? ts : 0,
    author: String(m.from || m.actor || m.from_id || '').slice(0, 64),
    text: tgText(m.text),
    reply: m.reply_to_message_id ?? null,
    forwarded: m.forwarded_from ? String(m.forwarded_from).slice(0, 64) : '',
    media,
    missing,
    sticker: m.media_type === 'sticker' ? (m.sticker_emoji || '') : '',
  };
}

/** The file holds either one chat or the whole account: always return a list of chats with their parsed messages. */
export function parseExport(json) {
  const me = json.personal_information
    ? [json.personal_information.first_name, json.personal_information.last_name].filter(Boolean).join(' ')
    : '';
  const raw = Array.isArray(json.chats?.list) ? json.chats.list : (Array.isArray(json.messages) ? [json] : []);
  const chats = [];
  for (const c of raw) {
    if (!Array.isArray(c.messages)) continue;
    const key = String(c.id ?? c.name ?? chats.length);
    const messages = c.messages.map((m) => tgMessage(m, key)).filter(Boolean);
    if (!messages.length) continue;
    const counts = new Map();
    for (const m of messages) if (m.author) counts.set(m.author, (counts.get(m.author) || 0) + 1);
    chats.push({
      key, name: String(c.name || 'Telegram'), type: c.type || '', messages,
      authors: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, n]) => ({ name, n })),
      media: messages.filter((m) => m.media).length,
    });
  }
  return { me, chats };
}
