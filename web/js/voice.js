// Voice messages and audio files: waveform bubble + one shared player with a top bar
// (play/pause, previous/next, 1x/1.5x/2x speed, seek by tapping the waveform), like Telegram.
import { h } from './dom.js';
import { t } from './i18n.js';
import { S, bucket } from './state.js';
import { icon } from './icons.js';

const BARS = 44;
const SPEEDS = [1, 1.5, 2];
const nodes = new Map(); // message id -> { setProgress, setPlaying, setSpeed }

let audio = null;
let current = null; // message being played
let speed = 1;
let bar = null;
try { speed = SPEEDS.includes(Number(localStorage.getItem('suhbat.speed'))) ? Number(localStorage.getItem('suhbat.speed')) : 1; } catch { /* storage blocked */ }

// ---------------------------------------------------------------- waveform data
/** 0..1 loudness samples -> compact base64url string sent with the message. */
export function encodeWave(peaks, n = 48) {
  if (!peaks?.length) return null;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * peaks.length) / n);
    const b = Math.max(a + 1, Math.floor(((i + 1) * peaks.length) / n));
    let m = 0;
    for (let k = a; k < b && k < peaks.length; k++) m = Math.max(m, peaks[k]);
    out[i] = Math.round(Math.min(1, m) * 255);
  }
  let bin = '';
  out.forEach((v) => { bin += String.fromCharCode(v); });
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeWave(str, n) {
  try {
    const bin = atob(str.replaceAll('-', '+').replaceAll('_', '/'));
    const src = Array.from(bin, (c) => c.charCodeAt(0) / 255);
    return Array.from({ length: n }, (_, i) => src[Math.min(src.length - 1, Math.floor((i * src.length) / n))]);
  } catch { return null; }
}

function pseudoWave(seed, n) {
  let x = (Number(seed) || 1) * 2654435761 % 4294967296;
  return Array.from({ length: n }, () => {
    x = (x * 1664525 + 1013904223) % 4294967296;
    return 0.25 + (x / 4294967296) * 0.7;
  });
}

const fmt = (s) => {
  const v = Math.max(0, Math.round(s || 0));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- the bubble
export function voiceNode(m) {
  const f = m.file;
  const isVoice = m.kind === 'voice';
  const peaks = (m.waveform && decodeWave(m.waveform, BARS)) || pseudoWave(m.id, BARS);
  const bars = peaks.map((v) => { const i = h('i'); i.style.height = `${Math.round(5 + v * 22)}px`; return i; });
  const wave = h('div', { class: 'voice-wave', role: 'slider', 'aria-label': t('voice.seek'), tabIndex: 0 }, bars);
  const play = h('button', { class: 'voice-play', type: 'button', 'aria-label': t('voice.play') }, icon('play', 22));
  const time = h('span', { class: 'voice-time' }, fmt(m.duration));
  const chip = h('button', { class: 'voice-speed', type: 'button', hidden: true, 'aria-label': t('voice.speed') }, `${speed}x`);
  const dur = () => m.duration || audio?.duration || 0;

  const root = h('div', { class: `voice ${isVoice ? '' : 'music'}` },
    play,
    h('div', { class: 'voice-body' },
      isVoice ? null : h('div', { class: 'voice-title ellipsis' }, f.name),
      wave,
      h('div', { class: 'voice-foot' }, time, chip)));

  const api = {
    setProgress(p, cur) {
      const on = Math.round(p * BARS);
      bars.forEach((b, i) => b.classList.toggle('on', i < on));
      time.textContent = fmt(cur >= 0 && p > 0 ? cur : m.duration);
    },
    setPlaying(on) {
      play.replaceChildren(icon(on ? 'pause' : 'play', 22));
      play.setAttribute('aria-label', on ? t('voice.pause') : t('voice.play'));
      root.classList.toggle('playing', on);
      chip.hidden = !on;
    },
    setSpeed(v) { chip.textContent = `${v}x`; },
  };
  nodes.set(m.id, api);
  if (current?.id === m.id) { api.setPlaying(!audio.paused); api.setProgress((audio.currentTime || 0) / (dur() || 1), audio.currentTime); }

  play.addEventListener('click', () => toggleMessage(m));
  chip.addEventListener('click', cycleSpeed);
  const seek = (ratio) => {
    if (current?.id !== m.id) { toggleMessage(m, { at: ratio }); return; }
    if (audio.duration || m.duration) audio.currentTime = Math.max(0, Math.min(1, ratio)) * (audio.duration || m.duration);
  };
  wave.addEventListener('click', (e) => {
    const r = wave.getBoundingClientRect();
    seek((e.clientX - r.left) / r.width);
  });
  wave.addEventListener('keydown', (e) => {
    if (current?.id !== m.id) return;
    if (e.key === 'ArrowRight') audio.currentTime += 5;
    else if (e.key === 'ArrowLeft') audio.currentTime -= 5;
  });
  return root;
}

// ---------------------------------------------------------------- shared player
function ensureAudio() {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('timeupdate', () => {
    if (!current) return;
    const d = audio.duration || current.duration || 0;
    nodes.get(current.id)?.setProgress(d ? audio.currentTime / d : 0, audio.currentTime);
    updateBar();
  });
  audio.addEventListener('play', () => { nodes.get(current?.id)?.setPlaying(true); updateBar(); });
  audio.addEventListener('pause', () => { nodes.get(current?.id)?.setPlaying(false); updateBar(); });
  audio.addEventListener('ended', () => {
    const done = current;
    nodes.get(done?.id)?.setPlaying(false);
    nodes.get(done?.id)?.setProgress(0, -1);
    const next = neighbour(done, 1);
    if (next) toggleMessage(next); // the next voice message starts by itself
    else closePlayer();
  });
  return audio;
}

function playlist(m) {
  return bucket(m.chat_id).list.filter((x) => (x.kind === 'voice' || x.kind === 'audio') && x.file && typeof x.id === 'number')
    .sort((a, b) => a.id - b.id);
}
function neighbour(m, dir) {
  if (!m) return null;
  const list = playlist(m);
  const i = list.findIndex((x) => x.id === m.id);
  return i < 0 ? null : list[i + dir] || null;
}

export function toggleMessage(m, { at = 0 } = {}) {
  const a = ensureAudio();
  if (current?.id === m.id) {
    if (a.paused) a.play().catch(() => {}); else a.pause();
    return;
  }
  if (current) {
    nodes.get(current.id)?.setPlaying(false);
    nodes.get(current.id)?.setProgress(0, -1);
  }
  current = m;
  a.src = m.file.url;
  a.playbackRate = speed;
  const start = () => { if (at && a.duration) a.currentTime = at * a.duration; };
  a.addEventListener('loadedmetadata', start, { once: true });
  a.play().catch(() => {});
  nodes.get(m.id)?.setSpeed(speed);
  showBar();
}

function cycleSpeed() {
  speed = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
  try { localStorage.setItem('suhbat.speed', String(speed)); } catch { /* ignore */ }
  if (audio) audio.playbackRate = speed;
  nodes.forEach((n) => n.setSpeed(speed));
  updateBar();
}

export function closePlayer() {
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  if (current) { nodes.get(current.id)?.setPlaying(false); nodes.get(current.id)?.setProgress(0, -1); }
  current = null;
  bar?.remove();
  bar = null;
  document.body.classList.remove('has-gplayer');
  window.removeEventListener('resize', placeBar);
}

// ---------------------------------------------------------------- top bar (like Telegram's player)
function senderOf(m) {
  if (m.sender_id === S.me?.id) return S.me.name;
  return S.users.get(m.sender_id)?.name || S.chats.get(m.chat_id)?.peer?.name || '';
}

function showBar() {
  if (!bar) {
    const title = h('div', { class: 'gp-title ellipsis' });
    const prev = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('voice.prev'), onclick: () => { const p = neighbour(current, -1); if (p) toggleMessage(p); } }, icon('prev', 20));
    const play = h('button', { class: 'icon-btn gp-play', type: 'button', 'aria-label': t('voice.play'), onclick: () => current && toggleMessage(current) }, icon('play', 22));
    const next = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('voice.next'), onclick: () => { const n = neighbour(current, 1); if (n) toggleMessage(n); } }, icon('next', 20));
    const time = h('span', { class: 'gp-time' }, '0:00');
    const sp = h('button', { class: 'gp-speed', type: 'button', 'aria-label': t('voice.speed'), onclick: cycleSpeed }, `${speed}x`);
    const close = h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), onclick: closePlayer }, icon('close', 18));
    const prog = h('div', { class: 'gp-prog' }, h('i'));
    bar = h('div', { class: 'gplayer', role: 'region', 'aria-label': t('voice.player') }, h('div', { class: 'gp-row' }, prev, play, next, title, time, sp, close), prog);
    bar._r = { title, play, time, sp, prog: prog.firstChild, prev, next };
    document.body.append(bar);
    document.body.classList.add('has-gplayer');
    window.addEventListener('resize', placeBar);
  }
  updateBar();
}

/** Pin the bar right under the chat header (full width of the chat column), like Telegram. */
function placeBar() {
  if (!bar) return;
  const head = document.querySelector('.chat-head');
  const r = head && head.offsetParent !== null ? head.getBoundingClientRect() : null;
  const s = bar.style;
  if (r && r.width > 0) { s.top = `${r.bottom}px`; s.left = `${r.left}px`; s.width = `${r.width}px`; }
  else { s.top = '0px'; s.left = '0px'; s.width = '100%'; }
}

function updateBar() {
  if (!bar || !current || !audio) return;
  placeBar();
  const r = bar._r;
  const when = new Date(current.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  r.title.replaceChildren(h('b', null, senderOf(current) || t('voice.player')), ` ${when}`);
  r.play.replaceChildren(icon(audio.paused ? 'play' : 'pause', 22));
  const d = audio.duration || current.duration || 0;
  r.time.textContent = `${fmt(audio.currentTime)} / ${fmt(d)}`;
  r.sp.textContent = `${speed}x`;
  r.prog.style.width = `${d ? Math.min(100, (audio.currentTime / d) * 100) : 0}%`;
  r.prev.disabled = !neighbour(current, -1);
  r.next.disabled = !neighbour(current, 1);
}
