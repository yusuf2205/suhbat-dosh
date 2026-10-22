// "Who has read this message, and when."
import { h } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { api } from './net.js';
import { avatar, modal, toast } from './ui.js';

const stamp = (ts) => new Date(ts).toLocaleString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export async function openReaders(m) {
  const body = h('div', { class: 'readers' }, h('p', { class: 'muted' }, t('list.loading')));
  const win = modal({ title: t('readers.title'), body: [body] });
  let r;
  try { r = await api('GET', `/api/messages/${m.id}/readers`); } catch (e) { win.close(); toast(errText(e.code)); return; }
  body.replaceChildren(...[
    h('p', { class: 'muted' }, t('readers.summary', { n: r.readers.length + r.hidden, total: r.total })),
    ...r.readers.map((x) => h('div', { class: 'reader-row' }, avatar(x.user, 'sm'), h('b', { class: 'ellipsis' }, x.user.name), h('small', { class: 'muted' }, x.at ? stamp(x.at) : ''))),
    r.hidden ? h('p', { class: 'muted' }, t('readers.hidden', { n: r.hidden })) : null,
    !r.readers.length && !r.hidden ? h('p', { class: 'muted' }, t('readers.nobody')) : null,
    h('small', { class: 'muted' }, t('readers.note')),
  ].filter(Boolean));
}
