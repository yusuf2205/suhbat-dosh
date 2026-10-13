// PDF reader (pdf.js) with a Chrome-style toolbar: page number, zoom, fit width / page, rotate,
// text notes, pen, undo / redo, download (with the notes burnt in), print, two-page mode, presentation mode, properties.
import { h, formatBytes } from './dom.js';
import { t } from './i18n.js';
import { fileBlob, onDownload } from './downloads.js';
import { modal, toast } from './ui.js';

const loaded = new Map();
function script(src, global, after) {
  if (window[global]) return Promise.resolve(window[global]);
  if (!loaded.has(src)) {
    loaded.set(src, new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = () => {
        if (!window[global]) return reject(new Error(global));
        after?.(window[global]);
        resolve(window[global]);
      };
      s.onerror = () => reject(new Error(global));
      document.head.appendChild(s);
    }));
  }
  return loaded.get(src);
}
const pdfjs = () => script('/js/vendor/pdf.js', 'pdfjsLib', (l) => { l.GlobalWorkerOptions.workerSrc = '/js/vendor/pdf.worker.js'; });
const pdfLib = () => script('/js/vendor/pdf-lib.js', 'PDFLib');

const NS = 'http://www.w3.org/2000/svg';
function svgIcon(d, size = 20) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2');
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  for (const part of d.split('|')) {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('d', part);
    s.append(p);
  }
  return s;
}
const ICONS = {
  menu: 'M4 6h16|M4 12h16|M4 18h16',
  minus: 'M5 12h14',
  plus: 'M12 5v14|M5 12h14',
  fitpage: 'M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M9 8l3-3 3 3|M9 16l3 3 3-3',
  fitwidth: 'M3 7h18v10H3z|M7 12h10|M9 10l-2 2 2 2|M15 10l2 2-2 2',
  rotate: 'M20 12a8 8 0 1 1-2.3-5.7|M20 4v5h-5',
  text: 'M5 6V4h14v2|M12 4v16|M9 20h6',
  pen: 'M4 20l4-1 11-11a2.1 2.1 0 0 0-3-3L5 16z|M14 7l3 3',
  undo: 'M9 14L4 9l5-5|M4 9h10a6 6 0 0 1 0 12h-3',
  redo: 'M15 14l5-5-5-5|M20 9H10a6 6 0 0 0 0 12h3',
  download: 'M12 4v11|M7.5 10.5L12 15l4.5-4.5|M5 19h14',
  print: 'M7 9V3h10v6|M7 17H5a2 2 0 0 1-2-2v-4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-2|M7 14h10v7H7z',
  more: 'M12 5v.01|M12 12v.01|M12 19v.01',
};

const COLORS = ['#e5484d', '#1f6feb', '#111111'];

/** A scrollable PDF reader for `file` ({id,url,name,size}). `fallback` builds the node shown if the PDF cannot be read. */
export function pdfNode(file, { fallback } = {}) {
  const status = h('div', { class: 'pdf-status' }, t('doc.loading'));
  const pages = h('div', { class: 'pdf-pages' });
  const scroller = h('div', { class: 'pdf-scroll' }, status, pages);
  const thumbs = h('div', { class: 'pdf-thumbs', hidden: true });
  const body = h('div', { class: 'pdf-body' }, thumbs, scroller);
  const bar = h('div', { class: 'pdf-bar', hidden: true });
  const root = h('div', { class: 'pdf-view' }, bar, body);
  const off = onDownload((x) => {
    if (x.id !== file.id || x.state === 'done') return;
    status.textContent = `${t('doc.loading')} ${formatBytes(x.loaded)} / ${formatBytes(x.total)}`;
  });

  (async () => {
    try {
      const [lib, blob] = await Promise.all([pdfjs(), fileBlob(file, 2)]);
      off();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const doc = await lib.getDocument({ data: bytes.slice() }).promise;
      status.hidden = true;
      start(doc, bytes);
    } catch (e) {
      off();
      if (fallback) root.replaceChildren(fallback(e));
      else status.textContent = t('doc.failed');
    }
  })();

  function start(doc, bytes) {
    const state = {
      mode: 'width', zoom: 1, rotation: 0, two: false, tool: null, color: COLORS[0], current: 1,
      annots: new Map(), undo: [], redo: [],
    };
    let io = null;
    let baseSize = null; // first page at rotation 0, in PDF points
    const slots = new Map();

    const pctLabel = h('span', { class: 'pdf-zoom' }, '100%');
    const pageInput = h('input', { class: 'pdf-page-input', type: 'text', inputMode: 'numeric', 'aria-label': t('pdf.page'), value: '1' });
    const total = h('span', { class: 'pdf-total' }, `/ ${doc.numPages}`);
    const title = h('span', { class: 'pdf-title ellipsis' }, file.name);
    const btn = (icon, label, fn, cls = '') => h('button', { class: `pdf-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick: fn }, svgIcon(ICONS[icon]));
    const sep = () => h('span', { class: 'pdf-sep' });

    const btnText = btn('text', t('pdf.text'), () => setTool(state.tool === 'text' ? null : 'text'), 'tool');
    const btnPen = btn('pen', t('pdf.pen'), () => setTool(state.tool === 'draw' ? null : 'draw'), 'tool');
    const btnUndo = btn('undo', t('pdf.undo'), () => undo());
    const btnRedo = btn('redo', t('pdf.redo'), () => redo());
    const colorBox = h('span', { class: 'pdf-colors', hidden: true }, COLORS.map((c) => {
      const b = h('button', { class: 'pdf-color', type: 'button', 'aria-label': c, onclick: () => { state.color = c; paintColors(); } });
      b.style.background = c;
      return b;
    }));
    function paintColors() {
      colorBox.querySelectorAll('.pdf-color').forEach((b, i) => b.classList.toggle('on', COLORS[i] === state.color));
    }
    paintColors();
    const menuBtn = btn('more', t('pdf.more'), (e) => openMenu(e.currentTarget));

    bar.append(
      btn('menu', t('pdf.thumbs'), () => { thumbs.hidden = !thumbs.hidden; if (!thumbs.hidden) buildThumbs(); layout(); }),
      title,
      h('span', { class: 'pdf-group' }, pageInput, total),
      sep(),
      h('span', { class: 'pdf-group' }, btn('minus', t('viewer.zoom_out'), () => zoomBy(-0.2)), pctLabel, btn('plus', t('viewer.zoom_in'), () => zoomBy(0.2))),
      sep(),
      btn('fitpage', t('pdf.fit_page'), () => { state.mode = 'page'; layout(); }),
      btn('fitwidth', t('viewer.fit'), () => { state.mode = 'width'; state.zoom = 1; layout(); }),
      btn('rotate', t('pdf.rotate'), () => rotate()),
      sep(),
      btnText, btnPen, colorBox, btnUndo, btnRedo,
      h('span', { class: 'pdf-spacer' }),
      btn('download', t('viewer.download'), () => download()),
      btn('print', t('pdf.print'), () => print()),
      menuBtn);
    bar.hidden = false;

    // ------------------------------------------------------------ geometry
    function availWidth() {
      const side = thumbs.hidden ? 0 : 0; // the thumbnails column is a separate flex child
      return Math.max(240, scroller.clientWidth - 32 - side);
    }
    function rotatedBase() {
      const r = state.rotation % 180 !== 0;
      return r ? { w: baseSize.h, h: baseSize.w } : { w: baseSize.w, h: baseSize.h };
    }
    function targetWidth() {
      const b = rotatedBase();
      const cols = state.two ? 2 : 1;
      const avail = (availWidth() - (cols - 1) * 12) / cols;
      if (state.mode === 'page') {
        const byHeight = (scroller.clientHeight - 24) * (b.w / b.h);
        return Math.round(Math.max(200, Math.min(avail, byHeight)));
      }
      return Math.round(Math.max(200, Math.min(2400, avail * state.zoom)));
    }
    function percentOf(width) {
      const b = rotatedBase();
      return Math.round((width / (b.w * 96 / 72)) * 100);
    }
    function zoomBy(delta) {
      const w = targetWidth();
      const avail = (availWidth() - (state.two ? 12 : 0)) / (state.two ? 2 : 1);
      state.mode = 'custom';
      state.zoom = Math.max(0.3, Math.min(4, +((w / avail) + delta).toFixed(2)));
      layout();
    }

    // ------------------------------------------------------------ annotations (kept as normalised 0..1 coordinates)
    const listOf = (n) => { if (!state.annots.has(n)) state.annots.set(n, []); return state.annots.get(n); };
    const hasAnnots = () => [...state.annots.values()].some((l) => l.length);
    function syncButtons() {
      btnText.classList.toggle('on', state.tool === 'text');
      btnPen.classList.toggle('on', state.tool === 'draw');
      colorBox.hidden = !state.tool;
      btnUndo.disabled = !state.undo.length;
      btnRedo.disabled = !state.redo.length;
      pages.dataset.tool = state.tool || '';
    }
    function setTool(tool) { state.tool = tool; syncButtons(); }
    function addItem(n, item) {
      listOf(n).push(item);
      state.undo.push({ n, item });
      state.redo = [];
      paintAnnots(n);
      syncButtons();
    }
    function undo() {
      const a = state.undo.pop();
      if (!a) return;
      const l = listOf(a.n);
      l.splice(l.indexOf(a.item), 1);
      state.redo.push(a);
      paintAnnots(a.n);
      syncButtons();
    }
    function redo() {
      const a = state.redo.pop();
      if (!a) return;
      listOf(a.n).push(a.item);
      state.undo.push(a);
      paintAnnots(a.n);
      syncButtons();
    }
    function paintAnnots(n) {
      const slot = slots.get(n);
      if (!slot) return;
      const layer = slot.querySelector('.pdf-ann');
      if (!layer) return;
      layer.replaceChildren();
      for (const it of listOf(n)) {
        if (it.type === 'stroke') {
          const pl = document.createElementNS(NS, 'polyline');
          pl.setAttribute('points', it.pts.map((p) => `${p[0]},${p[1]}`).join(' '));
          pl.setAttribute('fill', 'none');
          pl.setAttribute('stroke', it.color);
          pl.setAttribute('stroke-width', '2.5');
          pl.setAttribute('stroke-linecap', 'round');
          pl.setAttribute('stroke-linejoin', 'round');
          pl.setAttribute('vector-effect', 'non-scaling-stroke');
          layer.append(pl);
        }
      }
      slot.querySelectorAll('.pdf-note').forEach((x) => x.remove());
      for (const it of listOf(n)) {
        if (it.type !== 'text') continue;
        const el = h('div', { class: 'pdf-note', contentEditable: 'true', spellcheck: 'false' }, it.text);
        el.style.left = `${it.x * 100}%`;
        el.style.top = `${it.y * 100}%`;
        el.style.color = it.color;
        el.style.fontSize = `${it.size * 100}cqw`; // relative to the page width
        el.addEventListener('input', () => { it.text = el.textContent; });
        el.addEventListener('blur', () => { if (!el.textContent.trim()) { const l = listOf(n); const i = l.indexOf(it); if (i >= 0) l.splice(i, 1); el.remove(); } });
        slot.append(el);
      }
    }
    function attachDrawing(slot, n) {
      const layer = slot.querySelector('.pdf-ann');
      let stroke = null;
      const norm = (e) => {
        const r = slot.getBoundingClientRect();
        return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
      };
      slot.addEventListener('pointerdown', (e) => {
        if (state.tool === 'text') {
          if (e.target.closest?.('.pdf-note')) return;
          const [x, y] = norm(e);
          const item = { type: 'text', x, y, text: t('pdf.text_default'), color: state.color, size: 0.028 };
          addItem(n, item);
          const el = [...slot.querySelectorAll('.pdf-note')].at(-1);
          if (el) { el.focus(); document.getSelection()?.selectAllChildren(el); }
          e.preventDefault();
          return;
        }
        if (state.tool !== 'draw') return;
        stroke = { type: 'stroke', color: state.color, pts: [norm(e)] };
        listOf(n).push(stroke);
        slot.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      slot.addEventListener('pointermove', (e) => {
        if (!stroke) return;
        stroke.pts.push(norm(e));
        paintAnnots(n);
      });
      const end = () => {
        if (!stroke) return;
        const l = listOf(n);
        if (stroke.pts.length < 2) l.splice(l.indexOf(stroke), 1);
        else { state.undo.push({ n, item: stroke }); state.redo = []; }
        stroke = null;
        paintAnnots(n);
        syncButtons();
      };
      slot.addEventListener('pointerup', end);
      slot.addEventListener('pointercancel', end);
      void layer;
    }

    // ------------------------------------------------------------ rendering
    async function drawPage(slot, n, width) {
      const page = await doc.getPage(n);
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const unit = page.getViewport({ scale: 1, rotation: (page.rotate + state.rotation) % 360 });
      const vp = page.getViewport({ scale: (width / unit.width) * dpr, rotation: (page.rotate + state.rotation) % 360 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width);
      canvas.height = Math.floor(vp.height);
      canvas.style.width = '100%';
      canvas.style.height = '100%';
      await page.render({ canvasContext: canvas.getContext('2d'), viewport: vp }).promise;
      if (slot.__token !== width + ':' + state.rotation) return; // the layout changed while drawing
      slot.querySelector('.pdf-canvas')?.replaceChildren(canvas);
      slot.style.height = `${Math.round(width * (vp.height / vp.width))}px`;
    }

    function layout() {
      io?.disconnect();
      const width = targetWidth();
      const b = rotatedBase();
      const height = Math.round(width * (b.h / b.w));
      pages.replaceChildren();
      pages.classList.toggle('two', state.two);
      slots.clear();
      io = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          io.unobserve(e.target);
          drawPage(e.target, Number(e.target.dataset.n), width).catch(() => {});
        }
      }, { root: scroller, rootMargin: '900px 0px' });
      for (let n = 1; n <= doc.numPages; n += 1) {
        const slot = h('div', { class: 'pdf-page', dataset: { n: String(n) } },
          h('div', { class: 'pdf-canvas' }),
          (() => {
            const svg = document.createElementNS(NS, 'svg');
            svg.setAttribute('class', 'pdf-ann');
            svg.setAttribute('viewBox', '0 0 1 1');
            svg.setAttribute('preserveAspectRatio', 'none');
            return svg;
          })());
        slot.style.width = `${width}px`;
        slot.style.height = `${height}px`;
        slot.__token = width + ':' + state.rotation;
        pages.append(slot);
        slots.set(n, slot);
        attachDrawing(slot, n);
        paintAnnots(n);
        io.observe(slot);
      }
      pctLabel.textContent = `${percentOf(width)}%`;
      goTo(state.current, false);
    }

    function goTo(n, smooth = true) {
      const s = slots.get(Math.max(1, Math.min(doc.numPages, n)));
      if (!s) return;
      state.current = Number(s.dataset.n);
      pageInput.value = String(state.current);
      scroller.scrollTo({ top: s.offsetTop - 12, behavior: smooth ? 'smooth' : 'auto' });
    }
    pageInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      const n = parseInt(pageInput.value, 10);
      if (Number.isFinite(n)) goTo(n);
      pageInput.blur();
    });
    scroller.addEventListener('scroll', () => {
      const mid = scroller.scrollTop + scroller.clientHeight / 3;
      let cur = state.current;
      for (const [n, s] of slots) { if (s.offsetTop <= mid) cur = n; else break; }
      if (cur !== state.current) {
        state.current = cur;
        if (document.activeElement !== pageInput) pageInput.value = String(cur);
        thumbs.querySelectorAll('.pdf-thumb').forEach((x) => x.classList.toggle('on', Number(x.dataset.n) === cur));
      }
    }, { passive: true });

    function rotate() {
      if (hasAnnots()) { toast(t('pdf.rotate_blocked')); return; }
      state.rotation = (state.rotation + 90) % 360;
      layout();
      if (!thumbs.hidden) buildThumbs();
    }

    // ------------------------------------------------------------ thumbnails
    function buildThumbs() {
      thumbs.replaceChildren();
      const tio = new IntersectionObserver((entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          tio.unobserve(e.target);
          (async () => {
            const n = Number(e.target.dataset.n);
            const page = await doc.getPage(n);
            const unit = page.getViewport({ scale: 1, rotation: (page.rotate + state.rotation) % 360 });
            const vp = page.getViewport({ scale: 120 / unit.width, rotation: (page.rotate + state.rotation) % 360 });
            const c = document.createElement('canvas');
            c.width = Math.floor(vp.width);
            c.height = Math.floor(vp.height);
            await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
            e.target.querySelector('.pdf-thumb-img').replaceChildren(c);
          })().catch(() => {});
        }
      }, { root: thumbs, rootMargin: '300px 0px' });
      const b = rotatedBase();
      for (let n = 1; n <= doc.numPages; n += 1) {
        const img = h('div', { class: 'pdf-thumb-img' });
        img.style.width = '120px';
        img.style.height = `${Math.round(120 * (b.h / b.w))}px`;
        const th = h('button', { class: `pdf-thumb${n === state.current ? ' on' : ''}`, type: 'button', dataset: { n: String(n) }, onclick: () => goTo(n) },
          img, h('span', null, String(n)));
        thumbs.append(th);
        tio.observe(th);
      }
    }

    // ------------------------------------------------------------ export, print, properties
    async function renderFlat(n, scale) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale, rotation: (page.rotate + state.rotation) % 360 });
      const c = document.createElement('canvas');
      c.width = Math.floor(vp.width);
      c.height = Math.floor(vp.height);
      const ctx = c.getContext('2d');
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      for (const it of listOf(n)) {
        if (it.type === 'stroke') {
          ctx.strokeStyle = it.color;
          ctx.lineWidth = 2.5 * scale;
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';
          ctx.beginPath();
          it.pts.forEach((p, i) => (i ? ctx.lineTo(p[0] * c.width, p[1] * c.height) : ctx.moveTo(p[0] * c.width, p[1] * c.height)));
          ctx.stroke();
        } else if (it.type === 'text' && it.text.trim()) {
          ctx.fillStyle = it.color;
          const px = it.size * c.width;
          ctx.font = `${px}px system-ui, Arial, sans-serif`;
          ctx.textBaseline = 'top';
          it.text.split('\n').forEach((line, i) => ctx.fillText(line, it.x * c.width, it.y * c.height + i * px * 1.2));
        }
      }
      return c;
    }

    async function download() {
      try {
        let out = blob;
        let name = file.name;
        if (hasAnnots()) {
          const { PDFDocument } = await pdfLib();
          const pdf = await PDFDocument.load(bytes);
          for (const [n, l] of state.annots) {
            if (!l.length) continue;
            const page = pdf.getPage(n - 1);
            const { width, height } = page.getSize();
            const c = await renderFlat(n, 2);
            const jpg = await pdf.embedJpg(await new Promise((res) => c.toBlob((b) => b.arrayBuffer().then(res), 'image/jpeg', 0.92)));
            page.drawImage(jpg, { x: 0, y: 0, width, height });
          }
          out = new Blob([await pdf.save()], { type: 'application/pdf' });
          name = name.replace(/\.pdf$/i, '') + ` (${t('pdf.with_notes')}).pdf`;
        }
        const a = document.createElement('a');
        a.href = URL.createObjectURL(out);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
      } catch { toast(t('doc.failed')); }
    }
    const blob = new Blob([bytes], { type: 'application/pdf' });

    async function print() {
      toast(t('pdf.preparing_print'), 1500);
      try {
        const box = h('div', { id: 'print-root' });
        for (let n = 1; n <= doc.numPages; n += 1) {
          const c = await renderFlat(n, 1.6);
          const img = h('img', { class: 'print-page', alt: '' });
          img.src = c.toDataURL('image/jpeg', 0.9);
          box.append(img);
        }
        document.body.append(box);
        document.documentElement.classList.add('printing');
        const done = () => { document.documentElement.classList.remove('printing'); box.remove(); window.removeEventListener('afterprint', done); };
        window.addEventListener('afterprint', done);
        setTimeout(() => window.print(), 100);
        setTimeout(done, 120_000);
      } catch { toast(t('doc.failed')); }
    }

    function openMenu(anchor) {
      const r = anchor.getBoundingClientRect();
      const menu = h('div', { class: 'pdf-menu', role: 'menu' });
      menu.style.top = `${r.bottom + 4}px`;
      menu.style.right = `${Math.max(8, window.innerWidth - r.right)}px`;
      const close = () => { menu.remove(); document.removeEventListener('pointerdown', away, true); };
      const away = (e) => { if (!menu.contains(e.target)) close(); };
      const item = (label, fn, on = false) => h('button', { class: `pdf-menu-item${on ? ' on' : ''}`, type: 'button', role: 'menuitem', onclick: () => { close(); fn(); } }, on ? `✓ ${label}` : label);
      menu.append(
        item(t('pdf.two_pages'), () => { state.two = !state.two; layout(); }, state.two),
        item(t('pdf.present'), () => present()),
        item(t('pdf.properties'), () => properties()));
      document.body.append(menu);
      setTimeout(() => document.addEventListener('pointerdown', away, true), 0);
    }

    function present() {
      state.mode = 'page';
      layout();
      try { (root.requestFullscreen || root.webkitRequestFullscreen)?.call(root); } catch { /* not allowed here */ }
      setTimeout(layout, 300);
    }

    async function properties() {
      let info = {};
      try { info = (await doc.getMetadata()).info || {}; } catch { /* none */ }
      const row = (k, v) => (v ? h('div', { class: 'prop-row' }, h('span', { class: 'muted' }, k), h('b', null, String(v))) : null);
      const fmt = (d) => {
        const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?/.exec(d || '');
        return m ? `${m[3]}.${m[2]}.${m[1]}${m[4] ? ` ${m[4]}:${m[5] || '00'}` : ''}` : '';
      };
      modal({
        title: t('pdf.properties'),
        body: h('div', null,
          row(t('pdf.p_name'), file.name), row(t('pdf.p_title'), info.Title), row(t('pdf.p_author'), info.Author),
          row(t('pdf.p_creator'), info.Creator), row(t('pdf.p_producer'), info.Producer), row(t('pdf.p_created'), fmt(info.CreationDate)),
          row(t('pdf.p_pages'), doc.numPages), row(t('pdf.p_size'), formatBytes(file.size))),
      });
    }

    window.addEventListener('resize', () => {
      if (!root.isConnected) return;
      clearTimeout(start.rt);
      start.rt = setTimeout(layout, 250);
    });
    document.addEventListener('fullscreenchange', () => { if (root.isConnected) setTimeout(layout, 150); });

    doc.getPage(1).then((p) => {
      const v = p.getViewport({ scale: 1 });
      baseSize = { w: v.width, h: v.height };
      syncButtons();
      layout();
    });
  }
  return root;
}
