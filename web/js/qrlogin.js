// Sign in by QR code. The sign-in screen shows a code; a phone that is already signed in scans it (in the app's scanner or with
// the phone camera) and confirms; the screen then signs in as the same account, and everything comes from the server as usual.
import { h } from './dom.js';
import { t, errText } from './i18n.js';
import { api } from './net.js';
import { qrCanvas } from './qr.js';
import { modal, toast } from './ui.js';

const PREFIX = '/#/qr/';

export const qrLink = (token) => `${location.origin}${PREFIX}${token}`;

/** The token inside a scanned or opened QR-login link, or null. */
export function qrTokenFrom(text) {
  const m = /#\/qr\/([A-Za-z0-9_-]{10,64})\s*$/.exec(String(text || ''));
  return m ? m[1] : null;
}

/** The code with its waiting loop. Returns { node, stop }; onDone(user) when a phone has approved it. */
export function qrLoginPanel(onDone) {
  const box = h('div', { class: 'qrlogin-box' });
  const status = h('p', { class: 'muted qrlogin-status', role: 'status' });
  let alive = true;
  let timer = 0;

  async function fresh() {
    box.replaceChildren(h('div', { class: 'qrlogin-wait' }, t('viewer.loading')));
    status.textContent = '';
    let s;
    try { s = await api('POST', '/api/auth/qr/start'); } catch (e) { status.textContent = e.status === 0 ? t('net.offline') : errText(e.code); box.replaceChildren(retry()); return; }
    if (!alive) return;
    box.replaceChildren(qrCanvas(qrLink(s.token), 240));
    status.textContent = t('qrl.waiting');
    const until = Date.now() + s.expires_in - 3000;
    const tick = async () => {
      if (!alive) return;
      if (Date.now() > until) { box.replaceChildren(retry()); status.textContent = t('qrl.expired'); return; }
      try {
        const r = await api('GET', `/api/auth/qr/poll?token=${encodeURIComponent(s.token)}&secret=${encodeURIComponent(s.secret)}`);
        if (r.status === 'approved') { alive = false; onDone(r.user); return; }
        if (r.status === 'denied') { box.replaceChildren(retry()); status.textContent = errText(r.reason); return; }
        if (r.status === 'expired') { box.replaceChildren(retry()); status.textContent = t('qrl.expired'); return; }
      } catch { /* a short network gap: the next tick tries again */ }
      timer = setTimeout(tick, 2000);
    };
    timer = setTimeout(tick, 1500);
  }
  const retry = () => h('button', { class: 'btn secondary', type: 'button', onclick: () => fresh() }, t('qrl.refresh'));

  fresh();
  return { node: h('div', { class: 'qrlogin' }, box, status, h('ol', { class: 'qrlogin-steps' }, h('li', null, t('qrl.step1')), h('li', null, t('qrl.step2')), h('li', null, t('qrl.step3')))), stop() { alive = false; clearTimeout(timer); } };
}

/** "Edge on Windows" out of a User-Agent string. */
function deviceName(ua) {
  const s = String(ua || '');
  const app = /SuhbatShell\//.test(s) ? 'Suhbat-dosh' : /Edg\//.test(s) ? 'Edge' : /OPR\//.test(s) ? 'Opera' : /Firefox\//.test(s) ? 'Firefox' : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : '';
  const os = /Windows/.test(s) ? 'Windows' : /Android/.test(s) ? 'Android' : /iPhone|iPad/.test(s) ? 'iOS' : /Mac OS X/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return [app, os].filter(Boolean).join(' · ') || '—';
}

/** On the signed-in phone: ask before letting the other screen in. */
export async function approveQrLogin(token) {
  let info;
  try { info = await api('GET', `/api/auth/qr/info?token=${encodeURIComponent(token)}`); } catch (e) { toast(e.code === 'qr_expired' || e.status === 404 ? t('qrl.expired') : errText(e.code)); return; }
  const dev = deviceName(info.device);
  const m = modal({
    title: t('qrl.approve_title'),
    body: [
      h('p', null, t('qrl.approve_text')),
      h('div', { class: 'qrlogin-dev' }, h('b', null, dev), h('small', { class: 'muted' }, `IP ${info.ip || '—'}`)),
      h('p', { class: 'muted' }, t('qrl.approve_warn')),
      h('div', { class: 'row', style: { gap: '8px', marginTop: '8px' } },
        h('button', { class: 'btn secondary', type: 'button', style: { flex: 1 }, onclick: () => m.close() }, t('common.cancel')),
        h('button', { class: 'btn', type: 'button', style: { flex: 1 }, onclick: async (e) => {
          e.currentTarget.disabled = true;
          try { await api('POST', '/api/auth/qr/approve', { token }); toast(t('qrl.approved')); m.close(); } catch (ex) { toast(ex.code === 'qr_expired' ? t('qrl.expired') : errText(ex.code)); m.close(); }
        } }, t('qrl.allow'))),
    ],
  });
}
