// Automatic translation of the other people's messages in chats where it is turned on.
// The browser's own on-device translator is tried first (text never leaves the device); otherwise your server's
// translator, if the administrator started one. Nothing is sent to anybody else.
import { h } from './dom.js';
import { t, getLang } from './i18n.js';
import { S, savePrefs } from './state.js';
import { api } from './net.js';

const cache = new Map(); // `${target}|${text}` -> Promise<string|null>
const deviceTr = new Map();

export const autoOn = (chatId) => !!S.prefs.autoTr?.[chatId];
export function setAuto(chatId, on) {
  S.prefs.autoTr = { ...(S.prefs.autoTr || {}) };
  if (on) S.prefs.autoTr[chatId] = true; else delete S.prefs.autoTr[chatId];
  savePrefs();
}
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
      try { return (await api('POST', '/api/translate', { text, target })).text; } catch { return null; }
    })());
    if (cache.size > 400) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
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
