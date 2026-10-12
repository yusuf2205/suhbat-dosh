// "Back" like in Telegram: the phone's back button / the back swipe closes the topmost thing (menu, dialog, viewer,
// settings page, chat) instead of leaving the app. One sentinel history entry stands in for all open layers.
const layers = [];
let sentinel = false;
let ignore = 0;
let cleanup = null;

export const hasLayers = () => layers.length > 0;

/** Something closable was opened. `onBack()` must close it. Returns a handle for closeLayer(). */
export function openLayer(onBack) {
  const layer = { onBack };
  layers.push(layer);
  clearTimeout(cleanup);
  cleanup = null;
  if (!sentinel) {
    try { history.pushState({ suhbat: 1 }, ''); sentinel = true; } catch { /* history unavailable */ }
  }
  return layer;
}

/** The UI closed it by itself (✕, Esc, button): forget the layer. Safe to call twice. */
function scheduleCleanup() {
  if (layers.length || !sentinel || cleanup) return;
  // remove the sentinel a moment later (a new layer may be opened right away, e.g. menu -> dialog)
  cleanup = setTimeout(() => {
    cleanup = null;
    if (!layers.length && sentinel) {
      ignore += 1;
      sentinel = false;
      history.back();
    }
  }, 80);
}

export function closeLayer(layer) {
  const i = layers.indexOf(layer);
  if (i < 0) return;
  layers.splice(i, 1);
  scheduleCleanup();
}

/**
 * The Android app asks this on the hardware back button (see MainActivity): true = something was closed here,
 * false = nothing is open, the app may go to the background.
 */
export function handleBack() {
  const top = layers.pop();
  if (!top) return false;
  try { top.onBack(); } catch (e) { console.error(e); }
  scheduleCleanup();
  return true;
}

window.addEventListener('popstate', () => {
  if (ignore > 0) { ignore -= 1; return; }
  if (!sentinel) return;
  sentinel = false;
  const top = layers.pop();
  try { top?.onBack(); } catch (e) { console.error(e); }
  if (layers.length) {
    try { history.pushState({ suhbat: 1 }, ''); sentinel = true; } catch { /* ignore */ }
  }
});

/** Same as pressing the phone's back button. */
export function goBack() {
  if (layers.length && sentinel) history.back();
}
