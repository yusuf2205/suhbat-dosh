// Microphone and camera in the apps. In the Android app the system permission is asked for explicitly (and the person is told where to
// switch it on if it was refused for good); everywhere else the browser asks by itself. A failure names its reason.
import { t } from './i18n.js';

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
