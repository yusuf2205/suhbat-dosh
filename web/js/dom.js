// Minimal DOM builder. User content only ever goes through textContent / text nodes — never innerHTML.
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'for') el.htmlFor = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  add(el, kids);
  return el;
}

function add(el, kids) {
  for (const k of kids) {
    if (k === null || k === undefined || k === false) continue;
    if (Array.isArray(k)) add(el, k);
    else el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}

export const $ = (sel, root = document) => root.querySelector(sel);

/**
 * A long press of a finger. The browsers differ: Android Chrome sends "contextmenu" after a long press, iPhone Safari never does,
 * so the menu of a message used to be unreachable on an iPhone. Here the press is timed by hand (and a "contextmenu" that follows
 * it is ignored). Returns a function: has the press just fired? (for the "contextmenu" listener of the same element).
 */
export function longPress(el, fn, { ms = 450, skip = 'button, a, input, textarea, select, audio, video, .poll' } = {}) {
  let timer = 0;
  let x = 0;
  let y = 0;
  let fired = 0;
  let thisTouch = false;   // the press that is going on has fired
  const stop = () => clearTimeout(timer);
  el.addEventListener('touchstart', (e) => {
    stop();
    thisTouch = false;
    if (e.touches.length !== 1 || (skip && e.target.closest?.(skip))) return;
    x = e.touches[0].clientX;
    y = e.touches[0].clientY;
    timer = setTimeout(() => {
      fired = Date.now();
      thisTouch = true;
      try { navigator.vibrate?.(10); } catch { /* not everywhere */ }
      fn(e);
    }, ms);
  }, { passive: true });
  el.addEventListener('touchmove', (e) => {
    const p = e.touches[0];
    if (p && (Math.abs(p.clientX - x) > 10 || Math.abs(p.clientY - y) > 10)) stop();
  }, { passive: true });
  el.addEventListener('touchcancel', stop, { passive: true });
  // lifting the finger after a long press must not become a tap (the browser would send "mousedown" and "click" to what the menu now covers)
  el.addEventListener('touchend', (e) => { stop(); if (thisTouch && e.cancelable) e.preventDefault(); thisTouch = false; });
  // and the click, if one comes anyway
  el.addEventListener('click', (e) => { if (Date.now() - fired < 700) { e.preventDefault(); e.stopPropagation(); } }, true);
  return () => Date.now() - fired < 1200;
}

export function clear(el) {
  el.replaceChildren();
  return el;
}

const TOKEN_RE = /\b(?:https?:\/\/|www\.)[^\s<>"']+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\B@[A-Za-z]\w{3,31}\b|\+?\d[\d\s().-]{7,18}\d/gi;
const rel = 'noopener noreferrer nofollow';
const viaShell = (href) => (e) => {
  const n = window.SuhbatNative;
  if (n?.openUrl) { e.preventDefault(); try { n.openUrl(href); } catch { /* browser default */ } }
};
/** A custom emoji sits in a text as {{e:FILEID}}; people without the set still see the picture (sets are public). */
export const CEMOJI_RE = /\{\{e:([A-Za-z0-9_-]{8,40})\}\}/g;
export const stripCustomEmoji = (text) => String(text || '').replace(CEMOJI_RE, '\u{1F642}');

function expandEmoji(parts) {
  const out = [];
  for (const p of parts) {
    if (typeof p !== 'string' || !p.includes('{{e:')) { out.push(p); continue; }
    let last = 0;
    for (const m of p.matchAll(CEMOJI_RE)) {
      if (m.index > last) out.push(p.slice(last, m.index));
      out.push(h('img', { class: 'cemoji', src: `/api/files/${m[1]}`, alt: '\u{1F642}', width: 22, height: 22, loading: 'lazy', draggable: false }));
      last = m.index + m[0].length;
    }
    if (last < p.length) out.push(p.slice(last));
  }
  return out;
}

/** Turn plain text into nodes: links, e-mail addresses and phone numbers become tappable. */
export function linkify(text) {
  return expandEmoji(linkifyRaw(text));
}

function linkifyRaw(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN_RE)) {
    let tok = m[0];
    let tail = '';
    const trim = tok.match(/[.,;:!?)]+$/);
    if (trim && /^(https?:|www\.)/i.test(tok)) { tail = trim[0]; tok = tok.slice(0, -tail.length); }
    let node;
    if (/^(https?:\/\/|www\.)/i.test(tok)) {
      const href = /^www\./i.test(tok) ? `https://${tok}` : tok;
      node = h('a', { href, target: '_blank', rel, onclick: viaShell(href) }, tok);
    } else if (tok.startsWith('@')) {
      // @username: a person here, or else a profile in Telegram (share.js decides)
      node = h('a', { href: `https://t.me/${tok.slice(1)}`, class: 'mention', rel, target: '_blank', onclick: (e) => {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('suhbat:mention', { detail: { username: tok.slice(1) } }));
      } }, tok);
    } else if (tok.includes('@')) {
      node = h('a', { href: `mailto:${tok}`, rel, onclick: viaShell(`mailto:${tok}`) }, tok);
    } else {
      const digits = tok.replace(/\D/g, '');
      if (digits.length < 9 || digits.length > 15) continue;
      const phone = `${tok.trim().startsWith('+') ? '+' : ''}${digits}`;
      node = h('a', { href: `tel:${phone}`, class: 'tel', onclick: (e) => {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('suhbat:phone', { detail: { phone, el: e.currentTarget } }));
      } }, tok);
    }
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(node);
    if (tail) out.push(tail);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function formatDuration(sec) {
  sec = Math.max(0, Math.round(sec));
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}

export function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Makes a horizontally overflowing row usable with a mouse: the wheel scrolls sideways,
 * and the row can be dragged. Touch and trackpads keep their native behaviour.
 */
export function hscroll(el) {
  el.addEventListener('wheel', (e) => {
    if (el.scrollWidth <= el.clientWidth) return;
    if (Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return; // already a sideways gesture
    el.scrollLeft += e.deltaY;
    e.preventDefault();
  }, { passive: false });

  let startX = 0;
  let startLeft = 0;
  let dragging = false;
  let moved = false;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'mouse' || e.button !== 0 || el.scrollWidth <= el.clientWidth) return;
    dragging = true;
    moved = false;
    startX = e.clientX;
    startLeft = el.scrollLeft;
  });
  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 4) moved = true;
    if (moved) {
      el.scrollLeft = startLeft - dx;
      el.classList.add('dragging');
    }
  });
  const end = () => { dragging = false; el.classList.remove('dragging'); };
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
  // a drag must not count as a click on the tab under the cursor
  el.addEventListener('click', (e) => {
    if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; }
  }, true);
}
