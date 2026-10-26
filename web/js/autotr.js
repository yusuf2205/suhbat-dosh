// Automatic translation of the other people's messages in chats where it is turned on.
// The browser's own on-device translator is tried first (text never leaves the device); otherwise your server's
// translator, if the administrator started one. Nothing is sent to anybody else.
import { h } from './dom.js';
import { t, getLang } from './i18n.js';
import { S, savePrefs } from './state.js';
import { api } from './net.js';

// a chat opened with many messages must not hit the translator with all of them at once
let running = 0;
const waiting = [];
function queued(job) {
  return new Promise((resolve) => {
    const go = () => { running += 1; job().then(resolve).finally(() => { running -= 1; const next = waiting.shift(); if (next) next(); }); };
    if (running < 3) go(); else waiting.push(go);
  });
}

const cache = new Map(); // `${target}|${text}` -> Promise<string|null>
const deviceTr = new Map();

/** A chat's own choice wins; without one, the "all chats" setting decides. */
export function autoOn(chatId) {
  const v = S.prefs.autoTr?.[chatId];
  return v === undefined ? !!S.prefs.autoTrAll : !!v;
}
export const autoDecided = (chatId) => S.prefs.autoTr?.[chatId] !== undefined;
export function setAuto(chatId, on) {
  S.prefs.autoTr = { ...(S.prefs.autoTr || {}), [chatId]: !!on };
  savePrefs();
}
export function setAutoAll(on) {
  S.prefs.autoTrAll = !!on;
  savePrefs();
}

// ---------------------------------------------------------------- which language a text is in (a quick guess, the server does it properly)
const UZ_ONLY = /[\u045E\u049B\u0493\u04B3\u040E\u049A\u0492\u04B2]/;
const UZ_WORDS = new Set('va bu men sen siz biz ular emas yoq bor xop rahmat salom qanday nima uchun bilan kerak yaxshi bugun ertaga kecha kel ket ber ham lekin ammo endi hozir qayer necha kim qachon assalomu alaykum aka opa uka qalaysiz'.split(' '));
const EN_WORDS = new Set('the and is are you to of in it that this for with was have not hello thanks please what when where why how can will'.split(' '));
/** 'ru', 'uz' (Latin), 'uzc' (Uzbek in Cyrillic), 'en', or '' when it is not text. */
export function guessLang(text) {
  const cyr = (text.match(/[\u0400-\u04FF]/g) || []).length;
  const lat = (text.match(/[A-Za-z]/g) || []).length;
  if (!cyr && !lat) return '';
  if (cyr >= lat) return UZ_ONLY.test(text) ? 'uzc' : 'ru';
  const norm = text.toLowerCase().replace(/[\u2019\u02BB\u2018`]/g, "'");
  const words = norm.match(/[a-z']+/g) || [];
  const uz = words.filter((w) => UZ_WORDS.has(w)).length + (norm.match(/[og]'/g) || []).length;
  const en = words.filter((w) => EN_WORDS.has(w)).length;
  return en > uz ? 'en' : 'uz';
}
const myLang = () => (getLang() === 'uz' ? 'uz' : 'ru');
/** The language most of the other people's recent messages are in, when it is not the reader's own; otherwise ''. */
export function foreignLang(messages) {
  const mine = myLang();
  const seen = {};
  let n = 0;
  for (let i = messages.length - 1; i >= 0 && n < 10; i--) {
    const m = messages[i];
    if (m.kind !== 'text' || !m.text || m.sender_id === S.me.id) continue;
    const g = guessLang(m.text);
    if (!g) continue;
    n += 1;
    const l = g === 'uzc' ? 'uz' : g;
    if (l !== mine) seen[l] = (seen[l] || 0) + 1;
  }
  const best = Object.entries(seen).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] >= 3 ? best[0] : '';
}
export const langName = (l) => t(`atr.lang_${l}`);
const langFrom = (l) => t(`atr.of_${l}`);
export const autoAvailable = () => 'Translator' in self || !!S.cfg?.translate;

async function onDevice(text, target) {
  if (!('Translator' in self)) return null;
  let source = '';
  try {
    if ('LanguageDetector' in self) {
      const det = await (deviceTr.get('det') || deviceTr.set('det', self.LanguageDetector.create()).get('det'));
      const r = (await det.detect(text))[0];
      if (r && r.confidence > 0.5) source = r.detectedLanguage;
    }
    if (!source) return null;
    if (source === target) return text;
    const key = `${source}>${target}`;
    if (!deviceTr.has(key)) deviceTr.set(key, self.Translator.create({ sourceLanguage: source, targetLanguage: target }));
    return await (await deviceTr.get(key)).translate(text);
  } catch { return null; }
}

/** The text in `target` language, the same text when it is already in it, or null when nothing could translate it. */
export function translateText(text, target = getLang() === 'uz' ? 'uz' : 'ru') {
  const key = `${target}|${text}`;
  if (!cache.has(key)) {
    cache.set(key, (async () => {
      const local = await onDevice(text, target);
      if (local !== null) return local;
      if (!S.cfg?.translate) return null;
      return queued(async () => { try { return (await api('POST', '/api/translate', { text, target })).text; } catch { return null; } });
    })());
    if (cache.size > 400) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

/** The message shows in the reader's language; a small chip under it flips between the translation and what was written. `render` turns text into nodes (links). */
export function applyAutoTr(textEl, text, render) {
  if (!/\p{L}{2,}/u.test(text)) return;
  const g = guessLang(text);
  if (g === myLang() || !g) return;   // already in the reader's language: nothing to ask for
  textEl.classList.add('tr-wait');
  translateText(text).then((out) => {
    textEl.classList.remove('tr-wait');
    if (!out || out.trim().toLowerCase() === text.trim().toLowerCase()) return;
    let shown = true;
    textEl.replaceChildren(render(out));
    const chip = h('button', { class: 'tr-chip', type: 'button', 'aria-pressed': 'true' });
    const label = () => { chip.replaceChildren(`\u{1F310} ${shown ? t('atr.translated_from', { lang: langFrom(g === 'uzc' ? 'uz' : g) }) : t('atr.show_translation')}`); chip.setAttribute('aria-pressed', String(shown)); };
    chip.onclick = () => { shown = !shown; textEl.replaceChildren(render(shown ? out : text)); label(); };
    label();
    textEl.after(chip);
  });
}

/** A small line under the message; empty (and hidden) when the text is already in the reader's language. */
export function autoTrNode(text) {
  const box = h('div', { class: 'autotr', hidden: true });
  if (!/\p{L}{2,}/u.test(text)) return null;
  translateText(text).then((out) => {
    if (!out || out.trim().toLowerCase() === text.trim().toLowerCase()) return;
    box.append(h('small', { class: 'muted' }, `\u{1F310} ${t('atr.label')}`), h('div', null, out));
    box.hidden = false;
  });
  return box;
}
