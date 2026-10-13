// Motion level: "full" animations, or "lite" (no animations) for slow devices and for people who asked the system for less motion.
import { S, savePrefs } from './state.js';

export function motionLevel() {
  const p = S.prefs?.motion;
  if (p === 'lite' || p === 'full') return p;
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return 'lite';
  } catch { /* old browser */ }
  if ((navigator.hardwareConcurrency || 8) <= 2 || (navigator.deviceMemory || 8) <= 2) return 'lite';
  return 'full';
}

export function applyMotion() {
  document.documentElement.dataset.motion = motionLevel();
}

export function setLiteMotion(on) {
  S.prefs.motion = on ? 'lite' : 'auto';
  savePrefs();
  applyMotion();
}

applyMotion();
