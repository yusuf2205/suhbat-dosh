// Connecting two devices on purpose. With internet: a 5-digit code or a small QR code, the server only introduces them.
// With no server at all they show each other a QR code holding the connection data itself. That does not fit into a few digits, but it is
// all two iPhones need: one Wi-Fi, or the hotspot of one of the phones.
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { S } from './state.js';
import { modal, toast } from './ui.js';
import { qrCanvas } from './qr.js';
import jsQR from './vendor/jsqr.js';
import { pairAnswer, pairClaim, pairCode, pairCreate, waitPaired } from './lan.js';

const codeOfLink = (text) => /[?&]pair=(\d{5})\b/.exec(String(text))?.[1] || (/^\d{5}$/.test(String(text).trim()) ? String(text).trim() : null);
export const pairLinkCode = codeOfLink;

/** Looks through the camera until something useful is seen. */
function cameraReader(onText) {
  const video = h('video', { class: 'scan-video', playsInline: true, muted: true, autoplay: true });
  video.muted = true;
  let alive = true;
  let stream = null;
  const stop = () => { alive = false; stream?.getTracks().forEach((x) => x.stop()); };
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
        if (r?.data && onText(r.data)) { stop(); return; }
      }
      setTimeout(tick, 200);
    };
    tick();
  })();
  return { el: video, stop };
}

/** The long connection data of the no-server way: only for a device with no camera, and out of the way. */
function longCodeBox(code) {
  const copy = () => navigator.clipboard?.writeText(code).then(() => toast(t('nb.pair_copied'))).catch(() => {});
  return h('details', { class: 'nb-pair-more' }, h('summary', null, t('nb.pair_no_camera')),
    h('p', { class: 'muted' }, t('nb.pair_long_why')),
    h('button', { class: 'btn small secondary', type: 'button', onclick: copy }, t('nb.pair_copy')),
    h('textarea', { class: 'input nb-pair-code', rows: 2, readOnly: true, value: code, 'aria-label': t('nb.pair_copy') }));
}

function pasteBox(onText) {
  const paste = h('textarea', { class: 'input', rows: 2, placeholder: t('nb.pair_paste'), 'aria-label': t('nb.pair_paste'), spellcheck: false });
  paste.addEventListener('input', () => { if (paste.value.trim() && !onText(paste.value)) toast(t('nb.pair_bad')); });
  return h('details', { class: 'nb-pair-more' }, h('summary', null, t('nb.pair_no_camera')), paste);
}

export function openPairing() {
  const body = h('div', { class: 'nb' });
  let reader = null;
  let finished = false;
  let stopWatch = null;
  const cleanup = () => { finished = true; reader?.stop(); stopWatch?.(); };
  const m = modal({ title: t('nb.pair_title'), className: 'drive', body: [body], onClose: cleanup });
  const failed = () => { if (!finished) { toast(t('nb.pair_failed'), 6000); drawStart(); } };
  const connected = () => { if (!finished) { cleanup(); m.close(); toast(t('nb.connected')); } };
  const progress = (key) => clear(body).append(h('p', { class: 'nb-status' }, h('span', { class: 'tr-spin' }), t(key)));
  const online = () => S.net === 'online';

  async function claim(code) {
    progress('nb.connecting_direct');
    reader?.stop();
    try { await pairClaim(code); connected(); } catch (e) {
      if (finished) return;
      toast(t(e.message === 'bad' ? 'nb.pair_wrong' : 'nb.pair_failed'), 6000);
      drawStart();
    }
  }

  function drawStart() {
    reader?.stop();
    stopWatch?.();
    if (online()) drawShort();
    else drawOffline();
  }

  // ---- with internet: one screen for both devices
  async function drawShort() {
    progress('nb.pair_preparing');
    let code;
    try { code = await pairCode(); } catch { drawOffline(); return; }
    if (finished) return;
    stopWatch = waitPaired(connected);
    const cells = h('input', { class: 'input nb-digits', inputMode: 'numeric', autocomplete: 'off', maxLength: 5, placeholder: '00000', 'aria-label': t('nb.pair_enter') });
    cells.addEventListener('input', () => {
      cells.value = cells.value.replace(/\D/g, '').slice(0, 5);
      if (cells.value.length === 5) claim(cells.value);
    });
    const shown = `${code.slice(0, 2)} ${code.slice(2)}`;
    clear(body).append(
      h('div', { class: 'nb-step' },
        qrCanvas(`${location.origin}/?pair=${code}`, 240),
        h('div', { class: 'nb-digits-show', 'aria-label': code }, shown),
        h('small', { class: 'muted' }, t('nb.pair_short_hint'))),
      h('b', null, t('nb.pair_enter')),
      cells,
      h('button', { class: 'btn secondary', type: 'button', onclick: () => {
        reader?.stop();
        reader = cameraReader((text) => { const c = codeOfLink(text); if (!c) return false; claim(c); return true; });
        scanBox.replaceChildren(reader.el);
      } }, t('nb.pair_scan')),
      (scanBox = h('div', { class: 'nb-pair-read' })),
      h('button', { class: 'btn link', type: 'button', onclick: () => { stopWatch?.(); drawOffline(); } }, t('nb.pair_no_internet')));
  }
  let scanBox = null;

  // ---- no server: the connection data itself, by QR
  function drawOffline() {
    reader?.stop();
    clear(body).append(
      h('p', { class: 'muted' }, t('nb.pair_intro')),
      h('button', { class: 'btn', type: 'button', onclick: drawShow }, t('nb.pair_show')),
      h('button', { class: 'btn secondary', type: 'button', onclick: drawRead }, t('nb.pair_scan')));
  }

  /** First device: its code, then the answer of the other one. */
  async function drawShow() {
    progress('nb.pair_preparing');
    try {
      const { code, finish, ready } = await pairCreate();
      ready.then(connected, failed);
      const onAnswer = (text) => {
        const s = String(text).trim();
        if (!s.startsWith('SDP')) return false;
        reader?.stop();
        progress('nb.connecting_direct');
        finish(s).catch(failed);
        return true;
      };
      reader = cameraReader(onAnswer);
      clear(body).append(h('b', null, t('nb.pair_step1')), h('div', { class: 'nb-step' }, qrCanvas(code, 320)), longCodeBox(code),
        h('b', null, t('nb.pair_step2')), h('div', { class: 'nb-pair-read' }, reader.el), pasteBox(onAnswer));
    } catch { failed(); }
  }

  /** Second device: reads the code, shows its answer. */
  function drawRead() {
    const onOffer = (text) => {
      const s = String(text).trim();
      if (!s.startsWith('SDP')) return false;
      reader?.stop();
      progress('nb.pair_preparing');
      pairAnswer(s).then(({ code, ready }) => {
        ready.then(connected, failed);
        clear(body).append(h('b', null, t('nb.pair_step3')), h('div', { class: 'nb-step' }, qrCanvas(code, 320)), longCodeBox(code),
          h('p', { class: 'nb-status' }, h('span', { class: 'tr-spin' }), t('nb.connecting_direct')));
      }).catch(failed);
      return true;
    };
    reader = cameraReader(onOffer);
    clear(body).append(h('b', null, t('nb.pair_scan_hint')), h('div', { class: 'nb-pair-read' }, reader.el), pasteBox(onOffer));
  }
  drawStart();
}

/** A code that came from outside this window: the scanner, or a link opened by the phone's own camera. */
export async function claimPairCode(code) {
  try {
    await pairClaim(code);
    toast(t('nb.connected'));
    const { openNearby } = await import('./nearby.js');
    openNearby();
  } catch (e) {
    toast(t(e.message === 'bad' ? 'nb.pair_wrong' : 'nb.pair_failed'), 6000);
  }
}
