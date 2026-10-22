// Stickers and animated emoji: Lottie / TGS animations that play only while they are on screen.
import { h, uuid } from './dom.js';
import { t, errText } from './i18n.js';
import { api } from './net.js';
import { confirmDialog, modal, popMenu, toast } from './ui.js';
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
const setCache = { sets: null };
const loadSets = async (force = false) => {
  if (!setCache.sets || force) { try { setCache.sets = (await api('GET', '/api/sets')).sets; } catch { setCache.sets = setCache.sets || []; } }
  return setCache.sets;
};

/** insertText(text): puts text (a custom emoji) into the message field instead of sending it. */
export function openStickerPicker(chatId, onSent, insertText) {
  const grid = h('div', { class: 'stk-grid', role: 'list' });
  const tabs = h('div', { class: 'stk-tabs', role: 'tablist' });
  const addInput = h('input', { type: 'file', accept: '.tgs,.json,.webp,.png,application/json', hidden: true });
  let data = { mine: [], anim: [] };
  let sets = [];
  let tab = 'mine'; // 'mine' | set id

  const send = async (payload, close) => {
    try {
      const r = await api('POST', `/api/chats/${chatId}/stickers`, { ...payload, client_id: uuid() });
      onSent?.(r.message);
      close?.();
    } catch (e) { toast(errText(e.code)); }
  };

  const picture = (f, emoji) => (isLottie(f.mime)
    ? animatedNode(f.url, { tgs: isTgs(f.mime), size: 64, fallback: emoji, className: 'stk-anim' })
    : h('img', { src: f.url, alt: emoji || '', width: 64, height: 64, loading: 'lazy' }));

  const addToSet = (anchor, sticker, close) => {
    const mine = sets.filter((s) => s.mine && s.kind === 'sticker');
    popMenu(anchor, [
      ...mine.map((s) => ({ label: s.title, onClick: async () => { try { await api('POST', `/api/sets/${s.id}/items`, { sticker_id: sticker.id }); await loadSets(true); toast(t('sets.added')); } catch (e) { toast(e.code === 'already_in_set' ? t('sets.already') : errText(e.code)); } } })),
      { label: `+ ${t('sets.new')}`, onClick: async () => {
        const set = await createSet('sticker');
        if (set) { try { await api('POST', `/api/sets/${set.id}/items`, { sticker_id: sticker.id }); await loadSets(true); sets = setCache.sets; drawTabs(close); toast(t('sets.added')); } catch (e) { toast(errText(e.code)); } }
      } },
    ]);
  };

  const draw = (close) => {
    const cells = [];
    if (tab === 'mine') {
      for (const cp of data.anim) {
        cells.push(h('button', { class: 'stk-cell', type: 'button', role: 'listitem', onclick: () => send({ anim: cp }, close), 'aria-label': cp },
          animatedNode(`/api/anim/${cp}`, { size: 64, fallback: String.fromCodePoint(...cp.split('_').map((x) => parseInt(x, 16))), className: 'stk-anim' })));
      }
      for (const s of data.mine) {
        cells.push(h('div', { class: 'stk-mine', role: 'listitem' },
          h('button', { class: 'stk-cell', type: 'button', onclick: () => send({ sticker_id: s.id }, close), 'aria-label': s.emoji || 'sticker' }, picture(s.file, s.emoji)),
          h('button', { class: 'stk-del', type: 'button', 'aria-label': t('common.delete'), onclick: async () => {
            try { await api('DELETE', `/api/stickers/${s.id}`); data.mine = data.mine.filter((x) => x.id !== s.id); draw(close); } catch (e) { toast(errText(e.code)); }
          } }, '✕'),
          h('button', { class: 'stk-add', type: 'button', 'aria-label': t('sets.to_set'), title: t('sets.to_set'), onclick: (e) => addToSet(e.currentTarget, s, close) }, '＋')));
      }
    } else if (tab === 'emoji') {
      const emojiSets = sets.filter((s) => s.kind === 'emoji');
      if (!emojiSets.length) cells.push(h('p', { class: 'muted' }, t('sets.no_emoji')));
      for (const set of emojiSets) {
        cells.push(h('div', { class: 'stk-set-title' }, set.title));
        for (const it of set.items) {
          cells.push(h('button', { class: 'stk-cell emoji-cell', type: 'button', role: 'listitem', onclick: () => { insertText?.(`{{e:${it.file.id}}}`); close?.(); }, 'aria-label': it.emoji || 'emoji' },
            h('img', { src: it.file.url, alt: it.emoji || '', width: 40, height: 40, loading: 'lazy' })));
        }
      }
    } else {
      const set = sets.find((s) => s.id === tab);
      for (const it of set?.items || []) {
        cells.push(h('button', { class: 'stk-cell', type: 'button', role: 'listitem', onclick: () => send({ set_item_id: it.id }, close), 'aria-label': it.emoji || 'sticker' }, picture(it.file, it.emoji)));
      }
      if (set && !set.items.length) cells.push(h('p', { class: 'muted' }, t('sets.empty')));
    }
    grid.replaceChildren(...cells);
  };

  const drawTabs = (close) => {
    const stickerSets = sets.filter((s) => s.kind === 'sticker');
    const hasEmoji = sets.some((s) => s.kind === 'emoji');
    tabs.replaceChildren(
      h('button', { class: `chip${tab === 'mine' ? ' on' : ''}`, type: 'button', 'aria-pressed': String(tab === 'mine'), onclick: () => { tab = 'mine'; drawTabs(close); draw(close); } }, t('sets.mine')),
      ...stickerSets.map((s) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(tab === s.id), onclick: () => { tab = s.id; drawTabs(close); draw(close); } }, s.title)),
      hasEmoji || insertText ? h('button', { class: 'chip', type: 'button', 'aria-pressed': String(tab === 'emoji'), onclick: () => { tab = 'emoji'; drawTabs(close); draw(close); } }, `\u{1F642} ${t('sets.emoji')}`) : null,
    );
    for (const b of tabs.children) b.classList.toggle('on', b.getAttribute('aria-pressed') === 'true');
  };

  const m = modal({
    title: t('stk.title'),
    body: h('div', null, tabs, grid,
      h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '10px', gap: '8px', flexWrap: 'wrap' } },
        h('span', { class: 'muted' }, t('stk.hint')),
        h('span', { class: 'row', style: { gap: '6px' } },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => { m.close(); openSetsManager(); } }, t('sets.manage')),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => addInput.click() }, t('stk.add')))),
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
  Promise.all([api('GET', '/api/stickers'), loadSets(true)]).then(([r]) => { data = r; sets = setCache.sets; drawTabs(() => m.close()); draw(() => m.close()); }).catch((e) => toast(errText(e.code)));
  return m;
}

// ---------------------------------------------------------------- sets: making, sharing, adding
function createSet(kind) {
  return new Promise((resolve) => {
    const title = h('input', { class: 'input', maxLength: 40, placeholder: t('sets.title_ph'), 'aria-label': t('sets.title_ph') });
    const err = h('div', { class: 'err', role: 'alert' });
    let done = false;
    const m = modal({
      title: kind === 'emoji' ? t('sets.new_emoji') : t('sets.new'), onClose: () => { if (!done) resolve(null); },
      body: [title, err, h('button', { class: 'btn', type: 'button', onclick: async () => {
        if (!title.value.trim()) { err.textContent = t('sets.need_title'); return; }
        try {
          const set = (await api('POST', '/api/sets', { title: title.value.trim(), kind })).set;
          done = true;
          await loadSets(true);
          m.close();
          resolve(set);
        } catch (e) { err.textContent = errText(e.code); }
      } }, t('task.create'))],
    });
    setTimeout(() => title.focus(), 50);
  });
}

/** My sets: add pictures, copy the link, rename, delete. */
export async function openSetsManager() {
  const body = h('div', { class: 'sets-manager' });
  const win = modal({ title: t('sets.manage'), className: 'drive', body: [body] });
  const draw = async () => {
    const sets = await loadSets(true);
    const mine = sets.filter((s) => s.mine);
    const others = sets.filter((s) => !s.mine);
    body.replaceChildren(...[
      h('p', { class: 'muted' }, t('sets.hint')),
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn', type: 'button', onclick: async () => { if (await createSet('sticker')) draw(); } }, `+ ${t('sets.new')}`),
        h('button', { class: 'btn secondary', type: 'button', onclick: async () => { if (await createSet('emoji')) draw(); } }, `+ ${t('sets.new_emoji')}`)),
      ...mine.map((s) => setCard(s, true)),
      others.length ? h('h3', null, t('sets.added_by_others')) : null,
      ...others.map((s) => setCard(s, false)),
    ].filter(Boolean));
  };
  const setCard = (s, owner) => {
    const link = `${location.origin}/#/stickers/${s.slug}`;
    const own = h('div', { class: 'set-items' }, s.items.map((it) => h('div', { class: 'set-item' },
      h('img', { src: it.file.url, alt: it.emoji || '', width: 36, height: 36, loading: 'lazy' }),
      owner ? h('button', { class: 'stk-del', type: 'button', 'aria-label': t('common.delete'), onclick: async () => { await api('DELETE', `/api/sets/${s.id}/items/${it.id}`).catch((e) => toast(errText(e.code))); draw(); } }, '✕') : null)));
    return h('div', { class: 'set-card' },
      h('div', { class: 'set-head' }, h('b', { class: 'ellipsis' }, `${s.kind === 'emoji' ? '\u{1F642} ' : ''}${s.title}`), h('small', { class: 'muted' }, `${s.items.length}`)),
      own,
      owner && s.kind === 'sticker' ? h('small', { class: 'muted' }, t('sets.add_hint')) : null,
      owner && s.kind === 'emoji' ? h('div', { class: 'row', style: { gap: '8px', alignItems: 'center' } },
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => pickForEmoji(s, draw) }, t('sets.add_picture'))) : null,
      h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
        h('button', { class: 'btn small secondary', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast(t('info.copied')); } catch { /* ignore */ } } }, t('sets.copy_link')),
        owner ? h('button', { class: 'btn small link', type: 'button', onclick: async () => {
          if (!(await confirmDialog(t('sets.delete_confirm', { title: s.title }), { okLabel: t('common.delete'), danger: true }))) return;
          await api('DELETE', `/api/sets/${s.id}`).catch((e) => toast(errText(e.code)));
          draw();
        } }, t('common.delete'))
          : h('button', { class: 'btn small link', type: 'button', onclick: async () => { await api('DELETE', `/api/sets/${s.id}/install`).catch((e) => toast(errText(e.code))); draw(); } }, t('sets.remove'))));
  };
  draw();
}

/** A picture for an emoji set: uploaded as a sticker first, then put into the set. */
function pickForEmoji(set, done) {
  const input = h('input', { type: 'file', accept: '.webp,.png,.gif,image/png,image/webp,image/gif', hidden: true });
  document.body.append(input);
  input.addEventListener('change', async () => {
    const file = input.files[0];
    input.remove();
    if (!file) return;
    try {
      const st = (await api('POST', '/api/stickers', undefined, { raw: file, headers: { 'content-type': 'application/octet-stream' } })).sticker;
      await api('POST', `/api/sets/${set.id}/items`, { sticker_id: st.id });
      await api('DELETE', `/api/stickers/${st.id}`).catch(() => {});
    } catch (e) { toast(e.code === 'emoji_invalid' ? t('sets.emoji_invalid') : e.code === 'sticker_invalid' ? t('stk.invalid') : errText(e.code)); }
    done();
  });
  input.click();
}

/** A set opened from a link: look at it and add it (or take it away). */
export async function openSetByLink(slug) {
  try {
    const set = (await api('GET', `/api/sets/by/${encodeURIComponent(slug)}`)).set;
    const btn = h('button', { class: 'btn', type: 'button' }, set.installed ? t('sets.remove') : t('sets.add'));
    const win = modal({
      title: set.title,
      body: [h('p', { class: 'muted' }, `${set.kind === 'emoji' ? t('sets.emoji') : t('stk.title')} · ${set.items.length}`),
        h('div', { class: 'set-items' }, set.items.map((it) => h('div', { class: 'set-item' }, h('img', { src: it.file.url, alt: it.emoji || '', width: 44, height: 44, loading: 'lazy' })))),
        set.mine ? null : btn].filter(Boolean),
    });
    btn.onclick = async () => {
      try {
        if (set.installed) await api('DELETE', `/api/sets/${set.id}/install`); else await api('POST', `/api/sets/${set.id}/install`);
        await loadSets(true);
        toast(set.installed ? t('sets.removed') : t('sets.added'));
        win.close();
      } catch (e) { toast(errText(e.code)); }
    };
  } catch { toast(t('sets.not_found')); }
}
