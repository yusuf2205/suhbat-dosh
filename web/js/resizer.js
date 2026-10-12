import { h } from './dom.js';
import { t } from './i18n.js';
import { S } from './state.js';

// Draggable divider between the chat list and the conversation. Width is remembered per device.
const KEY = 'suhbat.sidebarW';
const MIN = 260;
const MIN_MAIN = 420;

function stored() {
  try { return Number(localStorage.getItem(KEY)) || 0; } catch { return 0; }
}
function store(w) {
  try { if (w) localStorage.setItem(KEY, String(w)); else localStorage.removeItem(KEY); } catch { /* private mode */ }
}

export function mountResizer(appEl, sidebarEl) {
  const handle = h('div', {
    class: 'resizer', role: 'separator', 'aria-orientation': 'vertical', tabIndex: 0,
    'aria-label': t('resize.label'), title: t('resize.hint'),
  });
  sidebarEl.append(handle);

  const railW = () => appEl.querySelector('.rail')?.getBoundingClientRect().width || 0;
  const infoW = () => (appEl.dataset.info === 'open' && matchMedia('(min-width: 1280px)').matches ? 340 : 0);
  const clamp = (w) => Math.round(Math.max(MIN, Math.min(w, 640, window.innerWidth - railW() - MIN_MAIN - infoW())));

  function apply(w, persist = true) {
    if (!w) {
      appEl.style.removeProperty('--sidebar-w');
      handle.removeAttribute('aria-valuenow');
      if (persist) store(0);
      return;
    }
    const c = clamp(w);
    appEl.style.setProperty('--sidebar-w', `${c}px`);
    handle.setAttribute('aria-valuenow', String(c));
    if (persist) store(c);
  }

  const saved = stored();
  if (saved) apply(saved, false);

  const current = () => Math.round(sidebarEl.getBoundingClientRect().width);

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing');
    const left = sidebarEl.getBoundingClientRect().left;
    const move = (ev) => apply(ev.clientX - left, false);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing');
      store(current());
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });

  handle.addEventListener('dblclick', () => apply(0));
  handle.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') { e.preventDefault(); apply(current() - step); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); apply(current() + step); }
    else if (e.key === 'Home' || e.key === 'Escape') { e.preventDefault(); apply(0); }
  });

  // keep the layout valid when the window shrinks
  window.addEventListener('resize', () => {
    const s = stored();
    if (s) apply(s, false);
  });
  void S;
}
