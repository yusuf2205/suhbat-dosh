// QR code of a link, drawn on a canvas (no inline styles: the CSP forbids them).
import qrcode from './vendor/qrcode.js';
import { h } from './dom.js';
import { t } from './i18n.js';
import { modal, toast } from './ui.js';

export function qrCanvas(text, px = 280) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  const quiet = 3;
  const cell = Math.max(2, Math.floor(px / (n + quiet * 2)));
  const size = cell * (n + quiet * 2);
  const cv = document.createElement('canvas');
  cv.width = size;
  cv.height = size;
  cv.className = 'qr-canvas';
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#111';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) ctx.fillRect((c + quiet) * cell, (r + quiet) * cell, cell, cell);
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
