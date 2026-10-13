import { h, clear } from './dom.js';
import { icon } from './icons.js';
import { t, errText, LANGS, getLang } from './i18n.js';
import { S, fire, savePrefs } from './state.js';
import { api } from './net.js';

/** Invitation code from a link like /?invite=CODE (kept for the sign-up that follows). */
function inviteCode() {
  try {
    const c = new URLSearchParams(location.search).get('invite');
    if (c) sessionStorage.setItem('suhbat.invite', c.slice(0, 64));
    return sessionStorage.getItem('suhbat.invite') || undefined;
  } catch { return undefined; }
}

export async function showLogin(root, { onLoggedIn }) {
  let providers = { telegram: { enabled: false }, phone_code: true };
  try { providers = await api('GET', '/api/auth/providers'); } catch { /* offline: fall back to phone form */ }

  let phone = '';
  let step = providers.telegram?.enabled || providers.email ? 'home' : 'phone'; // home | tg | email | emailcode | emailname | phone | code | name
  let email = '';
  let devCode = null;
  let pendingCode = '';
  let tgTimer = null;
  let tgLogin = null;

  const card = h('div', { class: 'auth-card' });
  const langSel = h('select', { class: 'input', 'aria-label': 'Language', onchange: () => { S.prefs.lang = langSel.value; savePrefs(); fire('relang'); } },
    Object.entries(LANGS).map(([k, v]) => h('option', { value: k, selected: getLang() === k }, v)));

  let pollOnce = null;
  const onVisible = () => { if (!document.hidden && tgTimer && pollOnce) pollOnce(); };
  const stopTg = () => { clearInterval(tgTimer); tgTimer = null; document.removeEventListener('visibilitychange', onVisible); };
  const isMobileShell = navigator.userAgent.includes('SuhbatShell/mobile');

  async function startTelegram() {
    const err = card.querySelector('.err');
    if (err) err.textContent = '';
    try {
      tgLogin = await api('POST', '/api/auth/telegram/start', { invite: inviteCode() });
    } catch (e) {
      if (err) err.textContent = e.status === 0 ? t('net.offline') : errText(e.code);
      return;
    }
    step = 'tg';
    draw();
    if (isMobileShell) location.href = tgLogin.app_url;           // the app hands tg: to Telegram (falls back to t.me)
    else if (navigator.userAgent.includes('SuhbatShell/')) window.open(tgLogin.app_url, '_blank', 'noopener');
    else window.open(tgLogin.url, '_blank', 'noopener');
    const deadline = Date.now() + tgLogin.expires_in * 1000;
    stopTg();
    const myToken = tgLogin.token;
    let polling = false;
    // already signed in (e.g. the answer of an earlier poll was lost, or another tab finished the login)?
    const alreadyIn = async () => {
      try { const me = await api('GET', '/api/me'); if (me?.user) { stopTg(); onLoggedIn(me.user); return true; } } catch { /* not signed in */ }
      return false;
    };
    pollOnce = async () => {
      if (!tgTimer || polling) return; // one request at a time: a second one would find the token already used
      polling = true;
      try {
        if (Date.now() > deadline) {
          if (await alreadyIn()) return;
          stopTg(); step = 'home'; draw(t('err.tg_expired')); return;
        }
        const r = await api('GET', `/api/auth/telegram/poll?token=${encodeURIComponent(myToken)}`);
        if (!tgTimer || tgLogin.token !== myToken) return; // finished or restarted meanwhile
        if (r.status === 'approved') { stopTg(); onLoggedIn(r.user); }
        else if (r.status === 'rejected') { stopTg(); step = 'home'; draw(t('err.tg_rejected')); }
        else if (r.status === 'expired') {
          if (await alreadyIn()) return;
          stopTg(); step = 'home'; draw(t('err.tg_expired'));
        }
      } catch { /* transient network error: keep polling */ } finally { polling = false; }
    };
    tgTimer = setInterval(pollOnce, 2000);
    // the page is paused while the user is in Telegram: check right away when they come back
    document.addEventListener('visibilitychange', onVisible);
  }

  function draw(message = '') {
    const err = h('div', { class: 'err', role: 'alert' }, message);
    clear(card).append(h('img', { class: 'auth-logo', src: '/icon.svg?v=2', alt: '' }), h('h1', null, t('login.title')));

    if (step === 'home') {
      card.append(h('p', { class: 'muted' }, t('login.home_sub')));
      if (providers.telegram?.enabled) {
        card.append(h('button', { class: 'btn with-ico', type: 'button', style: { width: '100%', marginBottom: '10px' }, onclick: startTelegram }, icon('telegram', 20), h('span', null, t('login.tg'))));
      }
      if (providers.email) {
        card.append(h('button', {
          class: `${providers.telegram?.enabled ? 'btn secondary' : 'btn'} with-ico`, type: 'button', style: { width: '100%', marginBottom: '6px' },
          onclick: () => { step = 'email'; draw(); },
        }, icon('mail', 20), h('span', null, t('login.email'))));
      }
      card.append(err);
      if (providers.phone_code) {
        card.append(h('button', { class: 'btn link', type: 'button', onclick: () => { step = 'phone'; draw(); } }, t('login.use_phone')));
      }
    } else if (step === 'email') {
      const input = h('input', { class: 'input', type: 'email', id: 'email', autocomplete: 'email', inputMode: 'email', autocapitalize: 'none', spellcheck: false, placeholder: 'name@example.com', value: email, required: true });
      const btn = h('button', { class: 'btn', type: 'submit', style: { width: '100%' } }, t('login.email_send'));
      card.append(h('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        email = input.value.trim();
        btn.disabled = true;
        try {
          await api('POST', '/api/auth/email/request', { email });
          step = 'emailcode';
          draw();
        } catch (ex) {
          err.textContent = ex.status === 0 ? t('net.offline') : errText(ex.code);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, t('login.email_sub')),
      h('div', { class: 'field' }, h('label', { for: 'email' }, h('span', null, t('login.email_label'))), input),
      err, btn),
      h('button', { class: 'btn link', type: 'button', onclick: () => { step = providers.telegram?.enabled ? 'home' : 'phone'; draw(); } }, t('login.back_methods')));
      input.focus();
    } else if (step === 'emailcode' || step === 'emailname') {
      const needsName = step === 'emailname';
      const code = h('input', { class: 'input', id: 'ecode', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, placeholder: '000000', value: pendingCode, required: true });
      const name = needsName ? h('input', { class: 'input', id: 'ename', maxLength: 64, autocomplete: 'name', required: true }) : null;
      const btn = h('button', { class: 'btn', type: 'submit', style: { width: '100%' } }, needsName ? t('login.create') : t('login.verify'));
      card.append(h('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        pendingCode = code.value.trim();
        try {
          const r = await api('POST', '/api/auth/email/verify', { email, code: pendingCode, invite: inviteCode(), ...(name ? { name: name.value } : {}) });
          if (r.needs_name) { step = 'emailname'; draw(); return; }
          onLoggedIn(r.user);
        } catch (ex) {
          err.textContent = ex.status === 0 ? t('net.offline') : errText(ex.code);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, needsName ? t('login.name_hint') : t('login.email_sent', { email })),
      h('div', { class: 'field' }, h('label', { for: 'ecode' }, h('span', null, t('login.code'))), code),
      name ? h('div', { class: 'field' }, h('label', { for: 'ename' }, h('span', null, t('login.name'))), name) : null,
      err, btn),
      h('button', { class: 'btn link', type: 'button', onclick: () => { step = 'email'; pendingCode = ''; draw(); } }, t('login.email_change')));
      (name && code.value ? name : code).focus();
    } else if (step === 'tg') {
      const link = isMobileShell ? tgLogin.app_url : tgLogin.url;
      card.append(
        h('ol', { class: 'steps' },
          h('li', null, t('login.tg_step1', { bot: `@${tgLogin.bot}` })),
          h('li', null, t('login.tg_step2')),
          h('li', null, t('login.tg_step3'))),
        h('a', { class: 'btn', style: { display: 'block', textAlign: 'center', textDecoration: 'none' }, href: link, ...(isMobileShell ? {} : { target: '_blank' }), rel: 'noopener' }, `✈️ ${t('login.tg_open')}`),
        h('p', { class: 'muted', role: 'status' }, `⏳ ${t('login.tg_wait')}`),
        h('button', { class: 'btn link', type: 'button', onclick: () => { stopTg(); step = 'home'; draw(); } }, t('chat.cancel')),
      );
    } else if (step === 'phone') {
      const input = h('input', { class: 'input', type: 'tel', id: 'phone', autocomplete: 'tel', inputMode: 'tel', placeholder: '+998 90 123 45 67', value: phone, required: true });
      const btn = h('button', { class: 'btn', type: 'submit', style: { width: '100%' } }, t('login.send'));
      const form = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        phone = input.value.trim();
        btn.disabled = true;
        try {
          const r = await api('POST', '/api/auth/request', { phone });
          devCode = r.dev_code ?? null;
          step = 'code';
          draw();
        } catch (ex) {
          err.textContent = ex.status === 0 ? t('net.offline') : errText(ex.code);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, t('login.sub')),
      h('div', { class: 'field' }, h('label', { for: 'phone' }, h('span', null, t('login.phone'))), input),
      err, btn);
      card.append(form);
      if (providers.telegram?.enabled || providers.email) {
        card.append(h('button', { class: 'btn link', type: 'button', onclick: () => { step = 'home'; draw(); } }, t('login.back_methods')));
      }
      input.focus();
    } else {
      const needsName = step === 'name';
      const code = h('input', { class: 'input', id: 'code', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, placeholder: '000000', value: pendingCode, required: true });
      const name = needsName ? h('input', { class: 'input', id: 'name', maxLength: 64, autocomplete: 'name', required: true }) : null;
      const btn = h('button', { class: 'btn', type: 'submit', style: { width: '100%' } }, needsName ? t('login.create') : t('login.verify'));
      const form = h('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        pendingCode = code.value.trim();
        try {
          const r = await api('POST', '/api/auth/verify', { phone, code: pendingCode, invite: inviteCode(), ...(name ? { name: name.value } : {}) });
          if (r.needs_name) { step = 'name'; draw(); return; }
          onLoggedIn(r.user);
        } catch (ex) {
          err.textContent = ex.status === 0 ? t('net.offline') : errText(ex.code);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, needsName ? t('login.name_hint') : `${phone}`),
      devCode ? h('div', { class: 'dev-box' }, `${t('login.dev_code')} `, h('b', null, devCode)) : null,
      h('div', { class: 'field' }, h('label', { for: 'code' }, h('span', null, t('login.code'))), code),
      name ? h('div', { class: 'field' }, h('label', { for: 'name' }, h('span', null, t('login.name'))), name) : null,
      err, btn);
      card.append(form,
        h('button', { class: 'btn link', type: 'button', onclick: () => { step = 'phone'; pendingCode = ''; draw(); } }, t('login.back')),
        h('p', { class: 'muted', style: { fontSize: '.8rem' } }, t('login.recover')));
      (name && code.value ? name : code).focus();
    }
    const inShell = navigator.userAgent.includes('SuhbatShell/');
    card.append(
      h('div', { class: 'auth-tools' }, langSel, inShell ? null : h('a', { class: 'btn secondary dl-link', href: '/download' }, icon('download', 18), h('span', null, t('login.download')))));
  }

  clear(root).append(h('div', { class: 'auth' }, card, h('a', { class: 'auth-admin', href: '/admin' }, t('login.admin'))));
  draw();
}

export async function logout() {
  try { await api('POST', '/api/auth/logout'); } catch { /* already gone */ }
  fire('logged-out');
}
