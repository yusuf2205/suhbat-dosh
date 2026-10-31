// Connecting two devices with no server at all: they show each other a QR code. Two iPhones, a laptop with no internet, a network whose
// provider gives the devices different addresses: all that is needed is one Wi-Fi (or the hotspot of one of the phones).
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { modal, toast } from './ui.js';
import { qrCanvas } from './qr.js';
import jsQR from './vendor/jsqr.js';
import { pairAnswer, pairCreate } from './lan.js';

/** Looks through the camera until a pairing code is seen; the code can also be pasted (a computer with no camera). */
function codeReader(onCode) {
  const video = h('video', { class: 'scan-video', playsInline: true, muted: true, autoplay: true });
  video.muted = true;
  const paste = h('textarea', { class: 'input', rows: 2, placeholder: t('nb.pair_paste'), 'aria-label': t('nb.pair_paste'), spellcheck: false });
  let alive = true;
  let stream = null;
  const stop = () => { alive = false; stream?.getTracks().forEach((x) => x.stop()); };
  const got = (text) => { const s = String(text || '').trim(); if (alive && s.startsWith('SDP')) { stop(); onCode(s); return true; } return false; };
  paste.addEventListener('input', () => { if (!got(paste.value) && paste.value.trim()) toast(t('nb.pair_bad')); });
  (async () => {
    if (!navigator.mediaDevices?.getUserMedia) { video.hidden = true; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch { video.hidden = true; return; }
    if (!alive) { stop(); return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const tick = () => {
      if (!alive) return;
      if (video.videoWidth) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        const r = jsQR(ctx.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height);
        if (r?.data) got(r.data);
      }
      setTimeout(tick, 200);
    };
    tick();
  })();
  return { el: h('div', { class: 'nb-pair-read' }, video, paste), stop };
}

function codeView(code) {
  const copy = () => navigator.clipboard?.writeText(code).then(() => toast(t('nb.pair_copied'))).catch(() => {});
  return h('div', { class: 'nb-step' },
    qrCanvas(code, 300, { logo: false, animate: false }),
    h('button', { class: 'btn small secondary', type: 'button', onclick: copy }, t('nb.pair_copy')),
    h('textarea', { class: 'input nb-pair-code', rows: 2, readOnly: true, value: code, 'aria-label': t('nb.pair_copy') }));
}

export function openPairing() {
  const body = h('div', { class: 'nb' });
  let reader = null;
  let finished = false;
  const m = modal({ title: t('nb.pair_title'), className: 'drive', body: [body], onClose: () => { finished = true; reader?.stop(); } });
  const failed = () => { if (!finished) { toast(t('nb.pair_failed'), 6000); drawStart(); } };
  const connected = () => { if (!finished) { finished = true; reader?.stop(); m.close(); toast(t('nb.connected')); } };

  function drawStart() {
    reader?.stop();
    clear(body).append(
      h('p', { class: 'muted' }, t('nb.pair_intro')),
      h('button', { class: 'btn', type: 'button', onclick: drawShow }, t('nb.pair_show')),
      h('button', { class: 'btn secondary', type: 'button', onclick: drawRead }, t('nb.pair_scan')));
  }

  /** First device: its code, then the answer of the other one. */
  async function drawShow() {
    clear(body).append(h('p', { class: 'nb-status' }, h('span', { class: 'tr-spin' }), t('nb.pair_preparing')));
    try {
      const { code, finish, ready } = await pairCreate();
      ready.then(connected, failed);
      reader = codeReader(async (answer) => {
        clear(body).append(h('p', { class: 'nb-status' }, h('span', { class: 'tr-spin' }), t('nb.connecting_direct')));
        try { await finish(answer); } catch { failed(); }
      });
      clear(body).append(h('b', null, t('nb.pair_step1')), codeView(code), h('b', null, t('nb.pair_step2')), reader.el);
    } catch { failed(); }
  }

  /** Second device: reads the code, shows its answer. */
  function drawRead() {
    reader = codeReader(async (offer) => {
      clear(body).append(h('p', { class: 'nb-status' }, h('span', { class: 'tr-spin' }), t('nb.pair_preparing')));
      try {
        const { code, ready } = await pairAnswer(offer);
        ready.then(connected, failed);
        clear(body).append(h('b', null, t('nb.pair_step3')), codeView(code), h('p', { class: 'nb-status' }, h('span', { class: 'tr-spin' }), t('nb.connecting_direct')));
      } catch { failed(); }
    });
    clear(body).append(h('b', null, t('nb.pair_scan_hint')), reader.el);
  }
  drawStart();
}
