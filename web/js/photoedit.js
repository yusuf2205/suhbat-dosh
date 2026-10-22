// Photo editor before sending (crop, rotate, pen, text, blur out a detail) and a document scanner that makes a PDF.
// Everything happens on this device, on a canvas; nothing is uploaded until the person presses "Send".
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { modal, toast } from './ui.js';
import { jpegPdf } from './pdfmake.js';

const MAX_SIDE = 2400;
const COLORS = ['#ff3b30', '#ffd23f', '#34c759', '#0a84ff', '#ffffff', '#111111'];

async function loadBitmap(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}

/** A black-and-white "paper" look: each pixel is compared with the average of its neighbourhood. */
export function paperFilter(canvas) {
  const w = canvas.width;
  const hh = canvas.height;
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, w, hh);
  const d = img.data;
  const gray = new Uint8ClampedArray(w * hh);
  for (let i = 0, j = 0; i < d.length; i += 4, j += 1) gray[j] = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000;
  const integral = new Float64Array((w + 1) * (hh + 1));
  for (let y = 1; y <= hh; y += 1) {
    let row = 0;
    for (let x = 1; x <= w; x += 1) { row += gray[(y - 1) * w + x - 1]; integral[y * (w + 1) + x] = integral[(y - 1) * (w + 1) + x] + row; }
  }
  const r = Math.max(8, Math.round(Math.min(w, hh) / 16));
  for (let y = 0; y < hh; y += 1) {
    const y0 = Math.max(0, y - r);
    const y1 = Math.min(hh, y + r + 1);
    for (let x = 0; x < w; x += 1) {
      const x0 = Math.max(0, x - r);
      const x1 = Math.min(w, x + r + 1);
      const sum = integral[y1 * (w + 1) + x1] - integral[y0 * (w + 1) + x1] - integral[y1 * (w + 1) + x0] + integral[y0 * (w + 1) + x0];
      const mean = sum / ((x1 - x0) * (y1 - y0));
      const v = gray[y * w + x] < mean * 0.9 ? 0 : 255;
      const i = (y * w + x) * 4;
      d[i] = v; d[i + 1] = v; d[i + 2] = v;
    }
  }
  ctx.putImageData(img, 0, 0);
}

/** Stronger contrast and a slightly brighter page, colours kept. */
export function brightenFilter(canvas) {
  const ctx = canvas.getContext('2d');
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k += 1) d[i + k] = Math.max(0, Math.min(255, (d[i + k] - 110) * 1.6 + 150));
  ctx.putImageData(img, 0, 0);
}

function pixelate(ctx, x, y, radius) {
  const block = Math.max(8, Math.round(radius / 2.2));
  const x0 = Math.max(0, Math.floor((x - radius) / block) * block);
  const y0 = Math.max(0, Math.floor((y - radius) / block) * block);
  for (let by = y0; by < y + radius; by += block) {
    for (let bx = x0; bx < x + radius; bx += block) {
      if ((bx + block / 2 - x) ** 2 + (by + block / 2 - y) ** 2 > radius * radius) continue;
      const w = Math.min(block, ctx.canvas.width - bx);
      const hh = Math.min(block, ctx.canvas.height - by);
      if (w <= 0 || hh <= 0) continue;
      const px = ctx.getImageData(bx, by, w, hh).data;
      let r = 0; let g = 0; let b = 0; const n = px.length / 4;
      for (let i = 0; i < px.length; i += 4) { r += px[i]; g += px[i + 1]; b += px[i + 2]; }
      ctx.fillStyle = `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`;
      ctx.fillRect(bx, by, w, hh);
    }
  }
}

/**
 * Open the editor for an image file. Resolves with the edited JPEG file, or null when the person cancels.
 * options.doc: show the document filters (scanner).
 */
export async function editImage(file, { doc = false, title } = {}) {
  let base;
  try { base = await loadBitmap(file); } catch { toast(t('pe.cannot_open')); return null; }
  return new Promise((resolve) => {
    const undo = [];
    let tool = doc ? 'crop' : 'pen';
    let color = COLORS[0];
    let size = 6;
    let sel = null; // crop rectangle in picture coordinates
    let drag = null;
    const view = h('canvas', { class: 'pe-canvas' });
    const over = h('canvas', { class: 'pe-over' });
    const stage = h('div', { class: 'pe-stage' }, view, over);
    const tools = h('div', { class: 'pe-tools' });
    const opts = h('div', { class: 'pe-opts' });
    let done = false;

    const snapshot = () => { undo.push(base.getContext('2d').getImageData(0, 0, base.width, base.height)); if (undo.length > 8) undo.shift(); };
    const draw = () => {
      const maxW = Math.min(window.innerWidth - 48, 900);
      const maxH = Math.max(240, window.innerHeight - 280);
      const k = Math.min(1, maxW / base.width, maxH / base.height);
      const w = Math.round(base.width * k);
      const hh = Math.round(base.height * k);
      for (const c of [view, over]) { c.width = w; c.height = hh; }
      view.getContext('2d').drawImage(base, 0, 0, w, hh);
      const o = over.getContext('2d');
      o.clearRect(0, 0, w, hh);
      if (sel && tool === 'crop') {
        o.fillStyle = 'rgba(0,0,0,.5)';
        o.fillRect(0, 0, w, hh);
        const sx = sel.x * k; const sy = sel.y * k; const sw = sel.w * k; const sh = sel.h * k;
        o.clearRect(sx, sy, sw, sh);
        o.strokeStyle = '#fff'; o.lineWidth = 2; o.strokeRect(sx, sy, sw, sh);
      }
      stage.style.setProperty('--k', String(k));
      stage.dataset.k = String(k);
    };
    const kOf = () => Number(stage.dataset.k) || 1;
    const pt = (e) => { const r = over.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * base.width, y: ((e.clientY - r.top) / r.height) * base.height }; };

    const rotate = (dir) => {
      snapshot();
      const c = document.createElement('canvas');
      c.width = base.height; c.height = base.width;
      const x = c.getContext('2d');
      x.translate(c.width / 2, c.height / 2);
      x.rotate((dir * Math.PI) / 2);
      x.drawImage(base, -base.width / 2, -base.height / 2);
      base = c; sel = null; draw();
    };
    const applyCrop = () => {
      if (!sel || sel.w < 8 || sel.h < 8) return;
      snapshot();
      const c = document.createElement('canvas');
      c.width = Math.round(sel.w); c.height = Math.round(sel.h);
      c.getContext('2d').drawImage(base, Math.round(sel.x), Math.round(sel.y), c.width, c.height, 0, 0, c.width, c.height);
      base = c; sel = null; draw();
    };

    over.addEventListener('pointerdown', (e) => {
      over.setPointerCapture(e.pointerId);
      const p = pt(e);
      drag = { start: p, last: p };
      if (tool === 'crop') { sel = { x: p.x, y: p.y, w: 0, h: 0 }; return; }
      if (tool === 'text') {
        drag = null;
        const text = window.prompt(t('pe.text_ph'));
        if (text) {
          snapshot();
          const ctx = base.getContext('2d');
          const px = Math.round(Math.max(22, base.width / 18) * (size / 6));
          ctx.font = `700 ${px}px system-ui, sans-serif`;
          ctx.textBaseline = 'top';
          ctx.lineWidth = Math.max(3, px / 8);
          ctx.strokeStyle = color === '#ffffff' ? '#000' : '#fff';
          ctx.strokeText(text, p.x, p.y);
          ctx.fillStyle = color;
          ctx.fillText(text, p.x, p.y);
          draw();
        }
        return;
      }
      snapshot();
      if (tool === 'blur') { pixelate(base.getContext('2d'), p.x, p.y, size * 5); draw(); }
    });
    over.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const p = pt(e);
      if (tool === 'crop') {
        sel = { x: Math.max(0, Math.min(drag.start.x, p.x)), y: Math.max(0, Math.min(drag.start.y, p.y)), w: 0, h: 0 };
        sel.w = Math.min(base.width - sel.x, Math.abs(p.x - drag.start.x));
        sel.h = Math.min(base.height - sel.y, Math.abs(p.y - drag.start.y));
        draw();
      } else if (tool === 'pen') {
        const ctx = base.getContext('2d');
        ctx.strokeStyle = color; ctx.lineWidth = size * (base.width / 900); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.beginPath(); ctx.moveTo(drag.last.x, drag.last.y); ctx.lineTo(p.x, p.y); ctx.stroke();
        drag.last = p; draw();
      } else if (tool === 'blur') {
        pixelate(base.getContext('2d'), p.x, p.y, size * 5); drag.last = p; draw();
      }
    });
    const end = () => { drag = null; };
    over.addEventListener('pointerup', end);
    over.addEventListener('pointercancel', end);

    const filterBtn = (label, fn) => h('button', { class: 'chip', type: 'button', onclick: () => { snapshot(); fn(base); draw(); } }, label);
    const drawTools = () => {
      clear(tools).append(...[
        ['crop', 'grid', t('pe.crop')], ['pen', 'edit', t('pe.pen')], ['blur', 'block', t('pe.blur')], ['text', 'chat', t('pe.text')],
      ].map(([id, ico, label]) => h('button', { class: `pe-tool${tool === id ? ' on' : ''}`, type: 'button', 'aria-pressed': String(tool === id), onclick: () => { tool = id; sel = tool === 'crop' ? sel : null; drawTools(); draw(); } }, icon(ico, 20), h('span', null, label))),
      h('button', { class: 'pe-tool', type: 'button', onclick: () => rotate(-1) }, icon('back', 20), h('span', null, t('pe.rotate_left'))),
      h('button', { class: 'pe-tool', type: 'button', onclick: () => rotate(1) }, icon('chevron', 20), h('span', null, t('pe.rotate_right'))),
      h('button', { class: 'pe-tool', type: 'button', onclick: () => { const s = undo.pop(); if (s) { base.width = s.width; base.height = s.height; base.getContext('2d').putImageData(s, 0, 0); sel = null; draw(); } } }, icon('trash', 20), h('span', null, t('pe.undo'))));
      clear(opts).append(...[
        tool === 'crop' ? h('button', { class: 'btn small', type: 'button', onclick: applyCrop }, t('pe.apply_crop')) : null,
        ...(tool === 'pen' || tool === 'text' ? COLORS.map((c) => h('button', { class: `pe-color${c === color ? ' on' : ''}`, type: 'button', 'aria-label': c, onclick: () => { color = c; drawTools(); } }, h('i', { style: { background: c } }))) : []),
        tool !== 'crop' ? h('input', { type: 'range', min: '2', max: '24', value: String(size), 'aria-label': t('pe.size'), oninput: (e) => { size = Number(e.target.value); } }) : null,
        ...(doc ? [filterBtn(t('pe.paper'), paperFilter), filterBtn(t('pe.bright'), brightenFilter)] : []),
      ].filter(Boolean));
    };

    const finish = (value) => { if (done) return; done = true; m.close(); resolve(value); };
    const m = modal({
      title: title || t('pe.title'), className: 'pe', onClose: () => { if (!done) { done = true; resolve(null); } },
      body: [stage, tools, opts,
        h('div', { class: 'pe-actions' },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => finish(null) }, t('common.cancel')),
          h('button', { class: 'btn', type: 'button', onclick: () => {
            if (tool === 'crop' && sel && sel.w > 8 && sel.h > 8) applyCrop();
            base.toBlob((blob) => {
              if (!blob) { finish(null); return; }
              const name = `${(file.name || 'photo').replace(/\.[^.]+$/, '')}.jpg`;
              finish(new File([blob], name, { type: 'image/jpeg' }));
            }, 'image/jpeg', 0.92);
          } }, t('pe.done')))],
    });
    drawTools();
    draw();
    void kOf;
  });
}

/** Scanner: photograph pages (or pick pictures), tidy each one, get one PDF. Resolves with a File or null. */
export async function scanDocument() {
  const pages = [];
  return new Promise((resolve) => {
    let finished = false;
    const input = h('input', { type: 'file', accept: 'image/*', capture: 'environment', class: 'sr', tabIndex: -1 });
    const list = h('div', { class: 'sc-pages' });
    const redraw = () => {
      clear(list).append(...pages.map((p, i) => h('div', { class: 'sc-page' },
        h('img', { src: p.url, alt: `${i + 1}` }),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.delete'), onclick: () => { URL.revokeObjectURL(p.url); pages.splice(i, 1); redraw(); } }, icon('trash', 18)))));
      make.disabled = !pages.length;
      make.textContent = `${t('sc.make')}${pages.length ? ` (${pages.length})` : ''}`;
    };
    const add = h('button', { class: 'btn', type: 'button', onclick: () => input.click() }, t('sc.add'));
    const make = h('button', { class: 'btn', type: 'button', disabled: true, onclick: async () => {
      make.disabled = true;
      make.textContent = t('sc.building');
      const jpegs = [];
      for (const p of pages) jpegs.push(new Uint8Array(await p.file.arrayBuffer()));
      const dims = [];
      for (const p of pages) { const img = new Image(); img.src = p.url; await img.decode(); dims.push([img.naturalWidth, img.naturalHeight]); }
      const pdf = jpegPdf(jpegs, dims);
      const d = new Date();
      const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      finished = true;
      win.close();
      resolve(new File([pdf], `${t('sc.name')} ${stamp}.pdf`, { type: 'application/pdf' }));
    } }, t('sc.make'));
    input.onchange = async () => {
      for (const f of [...input.files]) {
        const edited = await editImage(f, { doc: true, title: t('sc.page', { n: pages.length + 1 }) });
        if (edited) pages.push({ file: edited, url: URL.createObjectURL(edited) });
      }
      input.value = '';
      redraw();
    };
    const win = modal({ title: t('sc.title'), onClose: () => { pages.forEach((p) => URL.revokeObjectURL(p.url)); if (!finished) resolve(null); }, body: [h('p', { class: 'muted' }, t('sc.hint')), list, h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, add, make), input] });
    redraw();
    setTimeout(() => input.click(), 100);
  });
}
