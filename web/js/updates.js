import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { toast } from './ui.js';
import { icon } from './icons.js';

// Updates without reinstalling:
//  * the interface itself is served by your server, so a new build is picked up by a reload;
//  * Windows/Linux AppImage apps update themselves through the desktop shell (electron-updater);
//  * Android downloads the newer APK from the server and Android installs it over the old one.
const UA = navigator.userAgent;
export const shell = /SuhbatShell\/(\w+)/.exec(UA)?.[1] || null;         // desktop | mobile | null
export const appVersion = (() => {
  const nat = window.SuhbatNative;
  try {
    const v = nat?.appVersion?.();
    if (v) return v; // the real value from the installed package
  } catch { /* fall through */ }
  if (nat) {
    // builds 0.2.5 - 0.2.10 reported a stale version in the user-agent: guess it from the features they have
    if (nat.installUpdate) return '0.2.8';
    if (nat.openFile) return '0.2.6';
    return '0.2.5';
  }
  return /SuhbatApp\/([\d.]+)/.exec(UA)?.[1] || null;
})();
const bridge = window.suhbatShell;                                          // present in the desktop app

let banner = null;
let pendingReload = false;

function cmp(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
  return 0;
}

/** Slim one-line notice at the top (native app updates only, which the OS has to confirm). */
function showBanner(text, actionLabel, action) {
  banner?.remove();
  const close = () => { banner?.remove(); banner = null; };
  banner = h('div', { class: 'update-snack', role: 'status' },
    icon('download', 18),
    h('span', { class: 'us-text' }, text),
    h('button', { class: 'us-btn', type: 'button', onclick: () => { action(); close(); } }, actionLabel),
    h('button', { class: 'us-x', type: 'button', 'aria-label': t('update.later'), onclick: close }, icon('close', 14)));
  document.body.append(banner);
  setTimeout(() => { if (banner && banner.isConnected) close(); }, 15_000);
}

/**
 * The interface is served by the server, so a new build only needs a reload. Do it by itself, unnoticed:
 * right away while the app is in the background, otherwise as soon as it is idle (nothing typed, no call, no dialog).
 */
let updateWaiting = false;
let lastInput = Date.now();
for (const ev of ['keydown', 'pointerdown', 'touchstart']) window.addEventListener(ev, () => { lastInput = Date.now(); }, { passive: true, capture: true });

function safeToReload() {
  if (document.querySelector('.call-overlay, .gcall, .recbar:not([hidden])')) return false;
  if (document.querySelector('.composer.recording')) return false;
  if (document.querySelector('#modal-root .overlay')) return false;
  const ta = document.querySelector('.composer textarea');
  if (ta && ta.value.trim()) return false;
  return true;
}

function maybeAutoReload() {
  if (!updateWaiting || pendingReload) return;
  if (document.visibilityState === 'hidden') { if (safeToReload()) applyWebUpdate(); return; }
  if (Date.now() - lastInput > 20_000 && safeToReload()) applyWebUpdate();
}
setInterval(maybeAutoReload, 5000);
document.addEventListener('visibilitychange', maybeAutoReload);

function applyWebUpdate() {
  pendingReload = true;
  // drop caches of the app shell, then reload
  const done = () => location.reload();
  if (window.caches) caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('suhbat-shell')).map((k) => caches.delete(k)))).finally(done);
  else done();
}

/** Compare the running client with the server. Returns { web, app, apps }. */
export async function checkForUpdate({ build, silent = false } = {}) {
  let info = null;
  try {
    info = await api('GET', '/api/version');
  } catch { return null; }
  const serverBuild = build || info.build;
  if (!S.build) S.build = serverBuild; // first look: this is what we are running
  const webNew = serverBuild !== S.build;

  const key = shell === 'mobile' ? 'android' : 'windows';
  const remote = info.apps?.[key];
  const appNew = !!(remote && appVersion && cmp(remote.version, appVersion) > 0);

  if (webNew && !pendingReload) {
    if (silent) { updateWaiting = true; maybeAutoReload(); }
  } else if (appNew && silent && shell === 'mobile') {
    if (nativeUpdater()) autoDownload(remote);
    else showBanner(t('update.app_available', { v: remote.version }), t('update.via_tg'), () => updateViaTelegram());
  }
  return { webNew, appNew, remote, serverBuild, info };
}

// ---- Android app: the APK downloads by itself, Android only asks to confirm the installation
const nativeUpdater = () => (window.SuhbatNative?.downloadUpdate ? window.SuhbatNative : null);
const nativeState = () => { try { return JSON.parse(nativeUpdater().updateState()); } catch { return { state: 'idle' }; } };
let autoStarted = '';

function autoDownload(remote) {
  const nat = nativeUpdater();
  if (!nat || autoStarted === remote.version) return;
  autoStarted = remote.version;
  nat.downloadUpdate(new URL(`/downloads/${encodeURIComponent(remote.file)}`, location.origin).href, remote.version);
  const timer = setInterval(() => {
    const s = nativeState();
    if (s.state === 'ready') {
      clearInterval(timer); // Android installs it by itself when the app is in the background
    } else if (s.state === 'error' || s.state === 'idle') {
      clearInterval(timer);
      autoStarted = '';
    }
  }, 2000);
  setTimeout(() => clearInterval(timer), 15 * 60_000);
}

/** Old Android builds cannot download by themselves: the Telegram bot sends them the new APK file. */
async function updateViaTelegram() {
  let bot = null;
  try { bot = (await api('GET', '/api/auth/providers')).telegram?.bot || null; } catch { /* offline */ }
  if (bot) { location.href = `tg://resolve?domain=${bot}&start=update`; return; }
  toast(t('update.tg_missing'), 6000);
}

export function initUpdates() {
  // the build that was current when this page loaded
  api('GET', '/api/version').then((i) => { S.build = i.build; }).catch(() => {});
  setInterval(() => checkForUpdate({ silent: true }), 10 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate({ silent: true });
  });
  if (bridge?.onUpdate) {
    // desktop app: the update downloads by itself; a downloaded one is offered once, one click restarts into it
    let offered = '';
    bridge.onUpdate((e) => {
      if (e?.state === 'downloaded' && offered !== e.version) {
        offered = e.version;
        showBanner(t('update.desktop_ready', { v: e.version }), t('update.restart'), () => bridge.installUpdate());
      }
    });
  }
}

/** Settings block: version + "Check for updates". */
export function updatesSection() {
  const status = h('div', { class: 'muted', role: 'status', style: { margin: '8px 0' } });
  const actions = h('div', { class: 'row' });
  const btn = h('button', { class: 'btn secondary', type: 'button' }, t('update.check'));
  const lines = [
    `${t('update.web')}: ${S.build || '—'}`,
    appVersion ? `${t('update.app')}: ${appVersion}` : null,
  ].filter(Boolean).join(' · ');

  btn.onclick = async () => {
    btn.disabled = true;
    clear(actions);
    status.textContent = t('update.checking');
    try {
      // desktop shell: ask electron-updater first
      if (bridge?.checkUpdate) {
        const r = await bridge.checkUpdate();
        if (r?.state === 'available' || r?.state === 'downloaded') {
          // one click: download, then install and restart by itself (like Telegram Desktop)
          const install = () => { status.textContent = t('update.starting'); bridge.installUpdate(); };
          if (r.state === 'downloaded') { install(); return; }
          status.textContent = t('update.downloading', { v: r.version, p: 0 });
          bridge.onUpdate?.((e) => {
            if (e?.state === 'downloaded') install();
            else if (e?.state === 'available' && typeof e.percent === 'number') status.textContent = t('update.downloading', { v: r.version, p: e.percent });
            else if (e?.state === 'error') { status.textContent = `${t('update.failed')}: ${e.message || ''}`; btn.disabled = false; }
          });
          return;
        }
      }
      const r = await checkForUpdate();
      if (!r) { status.textContent = t('net.offline'); btn.disabled = false; return; }
      if (r.webNew) {
        status.textContent = t('update.web_available');
        actions.append(h('button', { class: 'btn', type: 'button', onclick: applyWebUpdate }, t('update.apply')));
      } else if (r.appNew && shell === 'mobile' && nativeUpdater()) {
        const nat = nativeUpdater();
        autoStarted = r.remote.version;
        nat.downloadUpdate(new URL(`/downloads/${encodeURIComponent(r.remote.file)}`, location.origin).href, r.remote.version);
        const paint = () => {
          const s = nativeState();
          clear(actions);
          if (s.state === 'ready') {
            status.textContent = t('update.ready', { v: s.version });
            actions.append(h('button', { class: 'btn', type: 'button', onclick: () => {
              status.textContent = t('update.starting');
              nat.installUpdate();
              setTimeout(() => { const e = nativeState().error; if (e) status.textContent = `${t('update.failed')}: ${e}`; else paint(); }, 4000);
            } }, t('update.install')));
            return;
          }
          if (s.state === 'error') { status.textContent = t('err.generic'); return; }
          status.textContent = t('update.downloading', { v: r.remote.version, p: s.percent || 0 });
          setTimeout(paint, 1000);
        };
        paint();
      } else if (r.appNew && shell === 'mobile') {
        status.textContent = t('update.app_available', { v: r.remote.version });
        actions.append(h('button', { class: 'btn', type: 'button', onclick: () => updateViaTelegram() }, t('update.via_tg')),
          h('p', { class: 'muted' }, t('update.via_tg_hint')));
      } else if (r.appNew) {
        status.textContent = t('update.app_available', { v: r.remote.version });
        actions.append(h('a', { class: 'btn', href: '/download' }, t('update.download')));
      } else {
        status.textContent = t('update.latest');
      }
    } catch {
      status.textContent = t('err.generic');
    }
    btn.disabled = false;
  };

  return [
    h('h3', null, t('update.title')),
    h('div', { class: 'muted' }, lines),
    status,
    h('div', { class: 'row' }, btn, actions),
  ];
}

if (!window.__suhbatUpdateCss) {
  window.__suhbatUpdateCss = true;
}
void toast;
