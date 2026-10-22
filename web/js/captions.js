// Live captions for calls. Each person's own speech is recognised on their own device (Web Speech API) and only the
// text is sent to the other side; the other side may translate it with the browser's built-in translator.
// Note: Chrome / Edge send the audio to the vendor's recognition service for this (Safari uses Apple's); the call
// itself stays peer-to-peer. Therefore it is off by default and asks once.
import { S } from './state.js';

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const inShell = /SuhbatShell\//.test(navigator.userAgent);

export const captionsSupported = () => !!SR && !inShell;

export const LANGS = [['ru-RU', 'Русский'], ['uz-UZ', 'Oʻzbekcha'], ['en-US', 'English']];
export const defaultCapLang = () => S.prefs.capLang || (S.prefs.lang === 'uz' ? 'uz-UZ' : 'ru-RU');

/** Starts recognising the microphone. onText(text, isFinal) is called as people speak. Returns stop(). */
export function startCaptions({ lang, onText, isMuted }) {
  if (!captionsSupported()) return () => {};
  let rec = null;
  let on = true;
  let fails = 0;
  const begin = () => {
    if (!on) return;
    rec = new SR();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      if (isMuted?.()) return;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const text = r[0]?.transcript?.trim();
        if (text) onText(text, r.isFinal);
      }
      fails = 0;
    };
    rec.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed' || e.error === 'language-not-supported') { on = false; onText(null, true, e.error); }
    };
    rec.onend = () => {
      if (!on) return;
      fails += 1;
      setTimeout(begin, Math.min(3000, 200 * fails)); // it stops by itself after silence: start again
    };
    try { rec.start(); } catch { /* already running */ }
  };
  begin();
  return () => { on = false; try { rec?.abort(); } catch { /* ignore */ } };
}

// ---------------------------------------------------------------- translation of the other person's captions
const translators = new Map();
export async function translateCaption(text, fromLang, toLang) {
  const from = String(fromLang || '').slice(0, 2);
  const to = String(toLang || '').slice(0, 2);
  if (!text || !from || from === to || !('Translator' in self)) return null;
  const key = `${from}>${to}`;
  try {
    if (!translators.has(key)) translators.set(key, self.Translator.create({ sourceLanguage: from, targetLanguage: to }));
    const tr = await translators.get(key);
    return await tr.translate(text);
  } catch {
    translators.delete(key);
    return null;
  }
}
