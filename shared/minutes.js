// Minutes of a meeting from its transcript: decisions, things to do, open questions, figures and dates.
// Plain rules (Russian and Uzbek) instead of an AI service: it only highlights sentences that say so themselves,
// it never invents anything, and the whole text stays one tap away. Isomorphic: the browser calls it directly.

const ACTION = /(нужно|надо|необходимо|должен|должна|должны|сделаю|сделаем|пришлю|пришлём|отправлю|подготовлю|займусь|позвоню|напишу|проверю|закажу|возьму|принесу|не забуд|до (понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|завтра|вечера|конца|\d)|к (понедельник|вторник|сред|четверг|пятниц|суббот|воскресень|завтра|\d)|kerak|qilaman|qilamiz|yuboraman|tayyorlayman|tekshiraman|zarur|unutma|chaqiraman)/i;
const DECISION = /(решили|договорились|принято|утвердили|согласовали|в итоге|итак|выбрали|остановились на|порешили|qaror qildik|kelishdik|tasdiqladik|shunday qilamiz|tanladik)/i;
const QUESTION_START = /^(как|когда|почему|кто|что|сколько|где|зачем|можно ли|нужно ли|есть ли|nima|qachon|qancha|kim|qayerda|nega|qanday)\b/i;
const FIGURE = /(\d[\d\s.,]*\s?(сум|сўм|so'?m|usd|\$|руб|₽|тыс|тысяч|млн|миллион|процент|%|minut|минут|час|soat|ming|mln)|\b([01]?\d|2[0-3])[:.][0-5]\d\b|\b\d{1,2}\s(январ|феврал|март|апрел|мая|июн|июл|август|сентябр|октябр|ноябр|декабр|yanvar|fevral|aprel|iyun|iyul|avgust|sentyabr|oktyabr|noyabr|dekabr))/i;
const DUE = /(до [а-я]+|к [а-я]+|сегодня|завтра|послезавтра|на следующей неделе|на этой неделе|bugun|ertaga|indinga|keyingi hafta|\b([01]?\d|2[0-3])[:.][0-5]\d\b|\d{1,2}\s[а-я]{3,9})/i;

const clip = (s, n = 220) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function sentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?…])\s+/u)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12);
}

/** { decisions, actions: [{ text, due }], questions, figures } - at most six of each, in the order they were said. */
export function summarize(text) {
  const out = { decisions: [], actions: [], questions: [], figures: [] };
  const seen = new Set();
  const take = (list, item, key) => {
    if (out[list].length >= 6 || seen.has(`${list}:${key}`)) return;
    seen.add(`${list}:${key}`);
    out[list].push(item);
  };
  for (const s of sentences(text)) {
    const key = s.toLowerCase().slice(0, 60);
    const q = /\?$/.test(s) || QUESTION_START.test(s);
    if (q) { take('questions', clip(s), key); continue; }
    if (DECISION.test(s)) take('decisions', clip(s), key);
    if (ACTION.test(s)) take('actions', { text: clip(s), due: (s.match(DUE) || [''])[0] }, key);
    if (FIGURE.test(s)) take('figures', clip(s), key);
  }
  return out;
}

export const hasMinutes = (m) => !!(m && (m.decisions.length || m.actions.length || m.questions.length || m.figures.length));

/** A text for posting the minutes into the chat. */
export function minutesText(m, labels) {
  const block = (title, rows) => (rows.length ? `${title}\n${rows.map((r) => `• ${r}`).join('\n')}` : '');
  return [
    labels.head,
    block(labels.decisions, m.decisions),
    block(labels.actions, m.actions.map((a) => a.text)),
    block(labels.questions, m.questions),
    block(labels.figures, m.figures),
  ].filter(Boolean).join('\n\n');
}
