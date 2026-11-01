// How fast audio and video play, everywhere: 0.5x to 2.5x. The choice is remembered and shared by all players on the device.
import { h } from './dom.js';

export const SPEEDS = [0.5, 1, 1.5, 2, 2.5];
const KEY = 'suhbat.speed';
const rows = new Set();

export function currentSpeed() {
  try {
    const v = Number(localStorage.getItem(KEY));
    return SPEEDS.includes(v) ? v : 1;
  } catch { return 1; }
}

export function setSpeed(v) {
  try { localStorage.setItem(KEY, String(v)); } catch { /* private mode: for this page only */ }
  for (const r of [...rows]) { if (r.isConnected) r.paint(v); else rows.delete(r); }
  document.querySelectorAll('audio, video').forEach((m) => { m.playbackRate = v; });
}

/** Buttons for one player. */
export function speedRow(media) {
  const buttons = SPEEDS.map((v) => h('button', { class: 'spd-btn', type: 'button', 'aria-label': `${v}x`, onclick: () => setSpeed(v) }, `${v}x`));
  const row = h('div', { class: 'spd', role: 'group', 'aria-label': 'Speed' }, buttons);
  row.paint = (cur) => buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(SPEEDS[i] === cur)));
  row.paint(currentSpeed());
  rows.add(row);
  // a browser sets the speed back to normal whenever a new file is loaded
  const apply = () => { media.playbackRate = currentSpeed(); };
  media.addEventListener('loadedmetadata', apply);
  media.addEventListener('play', apply);
  apply();
  return row;
}
