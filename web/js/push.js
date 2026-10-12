// Background notifications for the browser / installed web app (Web Push). The native apps keep their own connection.
import { api } from './net.js';

const inShell = /SuhbatShell\//.test(navigator.userAgent);

export const pushSupported = () => !inShell && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function registration() {
  try {
    return (await navigator.serviceWorker.getRegistration()) || (await navigator.serviceWorker.register('/sw.js'));
  } catch { return null; }
}

export async function pushEnabled() {
  if (!pushSupported() || Notification.permission !== 'granted') return false;
  const reg = await registration();
  return !!(await reg?.pushManager.getSubscription());
}

const toKey = (b64) => {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

/** Returns 'ok' | 'denied' | 'unsupported' | 'error'. */
export async function enablePush() {
  if (!pushSupported()) return 'unsupported';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'denied';
  try {
    const reg = await navigator.serviceWorker.ready;
    const { key } = await api('GET', '/api/push/key');
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(key) });
    await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
    return 'ok';
  } catch { return 'error'; }
}

export async function disablePush() {
  try {
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) {
      await api('POST', '/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
      await sub.unsubscribe();
    }
  } catch { /* ignore */ }
}

/** Keep the server's copy of the subscription fresh (it can change without notice). */
export async function syncPush() {
  try {
    if (!(await pushEnabled())) return;
    const reg = await registration();
    const sub = await reg?.pushManager.getSubscription();
    if (sub) await api('POST', '/api/push/subscribe', { subscription: sub.toJSON() });
  } catch { /* offline */ }
}
