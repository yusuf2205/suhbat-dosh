// Screenshot protection. In the Android app the window is marked secure (no screenshots, no screen recording, a blank preview in
// the app switcher); in the Windows/Linux app the window is excluded from screen capture. A browser cannot forbid screenshots, so
// there the page is only hidden when the window loses focus. It turns on by itself for secret chats and one-time photos.
import { S, on } from './state.js';

let applied = null;
let native = false;

function secretOpen() {
  const c = S.active ? S.chats.get(S.active) : null;
  return !!(c && c.secret);
}
const wanted = () => !!(S.prefs.noShot || secretOpen() || document.querySelector('.once-view'));

function apply(onNow) {
  if (onNow === applied) return;
  applied = onNow;
  native = false;
  try { if (window.SuhbatNative?.setSecure) { window.SuhbatNative.setSecure(onNow); native = true; } } catch { /* not the Android app */ }
  try { if (window.suhbatShell?.protect) { window.suhbatShell.protect(onNow); native = true; } } catch { /* not the desktop app */ }
  document.documentElement.classList.toggle('shot-guard', onNow);
  document.documentElement.classList.toggle('shot-soft', onNow && !native);
}

export const screenGuardNative = () => !!(window.SuhbatNative?.setSecure || window.suhbatShell?.protect);

let started = false;
export function startScreenGuard() {
  if (started) { apply(wanted()); return; }
  started = true;
  const check = () => apply(wanted());
  on('active', check);
  on('chats', check);
  on('shotguard', check);
  setInterval(check, 1500);
  // in a browser: hide the page when it is not the focused window, and empty the clipboard after Print Screen
  const hide = (v) => { if (document.documentElement.classList.contains('shot-soft')) document.documentElement.classList.toggle('shot-hidden', v); };
  window.addEventListener('blur', () => hide(true));
  window.addEventListener('focus', () => hide(false));
  document.addEventListener('visibilitychange', () => hide(document.visibilityState !== 'visible'));
  document.addEventListener('keyup', (e) => {
    if (e.key === 'PrintScreen' && document.documentElement.classList.contains('shot-guard')) navigator.clipboard?.writeText('').catch(() => {});
  });
  check();
}
