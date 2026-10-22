// A pointer and a pen over a shared screen: the person who watches the screen draws, and both sides see the strokes
// fade after a few seconds. Positions are fractions of the picture, so different window sizes agree.
import { h } from './dom.js';

const COLORS = ['#ff3b30', '#ffd23f', '#3ddc84', '#4aa8ff'];
const LIFE = 4000;

/** The part of the element that really shows the picture (the video is letterboxed inside its box). */
export function contentRect(video) {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return r;
  const k = Math.min(r.width / vw, r.height / vh);
  const w = vw * k;
  const hh = vh * k;
  return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - hh) / 2, width: w, height: hh };
}

/**
 * card: the call card (the canvas covers it); surface(): the <video> that shows the shared screen on this side, or null;
 * send(data): passes a message to the other side.
 */
export function createAnnotations({ card, surface, send }) {
  const canvas = h('canvas', { class: 'ann-canvas' });
  card.append(canvas);
  const ctx = canvas.getContext('2d');
  const strokes = new Map(); // key -> { pts, c, at }
  let laser = null;
  let mode = false;
  let raf = 0;
  let mine = null;
  let queue = [];
  let sendTimer = 0;
  let color = COLORS[0];

  const toPx = (x, y) => {
    const v = surface();
    const cr = card.getBoundingClientRect();
    if (!v) return [x * cr.width, y * cr.height];
    const r = contentRect(v);
    return [r.left - cr.left + x * r.width, r.top - cr.top + y * r.height];
  };
  const toNorm = (cx, cy) => {
    const v = surface();
    if (!v) return null;
    const r = contentRect(v);
    const x = (cx - r.left) / r.width;
    const y = (cy - r.top) / r.height;
    return x < 0 || x > 1 || y < 0 || y > 1 ? null : [Math.round(x * 10000) / 10000, Math.round(y * 10000) / 10000];
  };

  function size() {
    const r = card.getBoundingClientRect();
    const k = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(r.width * k) || canvas.height !== Math.round(r.height * k)) {
      canvas.width = Math.round(r.width * k);
      canvas.height = Math.round(r.height * k);
    }
    ctx.setTransform(k, 0, 0, k, 0, 0);
  }

  function paint() {
    raf = 0;
    size();
    const r = card.getBoundingClientRect();
    ctx.clearRect(0, 0, r.width, r.height);
    const t = Date.now();
    for (const [key, s] of strokes) {
      const age = t - s.at;
      if (age > LIFE) { strokes.delete(key); continue; }
      ctx.globalAlpha = age > LIFE - 1200 ? Math.max(0, (LIFE - age) / 1200) : 1;
      ctx.strokeStyle = s.c;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      s.pts.forEach(([x, y], i) => { const [px, py] = toPx(x, y); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
      if (s.pts.length === 1) { const [px, py] = toPx(...s.pts[0]); ctx.lineTo(px + 0.1, py); }
      ctx.stroke();
    }
    if (laser && t - laser.at < 1500) {
      ctx.globalAlpha = Math.max(0, 1 - (t - laser.at) / 1500);
      const [px, py] = toPx(laser.x, laser.y);
      ctx.fillStyle = laser.c;
      ctx.beginPath();
      ctx.arc(px, py, 9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (strokes.size || (laser && t - laser.at < 1500)) raf = requestAnimationFrame(paint);
  }
  const wake = () => { if (!raf) raf = requestAnimationFrame(paint); };

  function flush() {
    sendTimer = 0;
    if (!queue.length || !mine) return;
    send({ k: 'dr', i: mine.id, c: mine.c, p: queue });
    queue = [];
  }

  function onDown(e) {
    if (!mode) return;
    const p = toNorm(e.clientX, e.clientY);
    if (!p) return;
    e.preventDefault();
    canvas.setPointerCapture(e.pointerId);
    mine = { id: Math.random().toString(36).slice(2, 8), c: color };
    strokes.set(`me:${mine.id}`, { pts: [p], c: color, at: Date.now() });
    queue = [p];
    flush();
    wake();
  }
  function onMove(e) {
    const p = toNorm(e.clientX, e.clientY);
    if (!p) return;
    if (mine) {
      const s = strokes.get(`me:${mine.id}`);
      s.pts.push(p);
      s.at = Date.now();
      queue.push(p);
      if (!sendTimer) sendTimer = setTimeout(flush, 60);
      wake();
    } else if (mode && !(e.buttons & 1)) {
      if (!onMove.last || Date.now() - onMove.last > 70) { onMove.last = Date.now(); send({ k: 'pt', x: p[0], y: p[1], c: color }); laser = { x: p[0], y: p[1], c: color, at: Date.now() }; wake(); }
    }
  }
  function onUp() {
    if (!mine) return;
    clearTimeout(sendTimer);
    flush();
    mine = null;
  }
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointercancel', onUp);

  return {
    /** Drawing on / off for this side (the canvas catches the pointer only while it is on). */
    setMode(on) { mode = on; canvas.classList.toggle('on', on); if (!on) { mine = null; } },
    mode: () => mode,
    nextColor() { color = COLORS[(COLORS.indexOf(color) + 1) % COLORS.length]; return color; },
    color: () => color,
    handle(d) {
      if (d.k === 'dr' && Array.isArray(d.p)) {
        const key = `r:${String(d.i).slice(0, 12)}`;
        const s = strokes.get(key) || { pts: [], c: COLORS.includes(d.c) ? d.c : COLORS[0], at: 0 };
        for (const p of d.p.slice(0, 80)) if (Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1])) s.pts.push([p[0], p[1]]);
        s.at = Date.now();
        strokes.set(key, s);
        wake();
        return true;
      }
      if (d.k === 'pt' && Number.isFinite(d.x) && Number.isFinite(d.y)) {
        laser = { x: d.x, y: d.y, c: COLORS.includes(d.c) ? d.c : COLORS[0], at: Date.now() };
        wake();
        return true;
      }
      return false;
    },
    destroy() { cancelAnimationFrame(raf); canvas.remove(); },
  };
}
