// Microphone and camera in the apps. In the Android app the system permission is asked for explicitly (and the person is told where to
// switch it on if it was refused for good); everywhere else the browser asks by itself. A failure names its reason, and a check
// that goes through every step (and can be copied) shows where exactly a recording breaks on a given device.
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { modal, toast } from './ui.js';

/** Resolves true when recording may start (or when this is not the Android app). */
export function ensureMediaPermission(video = false) {
  const n = window.SuhbatNative;
  if (!n?.requestMedia) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(true), 45000);
    window.__mediaPerm = (ok) => { clearTimeout(timer); resolve(!!ok); };
    try { n.requestMedia(!!video); } catch { clearTimeout(timer); resolve(true); }
  });
}

/** The text for a failed getUserMedia: what to do, and the technical reason in brackets. */
export function mediaErrorText(e, fallbackKey = 'voice.denied') {
  const name = e?.name || 'Error';
  const base = name === 'NotFoundError' ? t('media.none_found') : name === 'NotReadableError' ? t('media.busy') : t(fallbackKey);
  const hint = name === 'NotAllowedError' || name === 'SecurityError' ? ` ${t('media.allow_hint')}` : '';
  return `${base}${hint} (${name})`;
}

/** Android: open the app's own settings page (Permissions) after a permanent refusal. */
export function openAppSettings() {
  try { window.SuhbatNative?.openAppSettings?.(); } catch { /* not the Android app */ }
}

const short = (e) => `${e?.name || 'Error'}${e?.message ? `: ${String(e.message).slice(0, 120)}` : ''}`;

/** Every step of recording, one line each: "OK ..." or "FAIL ...". */
export async function mediaReport({ camera = true } = {}) {
  const out = [];
  const step = async (label, fn) => {
    try { const v = await fn(); out.push(`OK    ${label}${v ? `: ${v}` : ''}`); return true; } catch (e) { out.push(`FAIL  ${label}: ${short(e)}`); return false; }
  };
  out.push(`App: ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, '').slice(0, 160)}`);
  out.push(`Screen: ${innerWidth}x${innerHeight} @${devicePixelRatio}`);
  await step('secure context', () => { if (!window.isSecureContext) throw new Error('page is not secure (https needed)'); return location.origin; });
  await step('native bridge', () => { if (!window.SuhbatNative?.requestMedia) throw new Error('not the Android app (or an old one)'); return 'present'; });
  if (window.SuhbatNative?.requestMedia) await step('system permission (microphone)', async () => { if (!(await ensureMediaPermission(false))) throw new Error('refused'); return 'granted'; });
  await step('mediaDevices', () => { if (!navigator.mediaDevices?.getUserMedia) throw new Error('missing'); return 'present'; });
  await step('MediaRecorder', () => {
    if (!window.MediaRecorder) throw new Error('missing');
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'video/webm', 'video/mp4'].filter((m) => MediaRecorder.isTypeSupported(m));
    if (!types.length) throw new Error('no format');
    return types.join(', ');
  });
  for (const k of ['microphone', 'camera']) {
    await step(`permission state (${k})`, async () => (await navigator.permissions.query({ name: k })).state);
  }
  await step('devices', async () => {
    const d = await navigator.mediaDevices.enumerateDevices();
    return `microphones ${d.filter((x) => x.kind === 'audioinput').length}, cameras ${d.filter((x) => x.kind === 'videoinput').length}`;
  });
  let stream = null;
  if (await step('microphone opens', async () => {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tr = stream.getAudioTracks()[0];
    return `${tr?.label || 'no name'}, ${tr?.readyState}`;
  })) {
    await step('a one-second recording has sound data', async () => {
      const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m));
      const mr = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      const parts = [];
      mr.ondataavailable = (e) => parts.push(e.data);
      const stopped = new Promise((r) => { mr.onstop = r; });
      mr.start(250);
      await new Promise((r) => setTimeout(r, 1100));
      mr.stop();
      await stopped;
      const size = parts.reduce((a, b) => a + b.size, 0);
      if (size < 500) throw new Error(`only ${size} bytes`);
      return `${size} bytes (${mr.mimeType})`;
    });
    stream.getTracks().forEach((x) => x.stop());
  }
  if (camera) {
    if (window.SuhbatNative?.requestMedia) await step('system permission (camera)', async () => { if (!(await ensureMediaPermission(true))) throw new Error('refused'); return 'granted'; });
    await step('camera opens', async () => {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 480 }, height: { ideal: 480 } } });
      const tr = s.getVideoTracks()[0];
      const st = tr?.getSettings?.() || {};
      s.getTracks().forEach((x) => x.stop());
      return `${tr?.label || 'no name'} ${st.width || '?'}x${st.height || '?'}`;
    });
  }
  return out.join('\n');
}

/** The window of the check; `problem` (an error or a text) is shown on top when it was opened because a recording failed. */
export function openMediaCheck(problem = null) {
  const report = h('pre', { class: 'mc-report' }, t('mc.running'));
  const copy = h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
    const text = `${problem ? `${typeof problem === 'string' ? problem : short(problem)}\n` : ''}${report.textContent}`;
    try { await navigator.clipboard.writeText(text); toast(t('mc.copied')); } catch { /* the text can be selected by hand */ }
  } }, t('mc.copy'));
  const rerun = h('button', { class: 'btn', type: 'button', onclick: () => run() }, t('mc.run'));
  const m = modal({
    title: problem ? t('mc.failed') : t('mc.title'), className: 'mc',
    body: [
      problem ? h('p', { class: 'err' }, typeof problem === 'string' ? problem : short(problem)) : h('p', { class: 'muted' }, t('mc.hint')),
      report,
      h('div', { class: 'row' }, rerun, copy, window.SuhbatNative?.openAppSettings ? h('button', { class: 'btn secondary', type: 'button', onclick: openAppSettings }, t('mc.settings')) : null),
    ],
  });
  async function run() {
    rerun.disabled = true;
    clear(report).append(t('mc.running'));
    try { report.textContent = await mediaReport(); } catch (e) { report.textContent = short(e); }
    rerun.disabled = false;
  }
  run();
  return m;
}

/** A recording failed: a short message, and the full check opens so the reason can be read (and sent) at once. */
export function showMediaProblem(e, fallbackKey = 'voice.denied') {
  toast(mediaErrorText(e, fallbackKey), 6000);
  openMediaCheck(e);
}
