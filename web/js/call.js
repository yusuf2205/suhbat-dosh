import { h, clear, formatDuration, uuid } from './dom.js';
import { t } from './i18n.js';
import { S, fire, savePrefs } from './state.js';
import { api, wsSend } from './net.js';
import { icon } from './icons.js';
import { popMenu, avatar, modal, toast, beep } from './ui.js';
import { Summary, VideoAdapter, sampleFromStats, score } from './callquality.js';

// 1:1 WebRTC calls. Signalling goes over the existing WebSocket; media is peer-to-peer (or via TURN).
// Quality: Opus audio with echo cancellation / noise suppression / AGC, up to 1080p30 video that is
// stepped down (video first, never the voice) when the network degrades, ICE restart on network change.
let cur = null;        // the active call state
let ice = [{ urls: ['stun:stun.l.google.com:19302'] }];
let ui = null;
let ringTimer = null;

export const inCall = () => !!cur;

async function loadIce() {
  try {
    const c = await api('GET', '/api/config');
    if (Array.isArray(c.ice_servers) && c.ice_servers.length) ice = c.ice_servers;
  } catch { /* keep defaults */ }
}

function ringStart(loop = true) {
  ringStop();
  if (!S.prefs.sound) return;
  beep();
  if (loop) ringTimer = setInterval(beep, 1800);
}
function ringStop() {
  clearInterval(ringTimer);
  ringTimer = null;
}

// ---------------------------------------------------------------- preferences & constraints
const mode = () => (['auto', 'high', 'save'].includes(S.prefs.callQuality) ? S.prefs.callQuality : 'auto');

function audioConstraints() {
  const proc = S.prefs.audioProcessing !== false;
  return {
    echoCancellation: proc, noiseSuppression: proc, autoGainControl: proc,
    ...(S.prefs.micId ? { deviceId: { exact: S.prefs.micId } } : {}),
  };
}

function videoConstraints() {
  const save = mode() === 'save';
  return {
    width: { ideal: save ? 640 : 1920 }, height: { ideal: save ? 360 : 1080 },
    frameRate: save ? { ideal: 15, max: 20 } : { ideal: 30 },
    ...(S.prefs.camId ? { deviceId: { exact: S.prefs.camId } } : { facingMode: 'user' }),
  };
}

async function media(video) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.RTCPeerConnection) {
    toast(t('call.insecure'), 6000);
    return null;
  }
  const attempts = [
    { audio: audioConstraints(), video: video ? videoConstraints() : false },
    // a remembered device may be unplugged: fall back to defaults
    { audio: { ...audioConstraints(), deviceId: undefined }, video: video ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false },
  ];
  for (const c of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(c);
    } catch (e) {
      if (e.name === 'NotAllowedError' || e.name === 'SecurityError') { toast(t('call.no_media'), 5000); return null; }
    }
  }
  if (video) {
    // no usable camera: carry on with voice only
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: false });
      toast(t('call.no_camera'), 5000);
      return s;
    } catch { /* fall through */ }
  }
  toast(t('call.no_mic'), 5000);
  return null;
}

// ---------------------------------------------------------------- UI
function buildUi() {
  const remote = h('video', { class: 'call-remote', autoplay: true, playsInline: true });
  const local = h('video', { class: 'call-local', autoplay: true, playsInline: true, muted: true, hidden: true });
  const status = h('div', { class: 'call-status', role: 'status' });
  const timer = h('span', { class: 'call-time' });
  const quality = h('span', { class: 'call-quality', 'data-q': '0', hidden: true, title: t('call.quality') }, h('i'), h('i'), h('i'));
  const stats = h('div', { class: 'call-stats' });
  const who = h('div', { class: 'call-who' });
  const controls = h('div', { class: 'call-controls' });
  const fsBtn = h('button', { class: 'call-fs', type: 'button', 'aria-label': t('call.fullscreen'), title: t('call.fullscreen'),
    onclick: () => { ui?.root.classList.toggle('full'); } }, icon('grid', 18));
  const card = h('div', { class: 'call-card' },
    h('div', { class: 'call-bg' }), remote, h('div', { class: 'call-shade' }),
    h('div', { class: 'call-top' }, who, status, h('div', null, timer, quality), stats),
    local, controls, fsBtn);
  const root = h('div', { class: 'call-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('nav.calls') }, card);
  document.body.append(root);
  return { root, card, remote, local, status, timer, who, controls, quality, stats, bg: root.querySelector('.call-bg'), panel: null };
}

function btn(cls, ico, label, onclick, caption) {
  const b = h('button', { class: `call-btn ${cls}`, type: 'button', 'aria-label': label, title: label, onclick }, icon(ico, 26));
  return h('div', { class: 'call-ctl' }, b, h('span', null, caption || label));
}

function toggleSpeaker() {
  if (!cur) return;
  cur.speaker = !cur.speaker;
  try { window.SuhbatNative?.setSpeaker(cur.speaker); } catch { /* not the Android app */ }
  renderControls();
}

function renderControls() {
  if (!ui || !cur) return;
  clear(ui.controls);
  if (cur.state === 'incoming') {
    ui.controls.append(
      btn('decline', 'phone', t('call.decline'), () => hangup('decline')),
      btn('accept', cur.video ? 'video' : 'phone', t('call.accept'), acceptIncoming),
    );
    return;
  }
  const hasCam = !!cur.local?.getVideoTracks().some((tr) => tr.readyState === 'live');
  const camOn = hasCam && !cur.camOff && !cur.sharing;
  // screen sharing (desktop browsers and the desktop app)
  if (navigator.mediaDevices?.getDisplayMedia) {
    ui.controls.append(btn(cur.sharing ? 'on' : '', 'grid', cur.sharing ? t('call.screen_stop') : t('call.screen'), toggleScreen, t('call.screen_short')));
  }
  ui.controls.append(withMenu(btn(camOn ? 'on' : 'off', 'video', camOn ? t('call.camera_off') : t('call.camera_on'), toggleCamera,
    camOn ? t('call.video_off') : t('call.video_on')), (anchor) => deviceMenu(anchor, 'cam')));
  ui.controls.append(btn('decline end', 'phone', t('call.hangup'), () => hangup('hangup'), t('call.hangup_short')));
  ui.controls.append(withMenu(btn(cur.muted ? 'off' : '', 'mic', cur.muted ? t('call.unmute') : t('call.mute'), () => {
    cur.muted = !cur.muted;
    cur.local?.getAudioTracks().forEach((tr) => { tr.enabled = !cur.muted; });
    renderControls();
  }, cur.muted ? t('call.unmute_short') : t('call.mute_short')), (anchor) => deviceMenu(anchor, 'mic')));
  if (window.SuhbatNative?.setSpeaker) {
    ui.controls.append(btn(cur.speaker ? 'on' : '', 'speaker', cur.speaker ? t('call.speaker_off') : t('call.speaker_on'), toggleSpeaker, cur.speaker ? t('call.earpiece_short') : t('call.speaker_short')));
  }
  if ((cur.cams?.length || 0) > 1 && camOn) ui.controls.append(btn('', 'chat', t('call.switch_camera'), switchCamera, t('call.flip')));
  ui.controls.append(btn(ui.panel ? 'on' : '', 'settings', t('call.settings'), toggleDevicePanel, t('call.settings_short')));
}

/** A control with a small chevron that opens a device list (like Telegram's call window). */
function withMenu(ctl, open) {
  const chev = h('button', { class: 'call-chev', type: 'button', 'aria-label': t('call.settings'), 'aria-haspopup': 'menu',
    onclick: (e) => { e.stopPropagation(); open(chev); } }, icon('back', 14));
  ctl.append(chev);
  ctl.classList.add('has-menu');
  return ctl;
}

async function deviceMenu(anchor, kind) {
  const dev = await listDevices();
  const list = kind === 'cam' ? dev.cams : dev.mics;
  const cur0 = kind === 'cam' ? S.prefs.camId : S.prefs.micId;
  const items = [{ label: `${cur0 ? '' : '● '}${t('call.default')}`, onClick: () => pick('') }];
  list.forEach((d, i) => items.push({ label: `${d.deviceId === cur0 ? '● ' : ''}${devLabel(d, i, kind === 'cam' ? t('call.camera') : t('call.microphone'))}`, onClick: () => pick(d.deviceId) }));
  async function pick(id) {
    if (kind === 'cam') S.prefs.camId = id; else S.prefs.micId = id;
    savePrefs();
    if (kind === 'cam' && cur?.pc && hasLiveCam()) await replaceTrack('video');
    if (kind === 'mic' && cur?.pc) await replaceTrack('audio');
  }
  popMenu(anchor, items);
}

const hasLiveCam = () => !!cur?.local?.getVideoTracks().some((tr) => tr.readyState === 'live' && !tr.__screen);

function announceMedia() {
  if (!cur) return;
  const live = !!cur.local?.getVideoTracks().some((x) => x.readyState === 'live');
  wsSend({ type: 'call.media', call_id: cur.id, video: live, screen: !!cur.sharing });
}

/** Camera on/off. In a voice call this upgrades it to video (the connection is renegotiated). */
async function toggleCamera() {
  if (!cur?.pc) return;
  try {
    if (cur.sharing) await stopScreen(false);
    if (hasLiveCam()) {
      // turn the camera off for real: the light goes out and the other side shows our avatar
      const sender = cur.pc.getSenders().find((x) => x.track?.kind === 'video');
      const tr = cur.local.getVideoTracks().find((x) => x.readyState === 'live');
      await sender?.replaceTrack(null);
      tr?.stop();
      cur.local.removeTrack(tr);
      cur.camOff = true;
      if (ui) ui.local.hidden = true;
      announceMedia();
    } else {
      const st = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
      await sendVideoTrack(st.getVideoTracks()[0]);
      cur.camOff = false;
      announceMedia();
    }
  } catch { toast(t('call.no_camera')); }
  renderControls();
}

/** Put a video track on the connection (reusing the video sender when there is one). */
async function sendVideoTrack(track) {
  const pc = cur.pc;
  cur.local.getVideoTracks().forEach((x) => { if (x !== track) { x.stop(); cur.local.removeTrack(x); } });
  cur.local.addTrack(track);
  let sender = pc.getSenders().find((x) => x.track?.kind === 'video');
  if (!sender) {
    // a video transceiver can exist with an empty sender (camera was turned off) or as receive-only
    const tr = pc.getTransceivers().find((x) => x.receiver.track.kind === 'video' && x.currentDirection !== 'stopped');
    if (tr) {
      if (tr.direction === 'recvonly' || tr.direction === 'inactive') tr.direction = 'sendrecv'; // triggers renegotiation
      sender = tr.sender;
    }
  }
  if (sender) await sender.replaceTrack(track);
  else pc.addTrack(track, cur.local); // new m-line: onnegotiationneeded sends the offer
  cur.video = true;
  ui?.root.classList.add('video');
  announceMedia();
  if (ui) { ui.local.srcObject = cur.local; ui.local.hidden = false; ui.local.classList.toggle('screen', !!track.__screen); }
  preferCodecs(pc);
  applyVideoParams(cur.adapter?.params());
}

async function toggleScreen() {
  if (!cur?.pc) return;
  if (cur.sharing) { await stopScreen(true); return; }
  try {
    const st = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false });
    const track = st.getVideoTracks()[0];
    track.__screen = true;
    track.addEventListener('ended', () => { if (cur?.sharing) stopScreen(true); });
    cur.sharing = true;
    await sendVideoTrack(track);
  } catch (e) {
    if (e?.name !== 'NotAllowedError') toast(t('call.no_screen'));
  }
  renderControls();
}

async function stopScreen(restoreCamera) {
  if (!cur) return;
  cur.sharing = false;
  const tr = cur.local?.getVideoTracks().find((x) => x.__screen);
  tr?.stop();
  if (tr) cur.local.removeTrack(tr);
  const sender = cur.pc?.getSenders().find((x) => x.track === tr || (x.track?.kind === 'video' && x.track.readyState === 'ended'));
  try { await sender?.replaceTrack(null); } catch { /* ignore */ }
  if (ui) ui.local.hidden = true;
  announceMedia();
  if (restoreCamera && !cur.camOff && cur.video) {
    try {
      const st = await navigator.mediaDevices.getUserMedia({ video: videoConstraints() });
      await sendVideoTrack(st.getVideoTracks()[0]);
    } catch { /* stay without camera */ }
  }
  renderControls();
}

function setStatus(text) {
  if (ui) ui.status.textContent = text;
}

function tick() {
  if (!ui || !cur?.connectedAt) return;
  ui.timer.textContent = formatDuration((Date.now() - cur.connectedAt) / 1000);
}

function mountCallUi(peer) {
  ui = buildUi();
  clear(ui.who).append(avatar(peer, 'lg'), h('b', null, peer?.name || ''));
  if (peer?.avatar) ui.bg.style.backgroundImage = `url(${peer.avatar})`;
  ui.root.classList.toggle('video', !!cur.video);
  renderControls();
}

// ---------------------------------------------------------------- devices (in a call and in settings)
async function listDevices() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return {
      mics: all.filter((d) => d.kind === 'audioinput'),
      cams: all.filter((d) => d.kind === 'videoinput'),
      spks: all.filter((d) => d.kind === 'audiooutput'),
    };
  } catch {
    return { mics: [], cams: [], spks: [] };
  }
}

const devLabel = (d, i, what) => d.label || `${what} ${i + 1}`;

/** The block of selectors used both in settings and inside the call screen. */
export async function devicePanelNodes({ live = false } = {}) {
  const dev = await listDevices();
  const sel = (id, list, current, what, onChange) => {
    const s = h('select', { class: 'input', id, 'aria-label': what },
      h('option', { value: '' }, t('call.default_device')),
      list.map((d, i) => h('option', { value: d.deviceId, selected: d.deviceId === current }, devLabel(d, i, what))));
    s.onchange = () => onChange(s.value);
    return h('div', { class: 'field' }, h('span', null, what), s);
  };
  const out = [];
  out.push(sel(`${live ? 'l' : 's'}-mic`, dev.mics, S.prefs.micId, t('call.microphone'), async (v) => {
    S.prefs.micId = v || '';
    savePrefs();
    if (live && cur?.pc) await replaceTrack('audio');
  }));
  if (dev.spks.length && 'setSinkId' in HTMLMediaElement.prototype) {
    out.push(sel(`${live ? 'l' : 's'}-spk`, dev.spks, S.prefs.spkId, t('call.speaker'), async (v) => {
      S.prefs.spkId = v || '';
      savePrefs();
      if (live) applySink();
    }));
  }
  out.push(sel(`${live ? 'l' : 's'}-cam`, dev.cams, S.prefs.camId, t('call.camera'), async (v) => {
    S.prefs.camId = v || '';
    savePrefs();
    if (live && cur?.pc && cur.video) await replaceTrack('video');
  }));
  const q = h('select', { class: 'input', id: `${live ? 'l' : 's'}-q`, 'aria-label': t('call.quality_mode') },
    ['auto', 'high', 'save'].map((m) => h('option', { value: m, selected: mode() === m }, t(`call.mode_${m}`))));
  q.onchange = () => {
    S.prefs.callQuality = q.value;
    savePrefs();
    if (live && cur) { cur.adapter = new VideoAdapter(mode()); applyVideoParams(cur.adapter.params()); }
  };
  out.push(h('div', { class: 'field' }, h('span', null, t('call.quality_mode')), q));
  const proc = h('input', { type: 'checkbox', id: `${live ? 'l' : 's'}-proc`, checked: S.prefs.audioProcessing !== false });
  proc.onchange = async () => {
    S.prefs.audioProcessing = proc.checked;
    savePrefs();
    if (live && cur?.pc) await replaceTrack('audio');
  };
  out.push(h('label', { class: 'row', for: `${live ? 'l' : 's'}-proc` }, proc, t('call.processing')));
  out.push(h('div', { class: 'muted', style: { fontSize: '.82rem' } }, t('call.processing_hint')));
  if (dev.mics.some((d) => /bluetooth|hands-?free|airpods|headset/i.test(d.label))) {
    out.push(h('div', { class: 'muted', style: { fontSize: '.82rem' } }, `🎧 ${t('call.bt_detected')}`));
  }
  return out;
}

async function toggleDevicePanel() {
  if (!ui) return;
  if (ui.panel) { ui.panel.remove(); ui.panel = null; renderControls(); return; }
  ui.panel = h('div', { class: 'call-panel' }, h('h3', null, t('call.settings')), ...(await devicePanelNodes({ live: true })));
  (ui.card || ui.root).append(ui.panel);
  renderControls();
}

async function replaceTrack(kind) {
  if (!cur?.pc) return;
  try {
    const s = await navigator.mediaDevices.getUserMedia(kind === 'audio' ? { audio: audioConstraints() } : { video: videoConstraints() });
    const track = s.getTracks()[0];
    const sender = cur.pc.getSenders().find((x) => x.track?.kind === kind);
    if (sender) {
      const old = sender.track;
      await sender.replaceTrack(track);
      old?.stop();
      cur.local?.removeTrack(old);
      cur.local?.addTrack(track);
      if (kind === 'audio') track.enabled = !cur.muted;
      if (kind === 'video') { track.enabled = !cur.camOff; attachLocal(cur.local); }
      applyVideoParams(cur.adapter?.params());
    }
  } catch { toast(t('call.no_media')); }
}

async function switchCamera() {
  if (!cur?.cams?.length) return;
  const curId = cur.local?.getVideoTracks()[0]?.getSettings?.().deviceId;
  const i = cur.cams.findIndex((d) => d.deviceId === curId);
  const next = cur.cams[(i + 1) % cur.cams.length];
  S.prefs.camId = next.deviceId;
  savePrefs();
  await replaceTrack('video');
}

async function toggleFocus() {
  const tr = cur?.local?.getVideoTracks()[0];
  if (!tr) return;
  cur.focusAuto = cur.focusAuto === false;
  try { await tr.applyConstraints({ advanced: [{ focusMode: cur.focusAuto ? 'continuous' : 'manual' }] }); } catch { /* not supported */ }
  renderControls();
}

function applySink() {
  const id = S.prefs.spkId;
  if (id && ui?.remote?.setSinkId) ui.remote.setSinkId(id).catch(() => {});
}

// ---------------------------------------------------------------- peer connection & adaptation
function preferCodecs(pc) {
  try {
    for (const tr of pc.getTransceivers()) {
      const kind = tr.sender?.track?.kind || tr.receiver?.track?.kind;
      const caps = RTCRtpSender.getCapabilities(kind);
      if (!caps) continue;
      const rank = (c) => {
        const m = c.mimeType.toLowerCase();
        if (kind === 'audio') return m.includes('opus') ? 0 : 1;
        if (m.includes('vp8')) return 0;
        if (m.includes('h264')) return 1;
        if (m.includes('vp9')) return 2;
        return 3; // AV1 and the rest last: widest compatibility first
      };
      tr.setCodecPreferences([...caps.codecs].sort((a, b) => rank(a) - rank(b)));
    }
  } catch { /* older browsers keep their defaults */ }
}

async function applyVideoParams(p) {
  if (!cur?.pc || !p) return;
  const sender = cur.pc.getSenders().find((s) => s.track?.kind === 'video');
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].maxBitrate = p.kbps * 1000;
    params.encodings[0].scaleResolutionDownBy = p.scale;
    params.encodings[0].maxFramerate = p.fps;
    params.degradationPreference = 'maintain-framerate';
    await sender.setParameters(params);
    cur.level = p.label;
  } catch { /* not supported everywhere */ }
}

async function prioritiseAudio() {
  const sender = cur?.pc?.getSenders().find((s) => s.track?.kind === 'audio');
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    params.encodings[0].priority = 'high';
    params.encodings[0].networkPriority = 'high';
    params.encodings[0].maxBitrate = 64000; // Opus wideband: clear speech, tiny share of the link
    await sender.setParameters(params);
  } catch { /* optional */ }
}

function startStats() {
  if (!cur || cur.statsTimer) return;
  cur.adapter = new VideoAdapter(mode());
  cur.summary = new Summary(mode());
  cur.prevStats = null;
  let lastAt = performance.now();
  if (cur.video) applyVideoParams(cur.adapter.params());
  prioritiseAudio();
  cur.statsTimer = setInterval(async () => {
    if (!cur?.pc) return;
    let report;
    try { report = await cur.pc.getStats(); } catch { return; }
    const now = performance.now();
    const s = sampleFromStats(cur.prevStats, report, (now - lastAt) / 1000);
    lastAt = now;
    cur.prevStats = s.raw;
    cur.summary.add(s);
    const q = score({ rtt: s.rtt, lossPct: s.lossPct, jitter: s.jitter });
    if (ui) {
      ui.quality.hidden = false;
      ui.quality.dataset.q = String(q);
      const parts = [];
      if (s.width && s.height) parts.push(`${s.width}×${s.height}${s.fps ? `@${Math.round(s.fps)}` : ''}`);
      if (s.rtt !== null) parts.push(`${Math.round(s.rtt)} ms`);
      ui.stats.textContent = parts.join(' · ');
      if (q === 1) setStatus(t('call.poor'));
      else if (ui.status.textContent === t('call.poor') || ui.status.textContent === t('call.reconnecting')) setStatus('');
    }
    if (cur.video) {
      const step = cur.adapter.push(q, s.availableKbps);
      if (step) applyVideoParams(step);
    }
  }, 2000);
}

function newPc() {
  const pc = new RTCPeerConnection({ iceServers: ice, bundlePolicy: 'max-bundle' });
  pc.onicecandidate = (e) => {
    wsSend({ type: 'call.ice', call_id: cur.id, candidate: e.candidate ? e.candidate.toJSON() : null });
  };
  pc.ontrack = (e) => {
    if (!ui) return;
    ui.remote.srcObject = e.streams[0] || new MediaStream([e.track]);
    applySink();
    ui.remote.play?.().catch(() => {});
    if (e.track.kind === 'video') {
      // the other side turned the camera / screen on or off: show video or fall back to the avatar
      const show = () => { ui?.root.classList.add('video'); ui?.root.classList.remove('rvoff'); if (cur) cur.video = true; };
      const hide = () => ui?.root.classList.add('rvoff');
      e.track.onmute = hide;
      e.track.onunmute = show;
      if (!e.track.muted) show();
    }
  };
  pc.onnegotiationneeded = async () => {
    // only after the first connection: the initial offer is created explicitly
    if (!cur || !cur.connectedAt || pc.signalingState !== 'stable') return;
    try {
      const offer = await pc.createOffer();
      if (pc.signalingState !== 'stable') return;
      await pc.setLocalDescription(offer);
      wsSend({ type: 'call.reneg', call_id: cur.id, kind: 'offer', sdp: offer.sdp });
    } catch { /* the next change retries */ }
  };
  pc.onconnectionstatechange = () => {
    if (!cur) return;
    const st = pc.connectionState;
    if (st === 'connected') {
      clearTimeout(cur.restartTimer);
      cur.restartTimer = null;
      if (!cur.connectedAt) {
        // Android: route the call audio (video calls start on the loudspeaker, voice calls on the earpiece)
        try {
          if (window.SuhbatNative?.callAudio) {
            cur.speaker = !!cur.video;
            window.SuhbatNative.callAudio(true, cur.speaker);
            renderControls();
          }
        } catch { /* ignore */ }
        cur.connectedAt = Date.now();
        cur.timer = setInterval(tick, 500);
        startStats();
      }
      setStatus('');
      ui?.root.classList.add('live');
    } else if (st === 'disconnected' || st === 'failed') {
      setStatus(t('call.reconnecting'));
      scheduleRestart(st === 'failed' ? 0 : 3000);
    }
  };
  return pc;
}

/** Network changed / link dropped: re-gather candidates without ending the call. */
function scheduleRestart(delay) {
  if (!cur || cur.restartTimer || cur.state === 'incoming') return;
  cur.restartTimer = setTimeout(async () => {
    if (!cur) return;
    cur.restartTimer = null;
    if (cur.pc.connectionState === 'connected') return;
    cur.restarts = (cur.restarts || 0) + 1;
    if (cur.restarts > 6) {
      const never = !cur.connectedAt;
      if (never) wsSend({ type: 'call.stats', call_id: cur.id, stats: { failed: true, relay: false, duration: 0 } }); // lets the admin see that media never connected
      toast(never ? t('call.no_route') : t('call.lost'), never ? 8000 : 4000);
      hangup('hangup');
      return;
    }
    if (cur.summary) cur.summary.reconnects += 1;
    if (cur.role === 'caller') {
      try {
        cur.pc.restartIce();
        const offer = await cur.pc.createOffer({ iceRestart: true });
        await cur.pc.setLocalDescription(offer);
        wsSend({ type: 'call.reneg', call_id: cur.id, kind: 'offer', sdp: offer.sdp });
      } catch { /* next attempt */ }
    } else {
      wsSend({ type: 'call.reneg', call_id: cur.id, kind: 'restart' });
    }
    if (cur.pc.connectionState !== 'connected') scheduleRestart(5000);
  }, delay);
}
window.addEventListener('online', () => { if (cur?.connectedAt) scheduleRestart(300); });

function attachLocal(stream) {
  if (!ui) return;
  ui.local.srcObject = stream;
  ui.local.hidden = !cur.video;
}

function cleanup() {
  try { window.SuhbatNative?.callAudio?.(false, false); } catch { /* ignore */ }
  ringStop();
  if (cur) {
    clearInterval(cur.timer);
    clearInterval(cur.statsTimer);
    clearTimeout(cur.restartTimer);
    if (cur.summary && cur.connectedAt) {
      const dur = Math.round((Date.now() - cur.connectedAt) / 1000);
      wsSend({ type: 'call.stats', call_id: cur.id, stats: cur.summary.toJSON(dur) });
    }
    try { cur.pc?.close(); } catch { /* ignore */ }
    cur.local?.getTracks().forEach((tr) => tr.stop());
  }
  ui?.root.remove();
  ui = null;
  cur = null;
  fire('call-state');
}

// ---------------------------------------------------------------- public API
export async function startCall(chatId, video = false) {
  const chat = S.chats.get(chatId);
  if (!chat || chat.type !== 'direct' || chat.saved) return toast(t('call.group'));
  if (!chat.can_post) return toast(t('chat.blocked_by_me'));
  if (cur) return toast(t('call.busy'));
  if (S.net !== 'online') return toast(t('net.offline'));
  const stream = await media(video);
  if (!stream) return undefined;
  const hasVideo = stream.getVideoTracks().length > 0;
  await loadIce();
  const devs = await listDevices();
  cur = {
    id: uuid().replaceAll('-', ''), chatId, peer: chat.peer, video: hasVideo, state: 'calling', role: 'caller', local: stream, pc: null,
    pendingIce: [], muted: false, camOff: false, cams: devs.cams,
  };
  mountCallUi(chat.peer);
  attachLocal(stream);
  setStatus(t('call.calling'));
  try {
    const pc = newPc();
    cur.pc = pc;
    stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
    preferCodecs(pc);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const ok = wsSend({ type: 'call.invite', chat_id: chatId, call_id: cur.id, video: hasVideo, sdp: offer.sdp });
    if (!ok) throw new Error('offline');
  } catch {
    toast(t('call.failed'));
    cleanup();
  }
  fire('call-state');
  return undefined;
}

async function acceptIncoming() {
  if (!cur || cur.state !== 'incoming') return;
  ringStop();
  const stream = await media(cur.video);
  if (!stream) { hangup('decline'); return; }
  await loadIce();
  cur.local = stream;
  cur.role = 'callee';
  cur.cams = (await listDevices()).cams;
  cur.state = 'connecting';
  attachLocal(stream);
  setStatus(t('call.connecting'));
  renderControls();
  try {
    const pc = newPc();
    cur.pc = pc;
    // the offer first: our tracks then attach to the transceivers it created (audio AND video)
    await pc.setRemoteDescription({ type: 'offer', sdp: cur.offer });
    stream.getTracks().forEach((tr) => pc.addTrack(tr, stream));
    preferCodecs(pc);
    for (const c of cur.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    wsSend({ type: 'call.answer', call_id: cur.id, sdp: answer.sdp });
  } catch {
    toast(t('call.failed'));
    hangup('hangup');
  }
}

function hangup(reason) {
  if (!cur) return;
  const id = cur.id;
  try { wsSend({ type: 'call.end', call_id: id, reason }); } catch { /* socket gone: still close the screen */ }
  try { cleanup(); } catch { ui?.root.remove(); ui = null; cur = null; }
}

const END_TEXT = {
  declined: 'call.declined', busy: 'call.busy', missed: 'call.no_answer', cancelled: 'call.cancelled', blocked: 'call.blocked',
  forbidden: 'call.failed', unavailable: 'call.no_answer',
};

/** Called by main.js for every call.* WebSocket event. */
export async function handleCallEvent(ev) {
  switch (ev.type) {
    case 'call.incoming': {
      if (cur) { wsSend({ type: 'call.end', call_id: ev.call_id, reason: 'busy' }); return; }
      cur = { id: ev.call_id, chatId: ev.chat_id, peer: ev.from, video: !!ev.video, state: 'incoming', offer: ev.sdp, pendingIce: [], muted: false, camOff: false, pc: null, local: null };
      S.users.set(ev.from.id, ev.from);
      mountCallUi(ev.from);
      setStatus(ev.video ? t('call.incoming_video') : t('call.incoming'));
      ringStart(true);
      fire('call-state');
      if (document.visibilityState !== 'visible' && S.prefs.desktop && window.Notification?.permission === 'granted') {
        const n = new Notification(ev.from.name, { body: ev.video ? t('call.incoming_video') : t('call.incoming'), icon: '/icon.svg?v=2', tag: 'call' });
        n.onclick = () => { window.focus(); n.close(); };
      }
      break;
    }
    case 'call.ringing':
      if (cur?.id === ev.call_id) setStatus(ev.offline ? t('call.no_answer') : t('call.ringing'));
      break;
    case 'call.answered':
      if (cur?.id === ev.call_id && cur.pc) {
        cur.state = 'connecting';
        setStatus(t('call.connecting'));
        try {
          await cur.pc.setRemoteDescription({ type: 'answer', sdp: ev.sdp });
          for (const c of cur.pendingIce.splice(0)) await cur.pc.addIceCandidate(c).catch(() => {});
        } catch { hangup('hangup'); }
      }
      break;
    case 'call.ice':
      if (cur?.id === ev.call_id) {
        if (cur.pc?.remoteDescription) await cur.pc.addIceCandidate(ev.candidate).catch(() => {});
        else cur.pendingIce.push(ev.candidate);
      }
      break;
    case 'call.reneg':
      if (cur?.id !== ev.call_id || !cur.pc) break;
      try {
        if (ev.kind === 'restart' && cur.role === 'caller') {
          scheduleRestart(0);
        } else if (ev.kind === 'offer') {
          if (cur.pc.signalingState === 'have-local-offer') {
            // both sides offered at once: the callee yields (rolls back), the caller keeps its offer
            if (cur.role !== 'callee') break;
            await cur.pc.setLocalDescription({ type: 'rollback' });
          }
          await cur.pc.setRemoteDescription({ type: 'offer', sdp: ev.sdp });
          const answer = await cur.pc.createAnswer();
          await cur.pc.setLocalDescription(answer);
          wsSend({ type: 'call.reneg', call_id: cur.id, kind: 'answer', sdp: answer.sdp });
        } else if (ev.kind === 'answer') {
          await cur.pc.setRemoteDescription({ type: 'answer', sdp: ev.sdp });
        }
      } catch { /* the next restart attempt retries */ }
      break;
    case 'call.media':
      if (cur?.id === ev.call_id && ui) {
        ui.root.classList.toggle('rvoff', !ev.video);
        if (ev.video) { ui.root.classList.add('video'); cur.video = true; }
        ui.remote.classList.toggle('screen', !!ev.screen);
      }
      break;
    case 'call.resumed':
      if (cur?.id === ev.call_id) scheduleRestart(200);
      break;
    case 'call.state':
      // answered on another device of this account
      if (cur?.id === ev.call_id && cur.state === 'incoming' && !cur.local) cleanup();
      break;
    case 'call.ended':
      if (cur?.id === ev.call_id) {
        const key = END_TEXT[ev.reason];
        const wasIncoming = cur.state === 'incoming';
        cleanup();
        if (key && !(wasIncoming && ev.reason === 'missed')) toast(t(key));
        else if (ev.reason === 'ended' && ev.duration) toast(`${t('call.ended')} · ${formatDuration(ev.duration)}`);
      } else if (!cur && END_TEXT[ev.reason]) {
        toast(t(END_TEXT[ev.reason]));
      }
      break;
    default:
  }
}

export function chatForCalls(chatId) {
  const c = S.chats.get(chatId);
  return !!c && c.type === 'direct' && !c.saved;
}

// ---------------------------------------------------------------- pre-call check (Settings)
export function openCallTest() {
  const video = h('video', { class: 'test-video', autoplay: true, muted: true, playsInline: true });
  const meter = h('div', { class: 'meter' }, h('i'));
  const info = h('div', { class: 'muted', role: 'status' });
  const body = h('div', null);
  const m = modal({ title: t('call.test_title'), body: [body], className: 'call-test' });
  let stream = null;
  let ctxAudio = null;
  let raf = 0;

  const stop = () => {
    cancelAnimationFrame(raf);
    stream?.getTracks().forEach((tr) => tr.stop());
    ctxAudio?.close().catch(() => {});
    stream = null;
  };
  const origClose = m.close;
  m.close = () => { stop(); origClose(); };

  async function start() {
    stop();
    info.textContent = t('call.test_requesting');
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints(), video: videoConstraints() });
    } catch {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints() }); } catch {
        info.textContent = window.isSecureContext ? t('call.no_media') : t('call.insecure');
        return;
      }
    }
    video.srcObject = stream;
    video.hidden = stream.getVideoTracks().length === 0;
    const dev = await listDevices();
    info.textContent = `${t('call.test_ok')} · ${t('call.microphone')}: ${dev.mics.length} · ${t('call.camera')}: ${dev.cams.length}`;
    ctxAudio = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctxAudio.createMediaStreamSource(stream);
    const an = ctxAudio.createAnalyser();
    an.fftSize = 512;
    src.connect(an);
    const buf = new Uint8Array(an.fftSize);
    const loop = () => {
      an.getByteTimeDomainData(buf);
      let peak = 0;
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      meter.firstChild.style.width = `${Math.min(100, Math.round((peak / 128) * 160))}%`;
      raf = requestAnimationFrame(loop);
    };
    loop();
  }

  function playTone() {
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ac.createOscillator();
    const gain = ac.createGain();
    const dest = ac.createMediaStreamDestination();
    osc.frequency.value = 523;
    gain.gain.value = 0.18;
    osc.connect(gain).connect(dest);
    const a = new Audio();
    a.srcObject = dest.stream;
    const go = async () => {
      if (S.prefs.spkId && a.setSinkId) await a.setSinkId(S.prefs.spkId).catch(() => {});
      await a.play().catch(() => {});
      osc.start();
      setTimeout(() => { osc.stop(); a.pause(); ac.close(); }, 900);
    };
    go();
  }

  (async () => {
    clear(body).append(
      h('p', { class: 'muted' }, t('call.test_hint')),
      video, h('div', { class: 'field' }, h('span', null, t('call.test_mic_level')), meter), info,
      h('div', { class: 'row', style: { margin: '10px 0' } },
        h('button', { class: 'btn', type: 'button', onclick: start }, t('call.test_start')),
        h('button', { class: 'btn secondary', type: 'button', onclick: playTone }, t('call.test_tone'))),
      ...(await devicePanelNodes()),
    );
  })();
}

export async function callSettingsSection() {
  return [
    h('h3', null, t('call.settings')),
    h('button', { class: 'btn secondary', type: 'button', style: { width: '100%', marginBottom: '10px' }, onclick: openCallTest }, `🎙 ${t('call.test_title')}`),
    ...(await devicePanelNodes()),
  ];
}

// Diagnostics hook for self-tests (read-only, exposes technical numbers only).
window.__suhbatCall = {
  async snapshot() {
    if (!cur?.pc) return null;
    const rep = await cur.pc.getStats();
    const out = { state: cur.pc.connectionState, level: cur.level || null, senders: [], receivers: [] };
    rep.forEach((r) => {
      if (r.type === 'outbound-rtp') out.senders.push({ kind: r.kind, bytes: r.bytesSent, frames: r.framesEncoded, w: r.frameWidth, h: r.frameHeight, codec: r.codecId });
      if (r.type === 'inbound-rtp') out.receivers.push({ kind: r.kind, bytes: r.bytesReceived, frames: r.framesDecoded, w: r.frameWidth, h: r.frameHeight, lost: r.packetsLost });
    });
    out.transceivers = cur.pc.getTransceivers().map((t) => ({ mid: t.mid, kind: t.receiver.track.kind, dir: t.direction, cur: t.currentDirection }));
    return out;
  },
};
