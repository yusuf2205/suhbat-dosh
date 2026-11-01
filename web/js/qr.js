// QR code of a link, drawn on a canvas (no inline styles: the CSP forbids them).
import qrcode from './vendor/qrcode.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { modal, toast } from './ui.js';

/**
 * A QR code in our colours on a canvas: a golden frame with the name, rounded dots, yellow eyes, our emblem in the middle, a moving glint and a blinking logo.
 * It stays readable: what matters to a scanner is that the dots stay dark on a light ground, and the emblem covers well under 5% of the area
 * (a long text gets a smaller emblem, because it has a lower level of error correction and already has many dots).
 * { logo: false } draws a plain code, { animate: false } a still picture.
 */
export function qrCanvas(text, px = 280, { logo = true, animate = true } = {}) {
  const long = String(text).length > 240;
  const qr = qrcode(0, !logo || long ? 'M' : 'H');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const band = logo ? 0.085 : 0; // the golden frame, of the whole width
  const cell = Math.max(logo ? 4 : 3, Math.floor((px * dpr * (1 - band * 2)) / (n + quiet * 2)));
  const inner = cell * (n + quiet * 2);
  const pad = logo ? Math.round((inner * band) / (1 - band * 2)) : 0;
  const size = inner + pad * 2;
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  cv.className = logo ? 'qr-canvas qr-brand' : 'qr-canvas';
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'QR');
  const ctx = cv.getContext('2d');
  const isFinder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const plateR = logo ? inner * (long ? 0.055 : 0.115) : 0;
  const mid = size / 2;
  const hidden = (x, y) => logo && Math.hypot(x - mid, y - mid) < plateR * 1.12;
  const rr = (path, x, y, w, h2, r) => { if (path.roundRect) path.roundRect(x, y, w, h2, r); else path.rect(x, y, w, h2); };
  const px0 = (i) => pad + (i + quiet) * cell;

  // all dark dots in one path: the glint is just a moving gradient used as its fill
  const dark = new Path2D();
  const gap = cell * 0.05;
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (!qr.isDark(r, c) || isFinder(r, c)) continue;
      const x = px0(c);
      const y = px0(r);
      if (hidden(x + cell / 2, y + cell / 2)) continue;
      rr(dark, x + gap, y + gap, cell - gap * 2, cell - gap * 2, cell * 0.3); // round dots look nice but are read much worse
    }
  }
  const eyes = [[0, 0], [0, n - 7], [n - 7, 0]].map(([r0, c0]) => [px0(c0), px0(r0)]);

  const drawFrame = () => {
    if (!logo) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, size, size); return; }
    ctx.clearRect(0, 0, size, size);
    const g = ctx.createLinearGradient(0, 0, size, size);
    g.addColorStop(0, '#ffe44d'); g.addColorStop(0.55, '#fbc700'); g.addColorStop(1, '#f5a800');
    ctx.fillStyle = g;
    const outer = new Path2D();
    rr(outer, 0, 0, size, size, pad * 1.1);
    ctx.fill(outer);
    ctx.fillStyle = '#fff';
    const card = new Path2D();
    rr(card, pad, pad, inner, inner, pad * 0.55);
    ctx.fill(card);
    ctx.fillStyle = '#2b2b2e';
    ctx.font = `800 ${Math.round(pad * 0.56)}px system-ui, -apple-system, "Segoe UI", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Suhbat-dosh', mid, size - pad / 2);
  };

  const drawLogo = (t) => {
    if (!logo) return;
    const pulse = 1 + 0.035 * Math.sin(t / 650);
    const R = plateR * pulse;
    ctx.save();
    ctx.translate(mid, mid);
    ctx.fillStyle = '#fff';
    ctx.beginPath(); ctx.arc(0, 0, R * 1.12, 0, Math.PI * 2); ctx.fill();
    // the emblem, drawn from the same shapes as icon.svg (a 781 x 781 drawing)
    const k = (R * 2) / 781;
    ctx.scale(k, k);
    ctx.translate(-390.5, -390.5);
    const g = ctx.createLinearGradient(0, 0, 781, 781);
    g.addColorStop(0, '#ffdf0b'); g.addColorStop(1, '#fbc700');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.arc(390.5, 390.5, 390.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2b2b2e';
    const blink = (t % 4200) > 4000 ? 0.15 : 1; // the eyes blink every few seconds
    for (const [cx, cy, r] of [[288, 305, 45], [475, 291, 59]]) {
      ctx.save(); ctx.translate(cx, cy); ctx.scale(1, blink); ctx.beginPath(); ctx.arc(0, 0, r, 0, Math.PI * 2); ctx.fill(); ctx.restore();
    }
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(198, 392, 379, 145, 72.5) : ctx.rect(198, 392, 379, 145); ctx.fill();
    ctx.beginPath(); ctx.moveTo(272, 520); ctx.lineTo(272, 569); ctx.lineTo(336, 537); ctx.closePath(); ctx.fill();
    ctx.fillStyle = '#f7f9ff';
    for (const x of [289, 388, 488]) { ctx.beginPath(); ctx.arc(x, 465, 30, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  };

  const frame = (t) => {
    drawFrame();
    // a dark golden glint sweeps over the dots; it never gets lighter than a strong contrast to the white background
    const phase = animate ? ((t % 3600) / 3600) * 1.6 - 0.3 : -1;
    const grad = ctx.createLinearGradient(0, 0, size, size);
    const p = Math.min(1, Math.max(0, phase));
    grad.addColorStop(0, '#16161a');
    grad.addColorStop(Math.max(0, p - 0.14), '#16161a');
    grad.addColorStop(p, '#4a3700');
    grad.addColorStop(Math.min(1, p + 0.14), '#16161a');
    grad.addColorStop(1, '#16161a');
    ctx.fillStyle = grad;
    ctx.fill(dark);
    // the three eyes of the code: a dark ring, a light middle (yellow in our colours), a dark centre
    for (const [x, y] of eyes) {
      const ring = new Path2D();
      rr(ring, x, y, cell * 7, cell * 7, cell * 2);
      ctx.fillStyle = grad;
      ctx.fill(ring);
      const hole = new Path2D();
      rr(hole, x + cell, y + cell, cell * 5, cell * 5, cell * 1.3);
      ctx.fillStyle = logo ? '#ffdf0b' : '#fff';
      ctx.fill(hole);
      const centre = new Path2D();
      rr(centre, x + cell * 2, y + cell * 2, cell * 3, cell * 3, cell);
      ctx.fillStyle = grad;
      ctx.fill(centre);
    }
    drawLogo(t);
  };

  frame(0);
  const still = !animate || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (!still) {
    let seen = false;
    let last = 0;
    const born = performance.now();
    const loop = (t) => {
      if (cv.isConnected) seen = true;
      // stop when the code left the page (or was never put on it), and never run forever
      if ((seen && !cv.isConnected) || t - born > 15 * 60_000 || (!seen && t - born > 3000)) return;
      if (t - last > 33 && document.visibilityState === 'visible') { last = t; frame(t); }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  return cv;
}

/** A dialog with the QR code, the link, "copy" and (where the system has it) "share". */
export function showQr(title, link) {
  const share = navigator.share
    ? h('button', { class: 'btn', type: 'button', onclick: () => navigator.share({ title, url: link }).catch(() => {}) }, t('qr.share'))
    : null;
  modal({
    title,
    body: h('div', { class: 'qr-box' },
      qrCanvas(link),
      h('div', { class: 'invite' }, link),
      h('p', { class: 'muted' }, t('qr.hint')),
      h('div', { class: 'row qr-actions' },
        h('button', { class: 'btn secondary', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast(t('info.copied')); } catch { /* ignore */ } } }, t('info.copy')),
        share)),
  });
}
