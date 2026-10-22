// A card under a message with a link: the page's title, description and picture, fetched by our server.
import { h } from './dom.js';
import { S } from './state.js';
import { api } from './net.js';

const cache = new Map(); // url -> Promise<preview|null>

/** The first web address of a text, or ''. */
export function firstUrl(text) {
  const m = /(https?:\/\/[^\s<>"']+)/i.exec(text || '');
  if (!m) return '';
  return m[1].replace(/[.,;:!?)]+$/, '').slice(0, 500);
}

function load(url) {
  if (!cache.has(url)) cache.set(url, api('GET', `/api/preview?url=${encodeURIComponent(url)}`).then((r) => r.preview).catch(() => null));
  return cache.get(url);
}

/** Returns an element that fills itself in, or null when previews are off. */
export function linkCard(url) {
  if (!url || S.prefs.noPreview) return null;
  const box = h('a', { class: 'lcard', href: url, target: '_blank', rel: 'noopener noreferrer nofollow', hidden: true });
  load(url).then((p) => {
    if (!p) return;
    box.append(
      p.image ? h('img', { class: 'lcard-img', src: p.image, alt: '', loading: 'lazy' }) : null,
      h('div', { class: 'lcard-text' },
        p.site ? h('small', { class: 'lcard-site' }, p.site) : null,
        p.title ? h('b', { class: 'lcard-title' }, p.title) : null,
        p.description ? h('span', { class: 'lcard-desc' }, p.description) : null));
    box.hidden = false;
  });
  return box;
}
