// "What did I miss": a digest of the unread messages of one chat, with a jump to each important message.
import { h, clear } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';

const fmt = (ts) => new Date(ts).toLocaleString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const KIND_ICON = { poll: '\u{1F4CA}', event: '\u{1F4C5}', task: '✅', miniapp: '\u{1F9E9}', note: '\u{1F4DD}' };

export async function openDigest(chatId) {
  const body = h('div', { class: 'digest' }, h('p', { class: 'muted' }, t('digest.loading')));
  const win = modal({ title: t('digest.title'), className: 'drive', body: [body] });
  let d;
  try {
    d = await api('GET', `/api/chats/${chatId}/digest?lang=${getLang()}`);
  } catch (e) {
    win.close();
    toast(errText(e.code));
    return;
  }
  clear(body);
  if (!d.count) { body.append(h('p', { class: 'muted drive-empty' }, t('digest.nothing'))); return; }
  const jump = (id) => {
    win.close();
    import('./chat.js').then((c) => c.jumpTo(chatId, id));
  };
  const line = (it, extra) => h('button', { class: 'digest-line', type: 'button', onclick: () => jump(it.id) },
    h('b', null, it.sender || ''), h('span', { class: 'digest-text' }, it.text), extra ? h('small', { class: 'muted' }, extra) : null);
  const section = (title, items, mk) => (items?.length ? h('section', { class: 'digest-sec' }, h('h3', null, title), ...items.map(mk)) : null);

  body.append(...[
    h('div', { class: 'digest-head' },
      h('b', null, t('digest.count', { n: d.count })),
      h('small', { class: 'muted' }, `${fmt(d.from_ts)} – ${fmt(d.to_ts)}`)),
    d.summary ? h('div', { class: 'digest-ai' }, h('small', { class: 'muted' }, t('digest.ai')), h('p', null, d.summary)) : null,
    section(t('digest.mentions'), d.mentions, (it) => line(it)),
    section(t('digest.questions'), d.questions, (it) => line(it)),
    section(t('digest.plans'), d.plans, (it) => line(it, t(`digest.why_${it.why}`))),
    section(t('digest.cards'), d.cards, (it) => h('button', { class: 'digest-line', type: 'button', onclick: () => jump(it.id) }, h('b', null, KIND_ICON[it.kind] || ''), h('span', { class: 'digest-text' }, it.title), h('small', { class: 'muted' }, it.sender))),
    section(t('digest.top'), d.top, (it) => line(it, `❤ ${it.reacts}`)),
    (() => {
      const media = Object.entries(d.media).filter(([, n]) => n > 0).map(([k, n]) => `${t(`digest.m_${k}`)}: ${n}`);
      return media.length ? h('section', { class: 'digest-sec' }, h('h3', null, t('digest.media')), h('p', null, media.join(' · '))) : null;
    })(),
    d.people.length ? h('section', { class: 'digest-sec' }, h('h3', null, t('digest.people')), h('p', null, d.people.map((p) => `${p.name} (${p.n})`).join(', '))) : null,
    d.topics.length ? h('section', { class: 'digest-sec' }, h('h3', null, t('digest.topics')), h('div', { class: 'digest-topics' }, d.topics.map((w) => h('span', { class: 'task-chip' }, w)))) : null,
    h('div', { class: 'digest-foot' },
      h('button', { class: 'btn', type: 'button', onclick: () => { win.close(); import('./chat.js').then((c) => c.jumpTo(chatId, d.first_id)); } }, t('digest.read_all')),
      h('small', { class: 'muted' }, d.mode === 'ai' ? t('digest.note_ai') : t('digest.note_rules'))),
  ].filter(Boolean));
  fire('digest');
}

export async function openDigestAll() {
  const body = h('div', { class: 'digest' }, h('p', { class: 'muted' }, t('digest.loading')));
  const win = modal({ title: t('digest.all_title'), className: 'drive', body: [body] });
  let r;
  try { r = await api('GET', '/api/digest'); } catch (e) { win.close(); toast(errText(e.code)); return; }
  clear(body);
  if (!r.chats.length) { body.append(h('p', { class: 'muted drive-empty' }, t('digest.nothing_all'))); return; }
  for (const c of r.chats) {
    const chat = S.chats.get(c.chat_id);
    if (!chat) continue;
    const title = chat.type === 'direct' ? chat.peer?.name : chat.title;
    body.append(h('button', { class: 'digest-chat', type: 'button', onclick: () => { win.close(); fire('open-chat', c.chat_id); setTimeout(() => openDigest(c.chat_id), 300); } },
      h('b', { class: 'ellipsis' }, title || ''),
      h('small', { class: 'muted' }, [t('digest.count', { n: c.count }), c.mentions ? `@ ${c.mentions}` : '', c.questions ? `? ${c.questions}` : '', c.topics.join(', ')].filter(Boolean).join(' · '))));
  }
}
