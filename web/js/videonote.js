// Round video messages ("circles"): record up to a minute from the camera, preview, send. They travel as ordinary
// video files named circle.webm / circle.mp4 and are drawn as a circle in the chat.
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { toast } from './ui.js';
import { openLayer, closeLayer } from './backnav.js';

const MAX_S = 60;
export const isVideoNote = (m) => m?.kind === 'video' && /^circle\./i.test(m.file?.name || '');

function pickMime() {
  return ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/webm;codecs=vp9,opus', 'video/webm', 'video/mp4']
    .find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || '';
}

/** Opens the recorder. Resolves with { blob, ext, duration } or null when cancelled. */
export function recordVideoNote() {
  return new Promise((resolve) => {
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { toast(t('voice.unsupported')); resolve(null); return; }
    let stream = null;
    let mr = null;
    let chunks = [];
    let facing = 'user';
    let started = 0;
    let timer = 0;
    let result = null;
    let finished = false;

    const video = h('video', { class: 'vn-video', autoplay: true, playsInline: true, muted: true });
    const ring = h('div', { class: 'vn-ring' });
    const time = h('div', { class: 'vn-time' }, '0:00');
    const recBtn = h('button', { class: 'vn-rec', type: 'button', 'aria-label': t('vnote.record') });
    const flip = h('button', { class: 'vn-side', type: 'button', 'aria-label': t('call.switch_camera') }, icon('camera', 22));
    const cancel = h('button', { class: 'vn-side', type: 'button', 'aria-label': t('common.cancel') }, icon('close', 22));
    const send = h('button', { class: 'btn vn-send', type: 'button', hidden: true }, t('chat.send'));
    const again = h('button', { class: 'btn secondary', type: 'button', hidden: true }, t('vnote.again'));
    const hint = h('p', { class: 'vn-hint' }, t('vnote.hint'));
    const circle = h('div', { class: 'vn-circle' }, video, ring);
    const root = h('div', { class: 'vn-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('vnote.title') },
      h('div', { class: 'vn-box' }, h('h2', null, t('vnote.title')), circle, time, hint,
        h('div', { class: 'vn-actions' }, cancel, recBtn, flip), h('div', { class: 'vn-actions' }, again, send)));
    document.body.append(root);
    const layer = openLayer(() => end(null));

    const stopStream = () => { stream?.getTracks().forEach((tr) => tr.stop()); stream = null; };
    function end(value) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      try { if (mr && mr.state !== 'inactive') { mr.onstop = null; mr.stop(); } } catch { /* ignore */ }
      stopStream();
      root.remove();
      closeLayer(layer);
      resolve(value);
    }

    async function open() {
      stopStream();
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true },
          video: { facingMode: facing, width: { ideal: 480 }, height: { ideal: 480 }, frameRate: { ideal: 24 } },
        });
      } catch {
        toast(t('call.no_media'));
        end(null);
        return;
      }
      video.muted = true;
      video.srcObject = stream;
      video.play?.().catch(() => {});
    }

    const paintRing = (frac) => { ring.dataset.p = String(Math.round(frac * 100)); ring.style.setProperty('--p', `${frac * 360}deg`); };

    function start() {
      if (!stream) return;
      chunks = [];
      const mime = pickMime();
      mr = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 1_000_000, audioBitsPerSecond: 64_000 });
      mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      mr.onstop = () => {
        clearInterval(timer);
        const type = mr.mimeType || mime || 'video/webm';
        const blob = new Blob(chunks, { type });
        const duration = Math.max(1, Math.round((Date.now() - started) / 1000));
        if (blob.size < 2000 || duration < 1) { recBtn.classList.remove('on'); open(); return; }
        result = { blob, ext: /mp4/.test(type) ? 'mp4' : 'webm', duration };
        stopStream();
        video.srcObject = null;
        video.src = URL.createObjectURL(blob);
        video.muted = false;
        video.loop = true;
        video.play?.().catch(() => {});
        recBtn.hidden = flip.hidden = hint.hidden = true;
        send.hidden = again.hidden = false;
      };
      started = Date.now();
      mr.start(500);
      recBtn.classList.add('on');
      hint.textContent = t('vnote.tap_stop');
      timer = setInterval(() => {
        const s = (Date.now() - started) / 1000;
        time.textContent = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
        paintRing(Math.min(1, s / MAX_S));
        if (s >= MAX_S) mr.stop();
      }, 100);
    }

    recBtn.onclick = () => { if (mr && mr.state === 'recording') mr.stop(); else start(); };
    flip.onclick = async () => { if (mr?.state === 'recording') return; facing = facing === 'user' ? 'environment' : 'user'; await open(); };
    cancel.onclick = () => end(null);
    again.onclick = () => {
      result = null; mr = null; time.textContent = '0:00'; paintRing(0);
      video.removeAttribute('src'); video.loop = false;
      recBtn.hidden = flip.hidden = hint.hidden = false; recBtn.classList.remove('on');
      send.hidden = again.hidden = true; hint.textContent = t('vnote.hint');
      open();
    };
    send.onclick = () => end(result);
    open();
  });
}

/** A received circle: tap to play with sound, tap again to pause. */
export function videoNoteNode(m) {
  const f = m.file;
  const v = h('video', { class: 'vn-msg-video', src: f.url ? `${f.url}#t=0.1` : '', preload: 'metadata', playsInline: true, loop: false });
  const ring = h('div', { class: 'vn-ring' });
  const dur = h('span', { class: 'vn-dur' }, m.duration ? `${Math.floor(m.duration / 60)}:${String(m.duration % 60).padStart(2, '0')}` : '');
  const wrap = h('button', { class: 'vn-msg', type: 'button', 'aria-label': t('vnote.title') }, v, ring, dur);
  v.addEventListener('timeupdate', () => { if (v.duration) ring.style.setProperty('--p', `${(v.currentTime / v.duration) * 360}deg`); });
  v.addEventListener('ended', () => { wrap.classList.remove('playing'); v.currentTime = 0; ring.style.setProperty('--p', '0deg'); });
  v.addEventListener('pause', () => wrap.classList.remove('playing'));
  v.addEventListener('play', () => { wrap.classList.add('playing'); clear(dur); });
  wrap.onclick = () => {
    if (v.paused) {
      // only one circle plays at a time
      document.querySelectorAll('.vn-msg-video').forEach((o) => { if (o !== v) o.pause(); });
      v.play().catch(() => {});
    } else v.pause();
  };
  if (!f.url) wrap.disabled = true;
  return wrap;
}
