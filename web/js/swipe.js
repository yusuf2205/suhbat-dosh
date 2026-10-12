// Touch gestures: swipe from the left edge = back; swipe a message / chat to the left = reply / actions.
import { goBack, hasLayers } from './backnav.js';

let lastSwipe = 0;
/** True right after a swipe was committed: lets click handlers ignore the click that follows. */
export const justSwiped = () => Date.now() - lastSwipe < 400;

export function swipeLeft(el, { max = 90, threshold = 64, onMove = null, onCommit = null, canStart = null } = {}) {
  let sx = 0;
  let sy = 0;
  let dx = 0;
  let active = false;
  let decided = false;
  let id = null;
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || (canStart && !canStart(e))) return;
    sx = e.clientX;
    sy = e.clientY;
    dx = 0;
    active = true;
    decided = false;
    id = e.pointerId;
  });
  el.addEventListener('pointermove', (e) => {
    if (!active || e.pointerId !== id) return;
    const mx = e.clientX - sx;
    const my = e.clientY - sy;
    if (!decided) {
      if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
      decided = true;
      if (Math.abs(my) > Math.abs(mx) || mx > 0) { active = false; return; }
      try { el.setPointerCapture(id); } catch { /* ignore */ }
    }
    dx = Math.max(-max, mx);
    onMove?.(dx, false);
  });
  const end = () => {
    if (!active) return;
    active = false;
    const fire = dx <= -threshold;
    onMove?.(0, true);
    if (fire) {
      lastSwipe = Date.now();
      onCommit?.();
    }
    dx = 0;
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/** Back by swiping right from the left screen edge. */
export function initEdgeSwipe() {
  let sx = 0;
  let sy = 0;
  let on = false;
  const hint = document.createElement('div');
  hint.className = 'edge-hint';
  hint.hidden = true;
  document.body.append(hint);
  window.addEventListener('touchstart', (e) => {
    const t0 = e.touches[0];
    on = e.touches.length === 1 && t0.clientX <= 24 && hasLayers();
    sx = t0.clientX;
    sy = t0.clientY;
  }, { passive: true });
  window.addEventListener('touchmove', (e) => {
    if (!on) return;
    const t0 = e.touches[0];
    const dx = t0.clientX - sx;
    const dy = Math.abs(t0.clientY - sy);
    if (dy > dx && dx < 30) { on = false; hint.hidden = true; return; }
    hint.hidden = dx < 12;
    hint.style.transform = `translateX(${Math.min(dx, 90) - 90}px)`;
    hint.style.opacity = String(Math.min(1, dx / 90));
  }, { passive: true });
  window.addEventListener('touchend', (e) => {
    if (!on) return;
    on = false;
    hint.hidden = true;
    const dx = (e.changedTouches[0]?.clientX ?? 0) - sx;
    if (dx > 90) goBack();
  }, { passive: true });
}
