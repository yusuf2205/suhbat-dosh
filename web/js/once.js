// One-time photos and videos: in the chat there is only a card; the picture opens once, in a full screen, and is not kept anywhere.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { toast } from './ui.js';

const nameOf = (id) => S.users.get(id)?.name || '';

/** The card that stands in the chat instead of the picture. */
export function onceNode(m) {
  const mine = m.sender_id === S.me.id;
  const views = m.once?.views || [];
  const seen = views.includes(S.me.id);
  const video = m.kind === 'video';
  const label = video ? t('once.video') : t('once.photo');
  if (mine) {
    return h('div', { class: 'once-card mine' },
      h('span', { class: 'once-ico' }, '\u{1F525}'),
      h('div', { class: 'once-main' }, h('b', null, label),
        h('small', { class: 'muted' }, views.length ? `${t('once.opened_by')}: ${views.map(nameOf).filter(Boolean).join(', ')}` : t('once.not_opened'))));
  }
  if (seen) {
    return h('div', { class: 'once-card seen' }, h('span', { class: 'once-ico' }, '✔'), h('div', { class: 'once-main' }, h('b', null, label), h('small', { class: 'muted' }, t('once.gone'))));
  }
  return h('button', { class: 'once-card open', type: 'button', onclick: () => openOnce(m) },
    h('span', { class: 'once-ico' }, '\u{1F525}'),
    h('div', { class: 'once-main' }, h('b', null, label), h('small', { class: 'muted' }, t('once.tap'))));
}

/** Full screen, once. The file is read straight into memory (never cached), shown, and forgotten when the window closes. */
async function openOnce(m) {
  const box = h('div', { class: 'once-view', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('once.photo') },
    h('div', { class: 'once-top' }, h('span', null, `\u{1F525} ${t('once.warning')}`),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), onclick: () => close() }, '✕')));
  document.body.append(box);
  let url = '';
  const close = () => { box.remove(); if (url) URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  box.addEventListener('contextmenu', (e) => e.preventDefault());
  try {
    const r = await fetch(m.file.url, { credentials: 'same-origin', cache: 'no-store' });
    if (!r.ok) throw Object.assign(new Error('gone'), { code: r.status === 404 ? 'once_gone' : 'generic' });
    url = URL.createObjectURL(await r.blob());
    const media = m.kind === 'video'
      ? h('video', { class: 'once-media', src: url, controls: true, autoplay: true, playsInline: true, controlsList: 'nodownload noplaybackrate', disablePictureInPicture: true })
      : h('img', { class: 'once-media', src: url, alt: '', draggable: false });
    box.append(media);
  } catch (e) {
    close();
    toast(e.code === 'once_gone' ? t('once.gone') : errText(e.code));
  }
}
