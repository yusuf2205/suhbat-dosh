// QR scanner: reads a profile code with the camera and opens the chat with that person.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';
import jsQR from './vendor/jsqr.js';
import { qrTokenFrom, approveQrLogin } from './qrlogin.js';

export async function openChatWithUsername(username) {
  const name = String(username || '').replace(/^@/, '');
  if (!/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(name)) throw new Error('bad');
  const found = (await api('GET', `/api/users/search?q=${encodeURIComponent(name)}`)).users.find((x) => (x.username || '').toLowerCase() === name.toLowerCase());
  if (!found) throw new Error('nf');
  if (found.id === S.me.id) return;
  const c = (await api('POST', '/api/chats/direct', { user_id: found.id })).chat;
  S.chats.set(c.id, c);
  fire('chats');
  fire('open-chat', c.id);
}

function usernameFrom(text) {
  try {
    const u = new URL(text);
    return u.searchParams.get('u');
  } catch {
    return /^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(text) ? text : null;
  }
}

export function openScanner() {
  if (!navigator.mediaDevices?.getUserMedia) { toast(t('call.insecure'), 5000); return; }
  const video = h('video', { class: 'scan-video', playsInline: true, muted: true, autoplay: true });
  video.muted = true;
  const hint = h('p', { class: 'muted', style: { textAlign: 'center' } }, t('scan.hint'));
  let stream = null;
  let alive = true;
  const m = modal({ title: t('scan.title'), className: 'scan-modal', body: [h('div', { class: 'scan-frame' }, video, h('i', { class: 'scan-corners' })), hint], onClose: () => { alive = false; stream?.getTracks().forEach((x) => x.stop()); } });

  (async () => {
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }, audio: false });
    } catch { hint.textContent = t('call.cam_denied'); return; }
    if (!alive) { stream.getTracks().forEach((x) => x.stop()); return; }
    video.srcObject = stream;
    await video.play().catch(() => {});
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const detector = 'BarcodeDetector' in window ? new window.BarcodeDetector({ formats: ['qr_code'] }) : null;
    const tick = async () => {
      if (!alive) return;
      try {
        if (video.videoWidth) {
          let text = null;
          if (detector) {
            const r = await detector.detect(video).catch(() => []);
            text = r[0]?.rawValue || null;
          }
          if (!text) {
            const w = 480;
            const hh = Math.round((video.videoHeight / video.videoWidth) * w);
            canvas.width = w;
            canvas.height = hh;
            ctx.drawImage(video, 0, 0, w, hh);
            const img = ctx.getImageData(0, 0, w, hh);
            text = jsQR(img.data, w, hh, { inversionAttempts: 'dontInvert' })?.data || null;
          }
          const loginToken = text && qrTokenFrom(text.trim());
          if (loginToken) { alive = false; m.close(); approveQrLogin(loginToken); return; }
          const name = text && usernameFrom(text.trim());
          if (name) {
            alive = false;
            m.close();
            try { await openChatWithUsername(name); } catch (e) { toast(e.message === 'nf' ? t('scan.not_found') : errText(e.code)); }
            return;
          }
        }
      } catch { /* try the next frame */ }
      setTimeout(tick, 160);
    };
    tick();
  })();
  return m;
}
