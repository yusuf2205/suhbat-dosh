// App lock: a PIN (and, where the device offers it, fingerprint / Face ID) that is asked on start and after the app
// has been in the background for a chosen time. It is a gate on this device only: the PIN never leaves it.
import { h, clear } from './dom.js';
import { t } from './i18n.js';
import { icon } from './icons.js';
import { modal, toast } from './ui.js';

const KEY = 'suhbat.lock';
const enc = new TextEncoder();
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function read() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch { return null; } }
function write(v) { try { if (v) localStorage.setItem(KEY, JSON.stringify(v)); else localStorage.removeItem(KEY); } catch { /* storage blocked */ } }

async function hashPin(pin, salt) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 150000 }, key, 256));
}

export const lockEnabled = () => !!read()?.hash;
export const lockTimeout = () => read()?.timeout ?? 60;

export async function bioAvailable() {
  try {
    return !!(window.PublicKeyCredential && (await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()));
  } catch { return false; }
}

export async function setPin(pin, timeout = 60) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prev = read();
  write({ salt: b64(salt), hash: await hashPin(pin, salt), timeout, bio: prev?.bio || null });
}
export const setTimeoutSec = (s) => { const v = read(); if (v) write({ ...v, timeout: s }); };
export const disableLock = () => write(null);

async function checkPin(pin) {
  const v = read();
  return !!v && (await hashPin(pin, unb64(v.salt))) === v.hash;
}

export async function enableBio() {
  const v = read();
  if (!v) return false;
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { name: 'Suhbat-dosh', id: location.hostname },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'suhbat-lock', displayName: 'Suhbat-dosh' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
        timeout: 60000,
      },
    });
    if (!cred) return false;
    write({ ...v, bio: b64(cred.rawId) });
    return true;
  } catch { return false; }
}
export const disableBio = () => { const v = read(); if (v) write({ ...v, bio: null }); };
export const bioOn = () => !!read()?.bio;

async function bioUnlock() {
  const v = read();
  if (!v?.bio) return false;
  try {
    const a = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: unb64(v.bio) }], userVerification: 'required', timeout: 60000,
      },
    });
    return !!a;
  } catch { return false; }
}

// ---------------------------------------------------------------- the lock screen
let screen = null;
const waiting = [];

/** Resolves when the app is unlocked (at once when it is not locked). */
export function whenUnlocked() { return screen ? new Promise((r) => { waiting.push(r); }) : Promise.resolve(); }

function done() {
  screen?.remove();
  screen = null;
  document.documentElement.classList.remove('locked');
  for (const r of waiting.splice(0)) r();
}

export function showLock() {
  if (screen || !lockEnabled()) return;
  let pin = '';
  let fails = 0;
  let until = 0;
  let timer = 0;
  const dots = h('div', { class: 'lock-dots', 'aria-hidden': 'true' });
  const msg = h('div', { class: 'lock-msg', role: 'alert' });
  const forgot = h('button', {
    class: 'btn link', type: 'button', hidden: true,
    onclick: () => {
      if (!confirm(t('lock.forgot_confirm'))) return;
      disableLock();
      document.dispatchEvent(new CustomEvent('suhbat:logout-local'));
      done();
    },
  }, t('lock.forgot'));
  const paint = () => clear(dots).append(...Array.from({ length: 6 }, (_, i) => h('i', { class: i < pin.length ? 'on' : '' })));
  const attempt = async () => {
    if (Date.now() < until) { msg.textContent = t('lock.wait', { s: Math.ceil((until - Date.now()) / 1000) }); pin = ''; paint(); return; }
    if (await checkPin(pin)) { done(); return; }
    fails += 1;
    pin = '';
    paint();
    msg.textContent = t('lock.wrong');
    screen?.classList.add('shake');
    setTimeout(() => screen?.classList.remove('shake'), 400);
    if (fails >= 5) until = Date.now() + Math.min(300, 30 * (fails - 4)) * 1000;
    if (fails >= 8) forgot.hidden = false;
  };
  const press = (d) => {
    if (pin.length >= 6) return;
    pin += d;
    paint();
    msg.textContent = '';
    clearTimeout(timer);
    if (pin.length >= 4) timer = setTimeout(() => { if (pin.length >= 4) attempt(); }, pin.length === 6 ? 0 : 450);
  };
  const key = (label, fn) => h('button', { class: 'lock-key', type: 'button', onclick: fn }, label);
  const pad = h('div', { class: 'lock-pad' },
    ...['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => key(d, () => press(d))),
    read()?.bio
      ? h('button', { class: 'lock-key alt', type: 'button', 'aria-label': t('lock.bio'), onclick: async () => { if (await bioUnlock()) done(); } }, icon('lock', 24))
      : h('span'),
    key('0', () => press('0')),
    h('button', { class: 'lock-key alt', type: 'button', 'aria-label': t('common.delete'), onclick: () => { pin = pin.slice(0, -1); paint(); } }, '⌫'));
  screen = h('div', { class: 'lock-screen', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('lock.title') },
    h('div', { class: 'lock-box' }, h('div', { class: 'lock-ico' }, icon('lock', 34)), h('h2', null, t('lock.title')), dots, msg, pad, forgot));
  document.body.append(screen);
  document.documentElement.classList.add('locked');
  paint();
  // fingerprint / face right away when it is set up
  if (read()?.bio) setTimeout(async () => { if (screen && (await bioUnlock())) done(); }, 250);
}

// lock again after the app has been in the background for the chosen time
let hiddenAt = 0;
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && lockEnabled() && Date.now() - hiddenAt >= lockTimeout() * 1000) showLock();
});

// ---------------------------------------------------------------- settings dialogs
function askPin(title, hint) {
  return new Promise((resolve) => {
    const input = h('input', { class: 'input lock-input', type: 'password', inputMode: 'numeric', pattern: '[0-9]*', maxLength: 6, autocomplete: 'off', 'aria-label': title });
    let m = null;
    let answered = false;
    const ok = h('button', {
      class: 'btn', type: 'button',
      onclick: () => {
        if (!/^\d{4,6}$/.test(input.value)) { toast(t('lock.pin_rule')); return; }
        answered = true;
        const v = input.value;
        m.close();
        resolve(v);
      },
    }, t('settings.save'));
    m = modal({
      title,
      onClose: () => { if (!answered) resolve(null); },
      body: [h('p', { class: 'muted' }, hint || t('lock.pin_rule')), input, h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } }, ok)],
    });
    setTimeout(() => input.focus(), 50);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') ok.click(); });
  });
}

export async function createPin() {
  const a = await askPin(t('lock.new_pin'));
  if (!a) return false;
  const b = await askPin(t('lock.repeat_pin'));
  if (b !== a) { if (b !== null) toast(t('lock.mismatch')); return false; }
  await setPin(a, lockTimeout());
  return true;
}

export async function confirmPin() {
  const p = await askPin(t('lock.enter_pin'));
  return p ? checkPin(p) : false;
}
