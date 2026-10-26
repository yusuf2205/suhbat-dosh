// "What did I miss": a short digest of the messages a person has not read in a chat.
// Without any AI it picks out what matters by simple rules (mentions, questions, agreements with dates/amounts, cards, files, topics).
// If the administrator points LLM_URL at an OpenAI-compatible server (for example a local Ollama), a written summary is added.
import express from 'express';
import { q } from './db.js';
import { HttpError, int, log, rateLimit } from './util.js';
import { getUser, isEncrypted, requireMember } from './service.js';

export const digest = express.Router();

const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при два другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это ок да нет привет спасибо ' +
  'va bu bir men sen u biz siz ular uchun bilan lekin yoki ham nima qanday qachon qayerda emas bor yoq yo\'q ha xo\'p yaxshi rahmat salom').split(' '));

const WHEN = /(\b([01]?\d|2[0-3])[:.][0-5]\d\b|\b(сегодня|завтра|послезавтра|вечером|утром|днем|днём|понедельник|вторник|сред[ау]|четверг|пятниц[уа]|суббот[уа]|воскресенье|на неделе|до \d|к \d|bugun|ertaga|indinga|dushanba|seshanba|chorshanba|payshanba|juma|shanba|yakshanba)\b)/i;
const MONEY = /(\d[\d\s.,]*\s?(сум|сўм|so'?m|usd|\$|руб|₽|тыс|млн|минг|ming|mln)\b)/i;
const AGREE = /(договорились|решили|согласен|согласна|подтверждаю|будем|нужно|надо|не забудь|давайте|келишдик|kelishdik|qaror|kerak|unutma)/i;

const clip = (s, n = 160) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/** Pure function: rows are messages (oldest first); `me` is { id, name, username }. */
export function buildDigest(rows, me, names = new Map()) {
  const mine = new Set(rows.filter((r) => r.sender_id === me.id).map((r) => r.id));
  const nameOf = (id) => names.get(id) || '';
  // JS "\b" does not know Cyrillic letters, so the edges are spelled out with Unicode classes
  const first = (me.name || '').split(/\s+/)[0].replace(/[^\p{L}\p{N}]/gu, '');
  const user = (me.username || '').replace(/[^\w]/g, '');
  const edge = '(?![\\p{L}\\p{N}_])';
  const parts = [];
  if (user) parts.push(`@${user}${edge}`);
  if (first.length >= 3) parts.push(`(?<![\\p{L}\\p{N}_@])${first}${edge}`);
  const mention = parts.length ? new RegExp(parts.join('|'), 'iu') : /(?!)/;
  const out = {
    count: rows.length, from_ts: rows[0]?.created_at || null, to_ts: rows.at(-1)?.created_at || null,
    first_id: rows[0]?.id || null, last_id: rows.at(-1)?.id || null,
    people: [], mentions: [], questions: [], plans: [], cards: [], media: { image: 0, video: 0, voice: 0, audio: 0, file: 0 }, topics: [], top: [],
  };
  const per = new Map();
  const words = new Map();
  const seen = new Set();
  const add = (list, r, extra = {}) => {
    if (seen.has(`${list}:${r.id}`)) return;
    seen.add(`${list}:${r.id}`);
    out[list].push({ id: r.id, sender_id: r.sender_id, sender: nameOf(r.sender_id), text: clip(r.text), at: r.created_at, ...extra });
  };
  for (const r of rows) {
    per.set(r.sender_id, (per.get(r.sender_id) || 0) + 1);
    if (r.kind in out.media) out.media[r.kind] += 1;
    if (['poll', 'event', 'task', 'miniapp', 'note', 'deal'].includes(r.kind)) out.cards.push({ id: r.id, kind: r.kind, title: clip(r.text, 100), sender: nameOf(r.sender_id) });
    if (!['text', 'image', 'video', 'file'].includes(r.kind) || !r.text) continue;
    const text = r.text;
    if (mention.test(text) || (r.reply_to && mine.has(r.reply_to))) add('mentions', r);
    if (text.includes('?') && text.length > 8) add('questions', r);
    if (WHEN.test(text) || MONEY.test(text) || AGREE.test(text)) add('plans', r, { why: MONEY.test(text) ? 'money' : WHEN.test(text) ? 'when' : 'agree' });
    for (const w of text.toLowerCase().match(/[\p{L}]{4,}/gu) || []) if (!STOP.has(w)) words.set(w, (words.get(w) || 0) + 1);
    const total = Object.values(r.reactions || {}).reduce((a, v) => a + v.length, 0);
    if (total >= 2) add('top', r, { reacts: total });
  }
  out.people = [...per.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([id, n]) => ({ id, name: nameOf(id), n }));
  out.topics = [...words.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([w]) => w);
  out.mentions = out.mentions.slice(-6);
  out.questions = out.questions.slice(-5);
  out.plans = out.plans.slice(-6);
  out.top = out.top.sort((a, b) => b.reacts - a.reacts).slice(0, 3);
  out.cards = out.cards.slice(-6);
  return out;
}

async function aiSummary(rows, names, lang) {
  const url = process.env.LLM_URL;
  if (!url) return null;
  const body = rows.filter((r) => r.text && ['text', 'image', 'video', 'file'].includes(r.kind)).slice(-250)
    .map((r) => `${names.get(r.sender_id) || '?'}: ${clip(r.text, 300)}`).join('\n').slice(-12000);
  if (!body) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 40_000);
  try {
    const r = await fetch(url, {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', ...(process.env.LLM_KEY ? { Authorization: `Bearer ${process.env.LLM_KEY}` } : {}) },
      body: JSON.stringify({
        model: process.env.LLM_MODEL || 'default', temperature: 0.2, max_tokens: 400,
        messages: [
          { role: 'system', content: `You summarize a chat for someone who was away. Answer in ${lang === 'uz' ? 'Uzbek (Latin)' : 'Russian'}, at most 6 short bullet points, mention who decided or asked what, dates, amounts and open questions. Do not invent anything that is not in the chat.` },
          { role: 'user', content: body },
        ],
      }),
    });
    if (!r.ok) return null;
    const j = await r.json();
    return clip(j?.choices?.[0]?.message?.content || '', 1800) || null;
  } catch (e) {
    log('warn', 'digest llm failed', { err: String(e.message).slice(0, 80) });
    return null;
  } finally { clearTimeout(timer); }
}

function unreadRows(chatId, me, sinceId) {
  const rows = q.all(
    `SELECT m.* FROM messages m WHERE m.chat_id = ? AND m.id > ? AND m.kind NOT IN ('call','secret','sticker')
     AND (m.sender_id IS NULL OR m.sender_id != ?) ORDER BY m.id DESC LIMIT 400`, chatId, sinceId, me).reverse();
  for (const r of rows) {
    r.reactions = {};
    for (const x of q.all('SELECT emoji, user_id FROM reactions WHERE message_id = ?', r.id)) (r.reactions[x.emoji] ||= []).push(x.user_id);
  }
  return rows;
}

const namesFor = (rows) => {
  const names = new Map();
  for (const id of new Set(rows.map((r) => r.sender_id).filter(Boolean))) names.set(id, getUser(id)?.name || '');
  return names;
};

digest.get('/chats/:id/digest', async (req, res) => {
  const id = int(req.params.id, 'id');
  const mem = requireMember(id, req.user.id);
  if (isEncrypted(id)) throw new HttpError(403, 'secret_no_digest');
  if (!rateLimit(`digest:${req.user.id}`, 30, 60_000)) throw new HttpError(429, 'slow_down');
  const since = req.query.since_id !== undefined ? int(req.query.since_id, 'since_id', { min: 0 }) : mem.last_read_id || 0;
  const rows = unreadRows(id, req.user.id, since);
  const me = getUser(req.user.id);
  const names = namesFor(rows);
  const d = buildDigest(rows, me, names);
  const wantAi = req.query.ai !== '0' && rows.length >= 5;
  const text = wantAi ? await aiSummary(rows, names, req.query.lang === 'uz' ? 'uz' : 'ru') : null;
  res.json({ chat_id: id, ...d, summary: text, mode: text ? 'ai' : 'rules' });
});

/** Chats with the most unread messages and a one-line reason why each matters. */
digest.get('/digest', (req, res) => {
  const uid = req.user.id;
  const chats = q.all(
    `SELECT c.id, mb.last_read_id, COALESCE(c.title, '') AS title FROM chats c JOIN members mb ON mb.chat_id = c.id AND mb.user_id = ? AND mb.banned = 0 AND mb.hidden = 0
     WHERE c.last_message_id > mb.last_read_id AND c.e2e = 0 AND NOT EXISTS (SELECT 1 FROM secret_chats s WHERE s.chat_id = c.id)
     ORDER BY c.last_message_at DESC LIMIT 12`, uid);
  const me = getUser(uid);
  const out = [];
  for (const c of chats) {
    const rows = unreadRows(c.id, uid, c.last_read_id || 0);
    if (!rows.length) continue;
    const d = buildDigest(rows, me, namesFor(rows));
    out.push({ chat_id: c.id, count: d.count, mentions: d.mentions.length, questions: d.questions.length, plans: d.plans.length, last: d.mentions.at(-1) || d.questions.at(-1) || d.plans.at(-1) || null, topics: d.topics.slice(0, 3) });
  }
  out.sort((a, b) => (b.mentions - a.mentions) || (b.count - a.count));
  res.json({ chats: out });
});
