// Text of a voice message. It is made on our own server, takes a while, and is only a draft: words the system
// was unsure about are underlined, and the recording stays the source of truth.
import { h, uuid } from './dom.js';
import { t, errText } from './i18n.js';
import { S, savePrefs } from './state.js';
import { api } from './net.js';
import { popMenu, toast } from './ui.js';
import { hasMinutes, minutesText, summarize } from '../../shared/minutes.js';
import { openTaskCreate } from './tasks.js';

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

/** Minutes from the text: decisions, things to do (each can become a task), open questions, figures and dates. */
function minutesNode(m, tr) {
  const mins = summarize(tr.text);
  if (!hasMinutes(mins)) return h('div', { class: 'min-box' }, h('small', { class: 'muted' }, t('min.nothing')));
  const list = (title, rows, withTask) => (rows.length ? [h('h4', null, title), ...rows.map((r) => h('div', { class: 'min-row' },
    h('span', null, withTask ? r.text : r, withTask && r.due ? h('small', { class: 'muted' }, ` · ${r.due}`) : null),
    withTask ? h('button', { class: 'btn secondary', type: 'button', onclick: () => openTaskCreate(m.chat_id, { id: m.id, text: r.text }) }, t('min.to_task')) : null))] : []);
  return h('div', { class: 'min-box' },
    ...list(t('min.decisions'), mins.decisions, false), ...list(t('min.actions'), mins.actions, true), ...list(t('min.questions'), mins.questions, false), ...list(t('min.figures'), mins.figures, false),
    h('small', { class: 'muted' }, t('min.note')),
    h('button', { class: 'btn small', type: 'button', onclick: async () => {
      try {
        await api('POST', `/api/chats/${m.chat_id}/messages`, { text: minutesText(mins, { head: `📋 ${t('min.head')}`, decisions: t('min.decisions'), actions: t('min.actions'), questions: t('min.questions'), figures: t('min.figures') }).slice(0, 3900), client_id: uuid() });
        toast(t('min.posted'));
      } catch (e) { toast(errText(e.code)); }
    } }, t('min.post')));
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
  let mins = null;
  const box = h('div', { class: 'tr-box done' }, body,
    h('small', { class: 'tr-note muted' }, anyUnsure ? t('tr.note_unsure') : t('tr.note')),
    h('div', { class: 'tr-actions' }, copy,
      tr.text.length >= 160 ? h('button', { class: 'btn link', type: 'button', onclick: (e) => {
        if (mins) { mins.remove(); mins = null; return; }
        mins = minutesNode(m, tr);
        box.append(mins);
        e.currentTarget.blur();
      } }, t('min.button')) : null));
  return box;
}
