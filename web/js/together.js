// Watching a video together during a call (play, pause and seeking are mirrored on both sides) and a pointer / pen on a
// shared screen. Both ride on small JSON messages that the call server passes to the other participants untouched.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { modal, toast } from './ui.js';

const nameOf = (id) => S.users.get(id)?.name || '';
const fmt = (s) => { const x = Math.max(0, Math.floor(s || 0)); return `${Math.floor(x / 60)}:${String(x % 60).padStart(2, '0')}`; };

/**
 * host: the element the stage is added to; send(data): passes a message to the others; chatId: where the videos come from.
 * Returns { handle(data), pick(), close(), active() }.
 */
export function createTogether({ host, send, chatId }) {
  let stage = null; // { el, video, src, lead, applying, beat }
  const api0 = {};

  function message(data) { send({ k: 'tg', ...data }); }

  function open(src, from) {
    close(false);
    const video = h('video', { class: 'tg-video', playsInline: true, preload: 'auto' });
    video.src = src.url;
    const play = h('button', { class: 'icon-btn tg-play', type: 'button', 'aria-label': t('tg.play') }, icon('play', 22));
    const range = h('input', { class: 'tg-range', type: 'range', min: '0', max: '1000', value: '0', 'aria-label': t('tg.seek') });
    const time = h('span', { class: 'tg-time' }, '0:00');
    const who = h('span', { class: 'tg-who ellipsis' }, from ? t('tg.started_by', { name: nameOf(from) }) : t('tg.you_started'));
    const el = h('div', { class: 'tg-stage', role: 'region', 'aria-label': t('tg.title') },
      h('div', { class: 'tg-top' }, h('b', { class: 'ellipsis' }, src.name || t('tg.title')), who,
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('tg.close'), onclick: () => { message({ a: 'close' }); close(false); } }, icon('close', 20))),
      video, h('div', { class: 'tg-bar' }, play, range, time));
    host.append(el);
    stage = { el, video, src, lead: !from, applying: 0 };
    const quiet = () => { stage.applying = Date.now() + 500; };
    const mine = () => stage && Date.now() > stage.applying;
    play.onclick = () => { if (video.paused) video.play().catch(() => {}); else video.pause(); };
    range.oninput = () => { if (video.duration) { video.currentTime = (Number(range.value) / 1000) * video.duration; } };
    video.addEventListener('play', () => { play.replaceChildren(icon('pause', 22)); if (mine()) { stage.lead = true; message({ a: 'play', t: video.currentTime }); } });
    video.addEventListener('pause', () => { play.replaceChildren(icon('play', 22)); if (mine()) { stage.lead = true; message({ a: 'pause', t: video.currentTime }); } });
    video.addEventListener('seeked', () => { if (mine()) { stage.lead = true; message({ a: 'seek', t: video.currentTime, p: !video.paused }); } });
    video.addEventListener('timeupdate', () => {
      time.textContent = `${fmt(video.currentTime)} / ${fmt(video.duration)}`;
      if (video.duration && document.activeElement !== range) range.value = String(Math.round((video.currentTime / video.duration) * 1000));
    });
    video.addEventListener('error', () => toast(t('tg.cannot_play')));
    stage.beat = setInterval(() => {
      // the last one who pressed something reminds the others where the video is (helps a person who joined later)
      if (stage?.lead && !video.paused) message({ a: 'state', t: video.currentTime, p: true, src: { id: src.id, name: src.name } });
    }, 5000);
    stage.quiet = quiet;
    return stage;
  }

  function close(tell = true) {
    if (!stage) return;
    clearInterval(stage.beat);
    try { stage.video.pause(); } catch { /* gone */ }
    stage.el.remove();
    stage = null;
    if (tell) message({ a: 'close' });
  }

  const srcOf = (s) => (s && typeof s.id === 'string' && /^[\w-]{8,40}$/.test(s.id) ? { id: s.id, name: String(s.name || '').slice(0, 80), url: `/api/files/${s.id}` } : null);

  function handle(d, from) {
    if (d.k !== 'tg') return false;
    if (d.a === 'load') {
      const s = srcOf(d.src);
      if (!s) return true;
      open(s, from);
      toast(t('tg.started_by', { name: nameOf(from) }));
      return true;
    }
    if (d.a === 'close') { if (stage) { close(false); toast(t('tg.closed')); } return true; }
    if (d.a === 'state' && !stage) {
      const s = srcOf(d.src);
      if (s) { open(s, from); stage.video.currentTime = Number(d.t) || 0; stage.quiet(); stage.video.play().catch(() => {}); }
      return true;
    }
    if (!stage) return true;
    const v = stage.video;
    stage.quiet();
    stage.lead = false;
    const at = Number(d.t);
    const drift = Number.isFinite(at) ? Math.abs(v.currentTime - at) : 0;
    if (d.a === 'play') { if (drift > 0.7) v.currentTime = at; v.play().catch(() => toast(t('tg.tap_to_play'))); }
    else if (d.a === 'pause') { v.pause(); if (drift > 0.3) v.currentTime = at; }
    else if (d.a === 'seek') { v.currentTime = at; if (d.p && v.paused) v.play().catch(() => {}); }
    else if (d.a === 'state' && d.p && drift > 1.5) { v.currentTime = at; if (v.paused) v.play().catch(() => {}); }
    return true;
  }

  /** The list of videos and audio already in this chat, plus "upload one from this device". */
  async function pick() {
    const list = h('div', { class: 'tg-list' }, h('p', { class: 'muted' }, t('net.connecting')));
    const fileInput = h('input', { type: 'file', accept: 'video/*,audio/*', class: 'sr', tabIndex: -1 });
    const err = h('div', { class: 'err', role: 'alert' });
    const win = modal({ title: t('tg.title'), body: [h('p', { class: 'muted' }, t('tg.hint')), h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, t('tg.upload')), fileInput, err, list] });
    fileInput.onchange = async () => {
      const f = fileInput.files[0];
      if (!f) return;
      err.textContent = t('tg.uploading');
      try {
        const r = await api('POST', `/api/chats/${chatId}/files?name=${encodeURIComponent(f.name)}`, undefined, { raw: f, headers: { 'content-type': 'application/octet-stream' } });
        const m = r.message;
        if (!m.file) throw Object.assign(new Error(), { code: 'generic' });
        win.close();
        startFromMessage(m);
      } catch (e) { err.textContent = errText(e.code); }
    };
    try {
      const [a, b] = await Promise.all([api('GET', `/api/chats/${chatId}/media?kind=media`), api('GET', `/api/chats/${chatId}/media?kind=files`)]);
      const items = [...a.messages, ...b.messages].filter((m) => m.file && (m.kind === 'video' || m.kind === 'audio')).sort((x, y) => y.id - x.id).slice(0, 30);
      clear(list);
      if (!items.length) list.append(h('p', { class: 'muted' }, t('tg.none')));
      for (const m of items) {
        list.append(h('button', { class: 'tg-item', type: 'button', onclick: () => { win.close(); startFromMessage(m); } },
          m.file.thumb ? h('img', { src: m.file.thumb, alt: '' }) : h('span', { class: 'tg-ico' }, icon(m.kind === 'video' ? 'video' : 'speaker', 22)),
          h('span', { class: 'ellipsis' }, m.file.name)));
      }
    } catch (e) { clear(list); err.textContent = errText(e.code); }
  }

  function startFromMessage(m) {
    // the file id is a string on the server: the other side loads it by the same id
    const s = { id: m.file.id, name: m.file.name, url: m.file.url };
    open(s, 0);
    stage.video.play().catch(() => {});
    message({ a: 'load', src: { id: s.id, name: s.name } });
  }

  Object.assign(api0, { handle, pick, close: () => close(true), destroy: () => close(false), active: () => !!stage });
  return api0;
}
