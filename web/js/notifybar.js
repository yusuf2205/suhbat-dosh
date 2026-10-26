// A bar on top of the chat list while this device cannot yet notify: notifications are off by default in browsers, blocked on a refusal,
// impossible on an iPhone until the site is on the Home Screen, and cut off by the battery saver on many Android phones.
// Each case says what to do and offers the button; the bar goes away by itself once it is fixed, and can be postponed.
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { enablePush, pushEnabled, pushSupported } from './push.js';
import { toast } from './ui.js';
import { api } from './net.js';

const KEY = 'suhbat.notifybar';
const WEEK = 7 * 86400_000;
const snoozed = () => { try { return Date.now() < Number(localStorage.getItem(KEY) || 0); } catch { return false; } };
const snooze = () => { try { localStorage.setItem(KEY, String(Date.now() + WEEK)); } catch { /* private mode */ } };

const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const standalone = () => !!navigator.standalone || matchMedia('(display-mode: standalone)').matches;

/** What is wrong on this device, or null: { text, action?: { label, run } } */
async function problem() {
  const nat = window.SuhbatNative;
  if (nat) {
    // the Android app keeps its own connection; the battery saver is what stops it on many phones
    if (nat.isBatteryUnrestricted && nat.openBatterySettings && !nat.isBatteryUnrestricted()) return { text: t('nb.battery'), action: { label: t('nb.battery_btn'), run: () => nat.openBatterySettings() } };
    return null;
  }
  if (isIos() && !standalone()) return { text: t('nb.ios') };
  if (!pushSupported()) return null;
  if (Notification.permission === 'denied') return { text: t('nb.denied') };
  if (Notification.permission === 'default') return { text: t('nb.ask'), action: { label: t('nb.ask_btn'), run: 'enable' } };
  if (!(await pushEnabled())) {
    const r = await enablePush();   // allowed already, only the subscription is missing: no question to ask
    return r === 'ok' ? null : { text: t('nb.error'), action: { label: t('nb.retry'), run: 'enable' } };
  }
  return null;
}

export function notifyBar() {
  const bar = h('div', { class: 'notify-bar', role: 'status', hidden: true });
  async function update() {
    let p = null;
    try { p = snoozed() ? null : await problem(); } catch { p = null; }
    if (!p) { bar.hidden = true; return; }
    const act = p.action
      ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
        if (p.action.run === 'enable') {
          const r = await enablePush();
          if (r === 'ok') {
            toast(t('nb.on'), 4000);
            api('POST', '/api/push/test').catch(() => {});
          } else toast(r === 'denied' ? t('st.bg_denied') : t('err.generic'), 5000);
          update();
        } else p.action.run();
      } }, p.action.label)
      : null;
    clear(bar).append(h('span', { class: 'notify-text' }, `\u{1F514} ${p.text}`), act, h('button', { class: 'btn link', type: 'button', onclick: () => { snooze(); bar.hidden = true; } }, t('nb.later')));
    bar.hidden = false;
  }
  update();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') update(); });
  return bar;
}
