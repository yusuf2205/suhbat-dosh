// Stickers and animated emoji: Lottie / TGS animations that play only while they are on screen.
import { h, uuid } from './dom.js';
import { t, errText } from './i18n.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';
import { motionLevel } from './motion.js';

let libP = null;
function lottieLib() {
  if (window.lottie) return Promise.resolve(window.lottie);
  libP ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/js/vendor/lottie.js';
    s.async = true;
    s.onload = () => (window.lottie ? resolve(window.lottie) : reject(new Error('lottie')));
    s.onerror = () => reject(new Error('lottie'));
    document.head.appendChild(s);
  });
  return libP;
}

async function gunzipJson(buf) {
  const ds = new DecompressionStream('gzip');
  const text = await new Response(new Blob([buf]).stream().pipeThrough(ds)).text();
  return JSON.parse(text);
}

const dataCache = new Map(); // url -> Promise<object>
function animationData(url, isTgs) {
  if (!dataCache.has(url)) {
    dataCache.set(url, (async () => {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) throw new Error(String(r.status));
      return isTgs ? gunzipJson(await r.arrayBuffer()) : r.json();
    })());
    if (dataCache.size > 80) dataCache.delete(dataCache.keys().next().value);
  }
  return dataCache.get(url);
}

// at most a few animations run at the same time; the oldest one pauses
const MAX_PLAYING = 6;
const playing = [];
function markPlaying(anim) {
  const i = playing.indexOf(anim);
  if (i >= 0) playing.splice(i, 1);
  playing.push(anim);
  while (playing.length > MAX_PLAYING) playing.shift().pause();
}

const io = typeof IntersectionObserver !== 'undefined'
  ? new IntersectionObserver((entries) => {
    for (const e of entries) e.target.__vis?.(e.isIntersecting);
  }, { threshold: 0.2 })
  : null;

/**
 * A node that shows a Lottie animation of `url` (TGS = gzipped Lottie). Nothing is fetched or played
 * until the node is visible. `fallback` is shown while loading or when the animation is not available.
 */
export function animatedNode(url, { tgs = false, size = 160, loop = true, fallback = null, className = '' } = {}) {
  const box = h('div', { class: `anim ${className}` });
  box.style.width = `${size}px`;
  box.style.height = `${size}px`;
  if (fallback) box.append(h('span', { class: 'anim-fallback' }, fallback));
  let anim = null;
  let starting = false;
  const start = async () => {
    if (anim || starting) return;
    starting = true;
    try {
      const [lottie, data] = await Promise.all([lottieLib(), animationData(url, tgs)]);
      box.replaceChildren();
      const still = motionLevel() === 'lite';
      anim = lottie.loadAnimation({ container: box, renderer: 'svg', loop: loop && !still, autoplay: false, animationData: data });
      if (still) anim.goToAndStop(0, true);
      else { anim.play(); markPlaying(anim); }
    } catch { /* the fallback stays */ } finally { starting = false; }
  };
  box.__vis = (on) => {
    if (on) {
      if (!anim) start();
      else if (motionLevel() !== 'lite') { anim.play(); markPlaying(anim); }
    } else if (anim) anim.pause();
  };
  if (io) io.observe(box); else start();
  return box;
}

const isTgs = (mime) => mime === 'application/x-tgsticker';
const isLottie = (mime) => mime === 'application/json' || isTgs(mime);

/** The body of a sticker message. */
export function stickerNode(m) {
  const f = m.file;
  if (!f) return h('div', { class: 'text' }, m.text || '');
  if (isLottie(f.mime)) return animatedNode(f.url, { tgs: isTgs(f.mime), size: 168, fallback: m.text, className: 'sticker' });
  return h('img', { class: 'sticker-img', src: f.url, alt: m.text || 'sticker', loading: 'lazy', draggable: false });
}

/** A single emoji: a Lottie version when one exists, otherwise null (the caller keeps the text). */
export function emojiCodes(text) {
  const cps = [...text.trim()].map((c) => c.codePointAt(0).toString(16));
  const full = cps.join('_');
  const bare = cps.filter((c) => c !== 'fe0f').join('_');
  return full === bare ? [full] : [full, bare];
}

const noAnim = new Set();
export function isSingleEmoji(text) {
  try {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return [...seg.segment(text.trim())].length === 1;
  } catch { return [...text.trim()].length <= 2; }
}

export function animatedEmoji(text, size = 120) {
  const codes = emojiCodes(text).filter((c) => !noAnim.has(c));
  if (!codes.length) return null;
  const box = h('div', { class: 'anim emoji-anim' });
  box.style.width = `${size}px`;
  box.style.height = `${size}px`;
  box.append(h('span', { class: 'anim-fallback' }, text));
  let done = false;
  const tryLoad = async (i) => {
    if (i >= codes.length) return;
    try {
      await animationData(`/api/anim/${codes[i]}`, false); // shared cache: the animation node reuses it
    } catch {
      noAnim.add(codes[i]);
      return tryLoad(i + 1);
    }
    const node = animatedNode(`/api/anim/${codes[i]}`, { size, fallback: text, className: 'emoji-anim-inner' });
    box.replaceChildren(node);
  };
  const obs = io ? new IntersectionObserver((es) => { if (!done && es.some((e) => e.isIntersecting)) { done = true; obs.disconnect(); tryLoad(0); } }) : null;
  if (obs) obs.observe(box); else tryLoad(0);
  return box;
}

// ---------------------------------------------------------------- picker
export function openStickerPicker(chatId, onSent) {
  const grid = h('div', { class: 'stk-grid', role: 'list' });
  const addInput = h('input', { type: 'file', accept: '.tgs,.json,.webp,.png,application/json', hidden: true });
  let data = { mine: [], anim: [] };

  const send = async (payload, close) => {
    try {
      const r = await api('POST', `/api/chats/${chatId}/stickers`, { ...payload, client_id: uuid() });
      onSent?.(r.message);
      close?.();
    } catch (e) { toast(errText(e.code)); }
  };

  const draw = (close) => {
    const cells = [];
    for (const cp of data.anim) {
      cells.push(h('button', { class: 'stk-cell', type: 'button', role: 'listitem', onclick: () => send({ anim: cp }, close), 'aria-label': cp },
        animatedNode(`/api/anim/${cp}`, { size: 64, fallback: String.fromCodePoint(...cp.split('_').map((x) => parseInt(x, 16))), className: 'stk-anim' })));
    }
    for (const s of data.mine) {
      const f = s.file;
      cells.push(h('div', { class: 'stk-mine', role: 'listitem' },
        h('button', { class: 'stk-cell', type: 'button', onclick: () => send({ sticker_id: s.id }, close), 'aria-label': s.emoji || 'sticker' },
          isLottie(f.mime) ? animatedNode(f.url, { tgs: isTgs(f.mime), size: 64, fallback: s.emoji, className: 'stk-anim' })
            : h('img', { src: f.url, alt: s.emoji || '', width: 64, height: 64, loading: 'lazy' })),
        h('button', { class: 'stk-del', type: 'button', 'aria-label': t('common.delete'), onclick: async () => {
          try { await api('DELETE', `/api/stickers/${s.id}`); data.mine = data.mine.filter((x) => x.id !== s.id); draw(close); } catch (e) { toast(errText(e.code)); }
        } }, '✕')));
    }
    grid.replaceChildren(...cells);
  };

  const m = modal({
    title: t('stk.title'),
    body: h('div', null, grid,
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '10px' } },
        h('span', { class: 'muted' }, t('stk.hint')),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => addInput.click() }, t('stk.add'))),
      addInput),
  });
  addInput.addEventListener('change', async () => {
    const file = addInput.files[0];
    addInput.value = '';
    if (!file) return;
    try {
      const r = await api('POST', '/api/stickers', undefined, { raw: file, headers: { 'content-type': 'application/octet-stream' } });
      data.mine.unshift(r.sticker);
      draw(() => m.close());
    } catch (e) { toast(e.code === 'sticker_invalid' ? t('stk.invalid') : errText(e.code)); }
  });
  api('GET', '/api/stickers').then((r) => { data = r; draw(() => m.close()); }).catch((e) => toast(errText(e.code)));
  return m;
}
