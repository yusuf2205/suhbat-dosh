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

/**
 * Sign-in is login + password. Anyone can create an account (login, password, optional e-mail).
 * The e-mail code stays as a way back into an account whose password was forgotten.
 */
export async function showLogin(root, { onLoggedIn }) {
  let providers = { password: true, email: false };
  try { providers = await api('GET', '/api/auth/providers'); } catch { /* offline: the form still works once the network is back */ }

  let step = 'login'; // login | register | regcode | email | emailcode | emailname
  let login = '';
  let email = '';
  let pendingCode = '';
  let draft = {};

  const card = h('div', { class: 'auth-card' });
  const langSel = h('select', { class: 'input', 'aria-label': 'Language', onchange: () => { S.prefs.lang = langSel.value; savePrefs(); fire('relang'); } },
    Object.entries(LANGS).map(([k, v]) => h('option', { value: k, selected: getLang() === k }, v)));

  const field = (id, label, input) => h('div', { class: 'field' }, h('label', { for: id }, h('span', null, label)), input);
  const netErr = (ex) => (ex.status === 0 ? t('net.offline') : errText(ex.code));
  const link = (text, to) => h('button', { class: 'btn link', type: 'button', onclick: () => { step = to; pendingCode = ''; draw(); } }, text);

  function draw(message = '') {
    const err = h('div', { class: 'err', role: 'alert' }, message);
    clear(card).append(h('img', { class: 'auth-logo', src: '/icon.svg?v=2', alt: '' }),
      h('h1', null, t(step === 'register' || step === 'regcode' ? 'login.reg_title' : 'login.title')));

    if (step === 'login') {
      const user = h('input', { class: 'input', id: 'lg', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 64, value: login, required: true });
      const pass = h('input', { class: 'input', id: 'pw', type: 'password', autocomplete: 'current-password', maxLength: 200, required: true });
      const btn = h('button', { class: 'btn', type: 'submit', style: { width: '100%' } }, t('login.signin'));
      card.append(h('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        login = user.value.trim();
        btn.disabled = true;
        try {
          const r = await api('POST', '/api/auth/login', { login, password: pass.value });
          onLoggedIn(r.user);
        } catch (ex) {
          err.textContent = netErr(ex);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, t('login.sub_pw')),
      field('lg', t('login.login'), user), field('pw', t('login.password'), pass),
      err, btn),
      h('button', { class: 'btn secondary', type: 'button', style: { width: '100%', marginTop: '10px' }, onclick: () => { step = 'register'; draw(); } }, t('login.signup')),
      ...(providers.email ? [link(t('login.forgot'), 'email')] : []));
      (login ? pass : user).focus();
    } else if (step === 'register') {
      const name = h('input', { class: 'input', id: 'rn', maxLength: 64, autocomplete: 'name', required: true });
      const user = h('input', { class: 'input', id: 'rl', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: 32, placeholder: 'login_name', required: true });
      const pass = h('input', { class: 'input', id: 'rp', type: 'password', autocomplete: 'new-password', maxLength: 200, minLength: 8, required: true });
      const mail = providers.email
        ? h('input', { class: 'input', id: 're', type: 'email', autocomplete: 'email', inputMode: 'email', autocapitalize: 'none', spellcheck: false, placeholder: 'name@example.com', value: draft.email || '', required: true })
        : null;
      const btn = h('button', { class: 'btn', type: 'submit', style: { width: '100%' } }, t('login.create'));
      card.append(h('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        draft = { name: name.value, username: user.value.trim(), password: pass.value, email: mail ? mail.value.trim() : '' };
        try {
          if (mail) {
            // the address is proven first: a code is mailed, the account is created when it is entered
            await api('POST', '/api/auth/register/code', { username: draft.username, email: draft.email, invite: inviteCode() });
            email = draft.email.toLowerCase();
            step = 'regcode';
            draw();
            return;
          }
          const r = await api('POST', '/api/auth/register', { name: draft.name, username: draft.username, password: draft.password, invite: inviteCode() });
          onLoggedIn(r.user);
        } catch (ex) {
          err.textContent = netErr(ex);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, t('login.reg_sub')),
      field('rn', t('login.name'), name), field('rl', t('login.login'), user),
      field('rp', t('login.password'), pass), h('p', { class: 'muted', style: { fontSize: '.8rem', margin: '-6px 0 8px' } }, t('login.password_hint')),
      mail ? field('re', t('login.email_req'), mail) : null,
      err, btn),
      link(t('login.have_account'), 'login'));
      (draft.name ? pass : name).focus();
      name.value = draft.name || '';
      user.value = draft.username || '';
    } else if (step === 'regcode') {
      const code = h('input', { class: 'input', id: 'rc', inputMode: 'numeric', autocomplete: 'one-time-code', maxLength: 6, placeholder: '000000', required: true });
      const btn = h('button', { class: 'btn', type: 'submit', style: { width: '100%' } }, t('login.verify'));
      card.append(h('form', { onsubmit: async (e) => {
        e.preventDefault();
        err.textContent = '';
        btn.disabled = true;
        try {
          const r = await api('POST', '/api/auth/register', { ...draft, email, code: code.value.trim(), invite: inviteCode() });
          onLoggedIn(r.user);
        } catch (ex) {
          err.textContent = netErr(ex);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, t('login.email_sent', { email })),
      field('rc', t('login.code'), code), err, btn),
      link(t('login.email_change'), 'register'));
      code.focus();
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
          err.textContent = netErr(ex);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, t('login.forgot_sub')),
      field('email', t('login.email_label'), input), err, btn),
      link(t('login.back_pw'), 'login'));
      input.focus();
    } else { // emailcode | emailname
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
          err.textContent = netErr(ex);
          btn.disabled = false;
        }
      } },
      h('p', { class: 'muted' }, needsName ? t('login.name_hint') : t('login.email_sent', { email })),
      field('ecode', t('login.code'), code),
      name ? field('ename', t('login.name'), name) : null,
      err, btn),
      link(t('login.email_change'), 'email'));
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
