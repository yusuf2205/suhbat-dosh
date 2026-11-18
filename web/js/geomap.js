// The map picture of a shared place, like the card of Telegram: the map around the point with a pin on it.
// The tiles come from this site (/api/map/tile), which asks the map service once and keeps them.
import { h } from './dom.js';

const TILE = 256;
const ZOOM = 16;

/** A map card for a point; a tap opens the place in a map application. `badge` is a small text over the map (live position, time). */
export function mapCard(lat, lng, { badge = '', onOpen = null, height = 180 } = {}) {
  const n = 2 ** ZOOM;
  const x = ((lng + 180) / 360) * n;
  const rad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n;
  const cx = Math.floor(x);
  const cy = Math.floor(y);
  const tiles = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) {
      const tx = cx + dx;
      const ty = cy + dy;
      if (ty < 0 || ty >= n) continue;
      const img = h('img', {
        class: 'gmap-t', alt: '', loading: 'lazy', decoding: 'async',
        src: `/api/map/tile/${ZOOM}/${((tx % n) + n) % n}/${ty}.png`,
        style: { left: `${Math.round((tx - x) * TILE)}px`, top: `${Math.round((ty - y) * TILE)}px` },
      });
      img.draggable = false;
      img.addEventListener('error', () => { img.style.visibility = 'hidden'; });
      tiles.push(img);
    }
  }
  const pin = h('span', { class: 'gmap-pin', 'aria-hidden': 'true' });
  pin.innerHTML = '<svg viewBox="0 0 24 34" width="30" height="42"><path d="M12 0C5.4 0 0 5.2 0 11.7 0 20.2 12 34 12 34s12-13.8 12-22.3C24 5.2 18.6 0 12 0z" fill="#e5484d" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="11.5" r="4.6" fill="#fff"/></svg>';
  const card = h('button', {
    class: 'gmap', type: 'button', title: 'Открыть на карте', 'aria-label': 'Геопозиция на карте',
    style: { height: `${height}px` }, onclick: onOpen || undefined,
  }, h('span', { class: 'gmap-in' }, ...tiles), pin, badge ? h('span', { class: 'gmap-badge' }, badge) : null,
  h('span', { class: 'gmap-attr' }, '© OpenStreetMap'));
  return card;
}
