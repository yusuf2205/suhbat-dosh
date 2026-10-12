import { closeLayer, openLayer } from './backnav.js';
import { canOpenNative, openNative } from './native.js';
import { h, clear, formatBytes } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { fmtDay, fmtTime, modal, toast } from './ui.js';
import { cachedBlobUrl, clearAll, usage } from './mediacache.js';

// In-app viewer: the chat stays exactly where it was underneath (it is an overlay, not navigation).
let viewer = null;

const isImage = (f) => /^image\//.test(f.mime);
const isVideo = (f) => /^video\//.test(f.mime);
const isAudio = (f) => /^audio\//.test(f.mime);
const isPdf = (f) => f.mime === 'application/pdf';

async function loadItems(chatId, aroundId) {
  const out = new Map();
  for (const m of S.msgs.get(chatId)?.list || []) {
    if (m.file && !m.pending && (m.kind === 'image' || m.kind === 'video')) out.set(m.id, m);
  }
  if (out.has(aroundId) && out.size > 1) return [...out.values()].sort((a, b) => a.id - b.id);
  // not (fully) in memory: pull the shared-media list from the server
  let before;
  for (let page = 0; page < 5; page++) {
    try {
      const r = await api('GET', `/api/chats/${chatId}/media?kind=media&limit=100${before ? `&before=${before}` : ''}`);
      for (const m of r.messages) out.set(m.id, m);
      if (out.has(aroundId) || !r.has_more) break;
      before = Math.min(...r.messages.map((m) => m.id));
    } catch { break; }
  }
  return [...out.values()].sort((a, b) => a.id - b.id);
}

export async function openViewer(chatId, messageId, single = null) {
  if (viewer) closeViewer(false);
  const first = single || (S.msgs.get(chatId)?.list || []).find((m) => m.id === messageId);
  if (!first?.file) return;
  const mediaKind = first.kind === 'image' || first.kind === 'video';
  let items = mediaKind ? [first] : [first];
  let index = 0;

  const el = h('div', { class: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': first.file.name });
  const title = h('div', { class: 'viewer-title' });
  const counter = h('span', { class: 'viewer-count' });
  const stage = h('div', { class: 'viewer-stage' });
  const status = h('div', { class: 'viewer-status', role: 'status' });
  const zoomLabel = h('span', { class: 'viewer-zoom' }, '100%');
  const prev = h('button', { class: 'viewer-nav prev', type: 'button', 'aria-label': t('viewer.prev') }, icon('back', 28));
  const next = h('button', { class: 'viewer-nav next', type: 'button', 'aria-label': t('viewer.next') }, icon('back', 28));
  const dl = h('a', { class: 'icon-btn', 'aria-label': t('viewer.download'), title: t('viewer.download') }, icon('plus', 22));
  dl.firstChild.style.transform = 'rotate(45deg)';
  const bar = h('div', { class: 'viewer-bar' },
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), onclick: () => closeViewer(true) }, icon('close', 22)),
    title,
    h('span', { class: 'grow' }),
    counter,
    h('button', { class: 'icon-btn z', type: 'button', 'aria-label': t('viewer.zoom_out'), onclick: () => zoomBy(1 / 1.4) }, '−'),
    zoomLabel,
    h('button', { class: 'icon-btn z', type: 'button', 'aria-label': t('viewer.zoom_in'), onclick: () => zoomBy(1.4) }, '+'),
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('viewer.fullscreen'), onclick: toggleFullscreen }, '⛶'),
    dl);
  el.append(bar, stage, prev, next, status);
  document.body.append(el);
  document.body.classList.add('viewer-open');

  // Back button / gesture closes the viewer, not the chat
  const layer = openLayer(() => closeViewer(false));

  let scale = 1;
  let tx = 0;
  let ty = 0;
  let img = null;
  let token = 0;
  const blobs = [];

  function apply() {
    if (img) img.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)}%`;
    el.classList.toggle('zoomed', scale > 1.01);
  }
  function zoomBy(k) {
    scale = Math.min(8, Math.max(1, scale * k));
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  }
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else el.requestFullscreen?.().catch(() => {});
  }

  function fail(m) {
    clear(stage).append(h('div', { class: 'viewer-error' },
      h('div', null, t('viewer.error')),
      h('div', { class: 'muted' }, m.file.name),
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } },
        h('button', { class: 'btn', type: 'button', onclick: () => show(index) }, t('common.retry')),
        h('a', { class: 'btn secondary', href: `${m.file.url}?dl=1`, download: m.file.name }, t('viewer.download')))));
    status.textContent = '';
  }

  async function show(i) {
    index = Math.max(0, Math.min(items.length - 1, i));
    const my = ++token;
    const m = items[index];
    const f = m.file;
    scale = 1; tx = 0; ty = 0; img = null;
    title.replaceChildren(h('b', null, f.name), h('small', null, `${fmtDay(m.created_at)} ${fmtTime(m.created_at)} · ${formatBytes(f.size)}`));
    counter.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
    dl.href = `${f.url}?dl=1`;
    dl.download = f.name;
    prev.hidden = index === 0;
    next.hidden = index >= items.length - 1;
    el.classList.toggle('is-image', isImage(f));
    clear(stage);
    status.textContent = '';

    if (isImage(f)) {
      // thumbnail first, original on top once loaded
      const im = h('img', { class: 'viewer-img', alt: f.name, draggable: false, src: f.thumb || '' });
      if (f.thumb) im.classList.add('loading');
      img = im;
      stage.append(im);
      status.textContent = t('viewer.loading');
      try {
        const blobUrl = await cachedBlobUrl(f.url).catch(() => null);
        const src = blobUrl || f.url;
        if (blobUrl) blobs.push(blobUrl);
        await new Promise((res, rej) => {
          const pre = new Image();
          pre.onload = res;
          pre.onerror = rej;
          pre.src = src;
        });
        if (my !== token) return;
        im.src = src;
        im.classList.remove('loading');
        status.textContent = '';
      } catch {
        if (my === token) fail(m);
      }
      // warm the neighbours' previews
      for (const n of [items[index - 1], items[index + 1]]) if (n?.file.thumb) new Image().src = n.file.thumb;
      apply();
      return;
    }

    if (isVideo(f)) {
      const v = h('video', { class: 'viewer-video', controls: true, playsInline: true, preload: 'metadata', poster: f.thumb || '', src: f.url });
      v.addEventListener('waiting', () => { status.textContent = t('viewer.buffering'); });
      v.addEventListener('playing', () => { status.textContent = ''; });
      v.addEventListener('canplay', () => { status.textContent = ''; });
      v.addEventListener('progress', () => {
        if (v.buffered.length && v.duration) {
          const pct = Math.round((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
          el.dataset.buffered = String(pct);
        }
      });
      v.addEventListener('error', () => { if (my === token) fail(m); });
      stage.append(v);
      status.textContent = t('viewer.loading');
      v.addEventListener('loadedmetadata', () => { status.textContent = ''; });
      return;
    }

    if (isAudio(f)) {
      stage.append(h('div', { class: 'viewer-doc' }, h('div', { class: 'big-ico' }, '🎵'), h('b', null, f.name),
        h('audio', { controls: true, src: f.url, preload: 'metadata' })));
      return;
    }

    if (isPdf(f) && navigator.pdfViewerEnabled !== false && !/Android/i.test(navigator.userAgent)) {
      // the browser's PDF viewer streams pages as you scroll (Range requests)
      stage.append(h('iframe', { class: 'viewer-pdf', title: f.name, src: `${f.url}?inline=1`, sandbox: 'allow-same-origin allow-scripts allow-popups' }));
      return;
    }

    stage.append(h('div', { class: 'viewer-doc' },
      h('div', { class: 'big-ico' }, isPdf(f) ? '📄' : '📎'),
      h('b', null, f.name), h('span', { class: 'muted' }, `${f.mime} · ${formatBytes(f.size)}`),
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '14px' } },
        canOpenNative() ? h('button', { class: 'btn', type: 'button', onclick: () => openNative(f) }, t('viewer.open')) : null,
        !canOpenNative() && isPdf(f) ? h('a', { class: 'btn', href: `${f.url}?inline=1`, target: '_blank', rel: 'noopener' }, t('viewer.open')) : null,
        h('a', { class: `btn ${canOpenNative() ? 'secondary' : 'secondary'}`, href: `${f.url}?dl=1`, download: f.name, onclick: (e) => { if (canOpenNative()) { e.preventDefault(); openNative(f); } } }, t('viewer.download')))));
  }

  // ---- gestures: wheel zoom, double-click, drag-to-pan, pinch, swipe between items
  stage.addEventListener('wheel', (e) => {
    if (!img) return;
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  stage.addEventListener('dblclick', () => {
    if (!img) return;
    scale = scale > 1.01 ? 1 : 2.5;
    if (scale === 1) { tx = 0; ty = 0; }
    apply();
  });
  const pointers = new Map();
  let pinch0 = 0;
  let swipeX = null;
  stage.addEventListener('pointerdown', (e) => {
    if (!img) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      pinch0 = Math.hypot(a.x - b.x, a.y - b.y) / scale;
    } else {
      swipeX = e.clientX;
    }
  });
  stage.addEventListener('pointermove', (e) => {
    if (!img || !pointers.has(e.pointerId)) return;
    const p = pointers.get(e.pointerId);
    if (pointers.size === 2) {
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      const [a, b] = [...pointers.values()];
      scale = Math.min(8, Math.max(1, Math.hypot(a.x - b.x, a.y - b.y) / (pinch0 || 1)));
      apply();
    } else if (scale > 1.01) {
      tx += e.clientX - p.x;
      ty += e.clientY - p.y;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      apply();
    }
  });
  const up = (e) => {
    pointers.delete(e.pointerId);
    if (swipeX !== null && scale <= 1.01 && pointers.size === 0 && e.pointerType === 'touch') {
      const dx = e.clientX - swipeX;
      if (Math.abs(dx) > 70) show(index + (dx < 0 ? 1 : -1));
    }
    swipeX = null;
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);
  stage.addEventListener('click', (e) => { if (e.target === stage && !el.classList.contains('zoomed')) closeViewer(true); });

  prev.onclick = () => show(index - 1);
  next.onclick = () => show(index + 1);
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeViewer(true); }
    else if (e.key === 'ArrowLeft') show(index - 1);
    else if (e.key === 'ArrowRight') show(index + 1);
    else if (e.key === '+' || e.key === '=') zoomBy(1.4);
    else if (e.key === '-') zoomBy(1 / 1.4);
    else if (e.key === '0') { scale = 1; tx = 0; ty = 0; apply(); }
    else if (e.key.toLowerCase() === 'f') toggleFullscreen();
  };
  document.addEventListener('keydown', onKey, true);

  viewer = {
    el,
    close(popHistory) {
      document.removeEventListener('keydown', onKey, true);
      closeLayer(layer);
      if (document.fullscreenElement) document.exitFullscreen?.();
      blobs.forEach((u) => URL.revokeObjectURL(u));
      el.remove();
      document.body.classList.remove('viewer-open');
    },
  };

  await show(0);
  if (mediaKind) {
    items = await loadItems(chatId, first.id);
    const i = items.findIndex((x) => x.id === first.id);
    if (i >= 0 && viewer) {
      index = i;
      counter.textContent = items.length > 1 ? `${index + 1} / ${items.length}` : '';
      prev.hidden = index === 0;
      next.hidden = index >= items.length - 1;
    }
  }
}

export function closeViewer(popHistory = true) {
  viewer?.close(popHistory);
  viewer = null;
}

// ---------------------------------------------------------------- "Media & files" panel
export function openMediaPanel(chatId) {
  let kind = 'media';
  const grid = h('div', { class: 'media-grid' });
  const more = h('button', { class: 'btn secondary', type: 'button', hidden: true }, t('chat.load_more'));
  const tabs = h('div', { class: 'tabs', role: 'tablist' });
  const m = modal({ title: t('media.title'), body: [tabs, grid, more], className: 'media-modal' });
  let before = null;
  let busy = false;

  const label = { media: t('media.media'), files: t('media.files'), links: t('media.links') };
  for (const k of ['media', 'files', 'links']) {
    tabs.append(h('button', {
      class: 'tab', type: 'button', role: 'tab', dataset: { k }, 'aria-selected': String(k === kind),
      onclick: () => { kind = k; before = null; clear(grid); draw(); },
    }, label[k]));
  }

  function cell(msg) {
    const f = msg.file;
    if (kind === 'media') {
      return h('button', { class: 'media-cell', type: 'button', onclick: () => { m.close(); openViewer(chatId, msg.id, msg); } },
        h('img', { src: f.thumb || (isImage(f) ? f.url : ''), alt: f.name, loading: 'lazy' }),
        isVideo(f) ? h('span', { class: 'play' }, '▶') : null);
    }
    if (kind === 'files') {
      return h('button', { class: 'list-item clickable', type: 'button', onclick: () => { m.close(); openViewer(chatId, msg.id, msg); } },
        h('span', { class: 'ficon' }, (f.name.split('.').pop() || 'FILE').slice(0, 4).toUpperCase()),
        h('span', { class: 'grow' }, h('b', { class: 'ellipsis', style: { display: 'block' } }, f.name),
          h('span', { class: 'muted' }, `${formatBytes(f.size)} · ${fmtDay(msg.created_at)}`)));
    }
    return h('div', { class: 'list-item' }, h('span', { class: 'grow' },
      (msg.links || []).map((u) => h('a', { href: u, target: '_blank', rel: 'noopener noreferrer nofollow', class: 'ellipsis', style: { display: 'block' } }, u)),
      h('span', { class: 'muted' }, fmtDay(msg.created_at))));
  }

  async function draw() {
    if (busy) return;
    busy = true;
    tabs.querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.k === kind)));
    grid.className = kind === 'media' ? 'media-grid' : 'media-list';
    try {
      const r = await api('GET', `/api/chats/${chatId}/media?kind=${kind}${before ? `&before=${before}` : ''}`);
      if (!r.messages.length && !before) grid.append(h('div', { class: 'empty' }, t('media.empty')));
      for (const msg of r.messages) grid.append(cell(msg));
      if (r.messages.length) before = Math.min(...r.messages.map((x) => x.id));
      more.hidden = !r.has_more;
    } catch (e) { toast(errText(e.code)); }
    busy = false;
  }
  more.onclick = draw;
  draw();
}

// ---------------------------------------------------------------- storage (settings)
export function storageSection() {
  const info = h('div', { class: 'muted', role: 'status' });
  const btn = h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
    await clearAll();
    toast(t('storage.cleared'));
    refresh();
  } }, t('storage.clear'));
  async function refresh() {
    const u = await usage();
    info.textContent = `${t('storage.cached')}: ${formatBytes(u.bytes)} (${u.items})${u.quota?.usage ? ` · ${t('storage.total')}: ${formatBytes(u.quota.usage)}` : ''}`;
  }
  refresh();
  return [h('h3', null, t('storage.title')), info, h('div', { class: 'muted', style: { fontSize: '.85rem', margin: '6px 0' } }, t('storage.hint')), btn];
}
