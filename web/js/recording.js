// Recording of a call, only with everybody's consent: the person who wants to record asks, the others answer, and while
// the recording runs everybody sees a red bar (and can simply leave). The sound is mixed on this device and saved into the
// chat as an audio message; its text and minutes are made afterwards from the normal "text of a voice message" service.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';

const nameOf = (id) => S.users.get(id)?.name || '';
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/**
 * host: element for the red bar; send(data); streams(): MediaStreams to mix (own microphone and everybody else);
 * peers(): how many others are in the call; chatId.
 */
export function createRecording({ host, send, streams, peers, chatId }) {
  let state = 'idle'; // idle | asking | recording
  let asked = null; // { need, yes: Set }
  let rec = null; // { mr, chunks, ac, started, tick, tracked: Set }
  let bar = null;
  let lastOn = 0;
  let remoteBar = null;
  let watchdog = 0;
  const listeners = new Set();
  const changed = () => listeners.forEach((f) => f(state));

  const supported = () => !!(window.MediaRecorder && (window.AudioContext || window.webkitAudioContext));

  function showBar(text, stop) {
    bar?.remove();
    bar = h('div', { class: 'rec-banner', role: 'status' }, h('span', { class: 'rec-dot2' }), h('b', null, text), h('span', { class: 'rec-clock' }, '0:00'),
      stop ? h('button', { class: 'btn small', type: 'button', onclick: stop }, t('rec.stop')) : null);
    host.append(bar);
  }

  function begin() {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();
    rec = { ac, dest, tracked: new Set(), chunks: [], started: Date.now() };
    const connect = () => {
      for (const s of streams()) {
        if (!s || rec.tracked.has(s.id) || !s.getAudioTracks().length) continue;
        rec.tracked.add(s.id);
        try { ac.createMediaStreamSource(s).connect(dest); } catch { /* a stream that is gone */ }
      }
    };
    connect();
    rec.connectTimer = setInterval(connect, 2000); // people who join later
    const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((x) => MediaRecorder.isTypeSupported(x)) || '';
    rec.mr = new MediaRecorder(dest.stream, { ...(type ? { mimeType: type } : {}), audioBitsPerSecond: 40000 });
    const mine = rec; // the last piece arrives after `rec` was cleared by stop()
    rec.mr.ondataavailable = (e) => { if (e.data.size) mine.chunks.push(e.data); };
    rec.mr.start(5000);
    state = 'recording';
    showBar(t('rec.you_record'), () => stop());
    rec.tick = setInterval(() => {
      const s = (Date.now() - rec.started) / 1000;
      bar?.querySelector('.rec-clock') && (bar.querySelector('.rec-clock').textContent = mmss(s));
      send({ k: 'rec', a: 'on' });
      if (s > 3 * 3600) stop(); // three hours is plenty
    }, 6000);
    send({ k: 'rec', a: 'on' });
    changed();
  }

  async function stop() {
    if (state !== 'recording' || !rec) return;
    const r = rec;
    rec = null;
    state = 'idle';
    clearInterval(r.tick);
    clearInterval(r.connectTimer);
    await new Promise((res) => { r.mr.onstop = res; try { r.mr.stop(); } catch { res(); } });
    try { r.ac.close(); } catch { /* ignore */ }
    send({ k: 'rec', a: 'off' });
    bar?.remove();
    bar = null;
    changed();
    const seconds = Math.round((Date.now() - r.started) / 1000);
    const blob = new Blob(r.chunks, { type: r.mr.mimeType || 'audio/webm' });
    if (seconds < 3 || blob.size < 1000) { toast(t('rec.too_short')); return; }
    save(blob, seconds);
  }

  async function save(blob, seconds) {
    toast(t('rec.saving'));
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}-${String(d.getMinutes()).padStart(2, '0')}`;
    const ext = /mp4/.test(blob.type) ? 'm4a' : 'webm';
    const caption = `${t('rec.caption')} · ${mmss(seconds)}`;
    try {
      const r = await api('POST', `/api/chats/${chatId}/files?name=${encodeURIComponent(`${t('rec.file')} ${stamp}.${ext}`)}&duration=${seconds}&audio=1&caption=${encodeURIComponent(caption)}`,
        undefined, { raw: blob, headers: { 'content-type': 'application/octet-stream' } });
      toast(t('rec.saved'), 5000);
      // text and minutes are made on our own server, if the service is running
      if (S.cfg?.transcribe && r.message?.id) api('POST', `/api/messages/${r.message.id}/transcribe`, { lang: S.prefs.trLang || '' }).catch(() => {});
    } catch (e) {
      toast(errText(e.code), 6000);
      // do not lose a long call: offer the file
      const url = URL.createObjectURL(blob);
      const a = h('a', { class: 'btn', href: url, download: `${t('rec.file')} ${stamp}.${ext}` }, t('rec.download'));
      const m = modal({ title: t('rec.title'), body: [h('p', null, t('rec.not_saved')), a], onClose: () => URL.revokeObjectURL(url) });
      a.addEventListener('click', () => setTimeout(() => m.close(), 500));
    }
  }

  function ask() {
    if (!supported()) { toast(t('rec.unsupported')); return; }
    if (state !== 'idle') return;
    if (!peers()) { begin(); return; } // nobody else is here: nothing to ask
    state = 'asking';
    asked = { need: peers(), yes: new Set() };
    send({ k: 'rec', a: 'ask' });
    toast(t('rec.asked'), 5000);
    setTimeout(() => { if (state === 'asking') { state = 'idle'; asked = null; toast(t('rec.no_answer')); changed(); } }, 25000);
    changed();
  }

  function remote(on, who) {
    remoteBar?.remove();
    clearTimeout(watchdog);
    if (!on) { remoteBar = null; return; }
    remoteBar = h('div', { class: 'rec-banner remote', role: 'status' }, h('span', { class: 'rec-dot2' }), h('b', null, t('rec.someone', { name: nameOf(who) })));
    host.append(remoteBar);
    watchdog = setTimeout(() => remote(false), 20000); // the recorder repeats "on" every few seconds
  }

  function handle(d, from) {
    if (d.k !== 'rec') return false;
    if (d.a === 'ask') {
      const m = modal({
        title: t('rec.title'), onClose: () => { if (!m.answered) send({ k: 'rec', a: 'no', to: from }); },
        body: [h('p', null, t('rec.ask_you', { name: nameOf(from) })), h('p', { class: 'muted' }, t('rec.ask_why')),
          h('div', { class: 'rec-ask' },
            h('button', { class: 'btn', type: 'button', onclick: () => { m.answered = true; send({ k: 'rec', a: 'yes', to: from }); m.close(); } }, t('rec.allow')),
            h('button', { class: 'btn secondary', type: 'button', onclick: () => m.close() }, t('rec.deny')))],
      });
      return true;
    }
    if ((d.a === 'yes' || d.a === 'no') && d.to === S.me.id && state === 'asking' && asked) {
      if (d.a === 'no') { state = 'idle'; asked = null; toast(t('rec.denied', { name: nameOf(from) }), 6000); changed(); return true; }
      asked.yes.add(from);
      if (asked.yes.size >= asked.need) { asked = null; begin(); }
      return true;
    }
    if (d.a === 'on') { lastOn = Date.now(); if (state !== 'recording') remote(true, from); return true; }
    if (d.a === 'off') { remote(false); return true; }
    void lastOn;
    return true;
  }

  return {
    ask, stop, handle, supported, state: () => state,
    toggle: () => (state === 'recording' ? stop() : ask()),
    onChange: (f) => { listeners.add(f); return () => listeners.delete(f); },
    destroy() { if (state === 'recording') stop(); remoteBar?.remove(); bar?.remove(); clearTimeout(watchdog); },
  };
}
