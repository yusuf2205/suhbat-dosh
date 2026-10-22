// Text of a voice message. It is made on our own server, takes a while, and is only a draft: words the system
// was unsure about are underlined, and the recording stays the source of truth.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { S, savePrefs } from './state.js';
import { api } from './net.js';
import { popMenu, toast } from './ui.js';

const UNSURE = 0.55;

const LANGS = [['', 'tr.auto'], ['ru', 'tr.ru'], ['uz', 'tr.uz'], ['en', 'tr.en']];

function pickLang(anchor) {
  return new Promise((resolve) => {
    if (S.prefs.trLang !== undefined) { resolve(S.prefs.trLang); return; }
    popMenu(anchor, LANGS.map(([code, key]) => ({ label: t(key), onClick: () => { S.prefs.trLang = code; savePrefs(); resolve(code); } })));
  });
}

async function ask(m, anchor) {
  const lang = await pickLang(anchor);
  try { await api('POST', `/api/messages/${m.id}/transcribe`, { lang }); } catch (e) { toast(e.code === 'transcribe_unavailable' ? t('tr.unavailable') : errText(e.code)); }
}

/** enabled: the server reported that the speech-to-text service is running. */
export function transcriptNode(m, enabled) {
  const tr = m.transcript;
  if (m.pending || typeof m.id !== 'number') return null;
  if (!tr) {
    if (!enabled) return null;
    return h('button', { class: 'tr-btn', type: 'button', onclick: (e) => ask(m, e.currentTarget) }, `Aa ${t('tr.button')}`);
  }
  if (tr.status === 'pending') return h('div', { class: 'tr-box pending', role: 'status' }, h('span', { class: 'tr-spin', 'aria-hidden': 'true' }), t('tr.working'));
  if (tr.status === 'error') {
    return h('div', { class: 'tr-box error' }, t(`tr.err_${tr.error}`) || t('tr.err_unavailable'),
      ' ', h('button', { class: 'btn link', type: 'button', onclick: (e) => ask(m, e.currentTarget) }, t('tr.retry')));
  }
  const words = tr.words?.length
    ? tr.words.flatMap(([w, p], i) => [i ? ' ' : '', p < UNSURE ? h('span', { class: 'tr-unsure', title: `${Math.round(p * 100)}%` }, w) : w])
    : [tr.text];
  const body = h('div', { class: 'tr-text' }, ...(tr.text ? words : [h('i', { class: 'muted' }, t('tr.empty'))]));
  const copy = h('button', { class: 'btn link', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(tr.text); toast(t('tr.copied')); } catch { /* ignore */ } } }, t('tr.copy'));
  const anyUnsure = tr.words?.some(([, p]) => p < UNSURE);
  return h('div', { class: 'tr-box done' }, body,
    h('small', { class: 'tr-note muted' }, anyUnsure ? t('tr.note_unsure') : t('tr.note')),
    h('div', { class: 'tr-actions' }, copy));
}
