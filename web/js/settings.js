// Settings, laid out like Telegram: a list of sections with icons; each opens its own page with a back arrow.
import { closeLayer, openLayer } from './backnav.js';
import { LIMITS, PRIVACY_VALUES } from '/shared/contracts.js';
import { motionLevel, setLiteMotion } from './motion.js';
import { h, clear, formatBytes } from './dom.js';
import { t, errText, LANGS, getLang } from './i18n.js';
import { S, fire, savePrefs } from './state.js';
import { icon } from './icons.js';
import { api } from './net.js';
import { avatar, confirmDialog, lightbox, modal, popMenu, toast } from './ui.js';
import qrcode from './vendor/qrcode.js';
import { dndRows, openFolders, openGlobalSearch, quietSettings } from './extras.js';
import { compose as composeStory, openStoryArchive } from './stories.js';
import { openScanner } from './scanner.js';
import { screenGuardNative } from './screenguard.js';
import { openSelfNotes } from './selfnotes.js';
import { openBridge } from './tgbridge.js';
import { openBotFather } from './bots.js';
import { openSaved, setView } from './rail.js';
import { updatesSection } from './updates.js';
import { storageSection } from './viewer.js';
import { DEFAULT_AUTO, autoPolicy, cancelDownload, listDownloads, netClass, onDownload, pauseDownload, resumeDownload, setAutoPolicy } from './downloads.js';
import { cancel as cancelUpload, listUploads, onUpload, pause as pauseUpload, resume as resumeUpload } from './uploads.js';
import { callSettingsSection } from './call.js';
import { openDrive } from './drive.js';
import { openCalendar } from './events.js';
import { openNearby } from './nearby.js';
import { openTasks } from './tasks.js';
import { focusSummary, openFocus } from './focus.js';
import { openDigestAll } from './digest.js';
import { openImport } from './import.js';
import { openStorage } from './storage.js';
import { openQuickManager } from './quick.js';
import { openDirectory } from './directory.js';
import { openAccounts } from './accounts.js';
import { openBackup } from './backup.js';
import { bioAvailable, bioOn, confirmPin, createPin, disableBio, disableLock, enableBio, lockEnabled, lockTimeout, setTimeoutSec, showLock } from './applock.js';
import {
  disablePush, enablePush, pushEnabled, pushSupported,
} from './push.js';

const fail = (e) => toast(errText(e.code));
const inShell = navigator.userAgent.includes('SuhbatShell/');

// ---------------------------------------------------------------- building blocks
const group = (...kids) => h('div', { class: 'sgroup' }, ...kids.flat().filter(Boolean));
const heading = (text) => h('div', { class: 'sheading' }, text);
const note = (text) => h('div', { class: 'snote' }, text);

function row(ico, label, { value = null, onclick = null, danger = false, hint = null } = {}) {
  return h('button', { class: `srow${danger ? ' danger' : ''}`, type: 'button', onclick },
    ico ? h('span', { class: 'srow-ico' }, icon(ico, 22)) : h('span', { class: 'srow-ico none' }),
    h('span', { class: 'srow-label' }, label, hint ? h('small', null, hint) : null),
    value !== null ? h('span', { class: 'srow-value' }, value) : null,
    onclick && value === null ? h('span', { class: 'srow-go' }, icon('chevron', 18)) : null);
}

function switchRow(label, checked, onchange, hint = null) {
  const input = h('input', { type: 'checkbox', checked: !!checked });
  input.addEventListener('change', () => onchange(input.checked, input));
  return h('label', { class: 'srow' }, h('span', { class: 'srow-ico none' }),
    h('span', { class: 'srow-label' }, label, hint ? h('small', null, hint) : null),
    h('span', { class: 'switch' }, input, h('i')));
}

/** A value shown big with its caption underneath (profile / account pages). */
const info = (value, caption, extra = null) => h('div', { class: 'sinfo' },
  h('div', { class: 'sinfo-main' }, h('div', { class: 'sinfo-value' }, value || t('st.not_set')), h('div', { class: 'sinfo-cap' }, caption)), extra);

const phoneOf = () => (S.me.phone ? S.me.phone : S.me.email || '');

// ---------------------------------------------------------------- shared profile helpers (also used by the contact's profile panel)
const MONTHS_RU = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_UZ = ['yan', 'fev', 'mar', 'apr', 'may', 'iyn', 'iyl', 'avg', 'sen', 'okt', 'noy', 'dek'];

/** '1999-05-17' -> '17 мая 1999 (26 лет)'; '--05-17' -> '17 мая'. */
export function formatBirthday(v) {
  if (!v) return '';
  const m = /^(\d{4}|--)-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return v;
  const names = getLang() === 'uz' ? MONTHS_UZ : MONTHS_RU;
  const day = `${Number(m[3])} ${names[Number(m[2]) - 1]}`;
  if (m[1] === '--') return day;
  const now = new Date();
  let age = now.getFullYear() - Number(m[1]);
  if (now.getMonth() + 1 < Number(m[2]) || (now.getMonth() + 1 === Number(m[2]) && now.getDate() < Number(m[3]))) age -= 1;
  return `${day} ${m[1]} (${age})`;
}

export function isBirthdayToday(v) {
  const m = /^(?:\d{4}|--)-(\d{2})-(\d{2})$/.exec(v || '');
  const d = new Date();
  return !!m && Number(m[1]) === d.getMonth() + 1 && Number(m[2]) === d.getDate();
}

/** Profile link in a QR code: scanning it with any camera opens the messenger and the chat with this person. */
export function openQr(user) {
  const link = `${location.origin}/?u=${encodeURIComponent(user.username)}`;
  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  const n = qr.getModuleCount();
  const pad = 3;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n + pad * 2} ${n + pad * 2}`);
  svg.setAttribute('class', 'qr-svg');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'QR');
  const bg = document.createElementNS(NS, 'rect');
  bg.setAttribute('width', String(n + pad * 2));
  bg.setAttribute('height', String(n + pad * 2));
  bg.setAttribute('fill', '#ffffff');
  svg.append(bg);
  let d = '';
  for (let r = 0; r < n; r += 1) for (let c = 0; c < n; c += 1) if (qr.isDark(r, c)) d += `M${c + pad} ${r + pad}h1v1h-1z`;
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', '#1b1b1f');
  svg.append(path);
  modal({
    title: t('st.qr'), className: 'qr-modal',
    body: [h('div', { class: 'qr-box' }, svg, h('b', null, user.name), h('span', { class: 'accent' }, `@${user.username}`)),
      h('p', { class: 'muted', style: { textAlign: 'center' } }, t('st.qr_hint')),
      h('button', { class: 'btn secondary', type: 'button', style: { width: '100%' }, onclick: async () => { try { await navigator.clipboard.writeText(link); toast(t('bots.copied')); } catch { toast(link, 6000); } } }, t('st.copy_link')),
      h('button', { class: 'btn', type: 'button', style: { width: '100%', marginTop: '8px' }, onclick: () => openScanner() }, t('scan.title'))],
  });
}

/** Album of profile photos. own = true adds the upload tile and lets the owner manage photos. */
export function photoGrid(userId, own, onChange = () => {}) {
  const box = h('div', { class: 'photo-grid' });
  const load = async () => {
    let photos = [];
    try { photos = (await api('GET', `/api/users/${userId}/photos`)).photos; } catch { /* offline */ }
    const tiles = photos.map((p) => h('button', { class: `photo-tile${p.current ? ' current' : ''}`, type: 'button', onclick: () => view(p) },
      h('img', { src: p.url, alt: '', loading: 'lazy' })));
    if (own) {
      tiles.push(h('button', { class: 'photo-tile add', type: 'button', 'aria-label': t('st.add_photo'), onclick: () => add() }, icon('plus', 26)));
    }
    clear(box).append(...tiles);
    box.hidden = !tiles.length;
  };
  const add = () => {
    const f = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'sr', tabIndex: -1 });
    document.body.append(f);
    f.onchange = async () => {
      const file = f.files[0];
      f.remove();
      if (!file) return;
      try {
        const r = await api('POST', '/api/me/avatar', undefined, { raw: file, headers: { 'content-type': 'application/octet-stream' } });
        S.me = r.user;
        fire('me');
        onChange();
        load();
      } catch (e) { fail(e); }
    };
    f.click();
  };
  const view = (p) => {
    if (!own) { lightbox(p.url); return; }
    const m = modal({ title: t('st.album'), className: 'lightbox', body: [
      h('img', { src: p.url, alt: '', style: { maxWidth: '100%', maxHeight: '60vh', borderRadius: '14px', display: 'block', margin: '0 auto' } }),
      h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } },
        p.current ? null : h('button', { class: 'btn', type: 'button', onclick: async () => { try { S.me = (await api('POST', `/api/me/photos/${p.id}/main`)).user; fire('me'); m.close(); onChange(); load(); } catch (e) { fail(e); } } }, t('st.set_main')),
        h('button', { class: 'btn danger', type: 'button', onclick: async () => { try { S.me = (await api('DELETE', `/api/me/photos/${p.id}`)).user; fire('me'); m.close(); onChange(); load(); } catch (e) { fail(e); } } }, t('common.delete')))] });
  };
  load();
  return box;
}

// ---------------------------------------------------------------- the dialog
export function openSettings() {
  const stack = [];
  let m = null;
  let body = null;

  const pageLayers = [];
  const go = (page) => {
    stack.push(page);
    pageLayers.push(openLayer(() => { pageLayers.pop(); stack.pop(); draw(); }));
    draw();
  };
  const back = () => {
    if (stack.length <= 1) { m.close(); return; }
    const l = pageLayers.pop();
    if (l) closeLayer(l);
    stack.pop();
    draw();
  };
  const home = () => { stack.length = 0; stack.push(pages.root); draw(); };

  function header(title, { actions = [] } = {}) {
    const first = stack.length === 1;
    return h('div', { class: 'st-head' },
      first ? null : h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('st.back'), onclick: back }, icon('back', 22)),
      h('h2', { class: 'grow ellipsis' }, title),
      ...actions,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), onclick: () => m.close() }, icon('close', 22)));
  }

  function draw() {
    const page = stack[stack.length - 1];
    const out = page.render();
    m.setBody(header(page.title(), { actions: out.actions || [] }), h('div', { class: 'st-page' }, ...out.nodes));
    m.el.scrollTop = 0;
    out.after?.();
  }

  // ---- shared actions
  const photoMenu = (anchor) => {
    const items = [{ label: t('st.photo_change'), onClick: () => pickPhoto() }];
    if (S.me.avatar) {
      items.push({ label: t('settings.photo_remove'), danger: true, onClick: async () => {
        if (!(await confirmDialog(t('st.photo_remove_confirm'), { okLabel: t('common.delete'), danger: true }))) return;
        try { S.me = (await api('DELETE', '/api/me/avatar')).user; fire('me'); draw(); } catch (e) { fail(e); }
      } });
    }
    popMenu(anchor, items);
  };

  const pickPhoto = () => {
    const f = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'sr', tabIndex: -1 });
    document.body.append(f);
    f.onchange = async () => {
      const file = f.files[0];
      f.remove();
      if (!file) return;
      try {
        const r = await api('POST', '/api/me/avatar', undefined, { raw: file, headers: { 'content-type': 'application/octet-stream' } });
        S.me = r.user;
        fire('me');
        draw();
      } catch (e) { fail(e); }
    };
    f.click();
  };

  const logout = async () => {
    m.close();
    fire('logged-out-request');
  };

  // ---- pages
  const pages = {};

  pages.root = {
    title: () => t('settings.title'),
    render() {
      const me = S.me;
      const nodes = [
        h('div', { class: 'st-me' },
          h('button', { class: 'st-me-photo', type: 'button', 'aria-label': t('st.photo_change'), onclick: (e) => photoMenu(e.currentTarget) }, avatar({ ...me, online: false }, 'lg'), h('span', { class: 'st-cam' }, icon('camera', 16))),
          h('button', { class: 'st-me-text', type: 'button', onclick: () => go(pages.profile) },
            h('b', { class: 'ellipsis' }, me.name),
            h('span', { class: 'ellipsis' }, phoneOf()),
            me.username ? h('span', { class: 'accent ellipsis' }, `@${me.username}`) : null)),
        heading(t('st.sec_quick')),
        group(
          row('bookmark', t('nav.saved'), { onclick: () => { m.close(); openSaved(); } }),
          row('edit', t('sn.title'), { onclick: () => { m.close(); openSelfNotes(); } }),
          row('folder', t('drive.title'), { onclick: () => { m.close(); openDrive(); } }),
          row('clock', t('ev.calendar'), { onclick: () => { m.close(); openCalendar(); } }),
          row('tasks', t('task.title'), { onclick: () => { m.close(); openTasks(); } }),
          row('archive', t('nav.archive'), { onclick: () => { m.close(); setView('archive'); } })),
        heading(t('st.sec_account')),
        group(
          row('user', t('st.account'), { onclick: () => go(pages.account) }),
          row('lock', t('st.privacy'), { onclick: () => go(pages.privacy) }),
          row('user', t('acc.title'), { onclick: () => { m.close(); openAccounts(); } }),
          row('clock', t('pres.title'), { value: S.me.presence === 'busy' ? t('pres.busy') : S.me.presence === 'away' ? t('pres.away') : t('pres.online'), onclick: () => go(pages.presence) })),
        heading(t('st.sec_chats')),
        group(
          row('chat', t('st.chats'), { onclick: () => go(pages.chats) }),
          row('bell', t('st.notifications'), { onclick: () => go(pages.notifications) }),
          row('folder', t('st.folders'), { value: String((S.folders || []).length), onclick: () => openFolders() }),
          row('chat', t('quick.title'), { onclick: () => { m.close(); openQuickManager(); } }),
          row('moon', t('focus.title'), { value: focusSummary(), onclick: () => { m.close(); openFocus(); } }),
          row('list', t('digest.all_title'), { onclick: () => { m.close(); openDigestAll(); } })),
        heading(t('st.sec_people')),
        group(
          row('camera', t('story.new'), { onclick: () => { composeStory(); } }),
          row('clock', t('story.archive'), { onclick: () => { openStoryArchive(); } }),
          row('globe', t('dir.title'), { onclick: () => { m.close(); openDirectory(); } }),
          row('search', t('gsearch.title'), { onclick: () => { m.close(); openGlobalSearch(); } }),
          row('qr', t('scan.title'), { onclick: () => { m.close(); openScanner(); } }),
          row('wifi', t('nb.title'), { hint: t('nb.hint'), onclick: () => { m.close(); openNearby(); } })),
        heading(t('st.sec_data')),
        group(
          row('disk', t('st.storage'), { onclick: () => { m.close(); openStorage(); } }),
          row('download', t('dl.title'), { onclick: () => go(pages.transfers) }),
          row('wifi', t('auto.title'), { onclick: () => go(pages.autodl) }),
          row('download', t('bk.title'), { hint: t('bk.hint'), onclick: () => { m.close(); openBackup(); } }),
          row('telegram', t('imp.title'), { hint: t('imp.hint'), onclick: () => { m.close(); openImport(); } }),
          S.bridgeOk ? row('telegram', t('br.title'), { hint: t('br.hint'), onclick: () => { m.close(); openBridge(); } }) : null),
        heading(t('st.sec_app')),
        group(
          row('speaker', t('st.av'), { onclick: () => go(pages.av) }),
          row('sliders', t('st.advanced'), { onclick: () => go(pages.advanced) }),
          row('globe', t('settings.language'), { value: LANGS[getLang()], onclick: () => go(pages.language) })),
        S.me.is_admin ? group(row('shield', t('st.admin'), { onclick: () => window.open('/admin', 'suhbat-admin') })) : null,
        group(row('logout', t('settings.logout'), { danger: true, onclick: logout })),
      ];
      return {
        nodes: nodes.filter(Boolean),
        actions: [h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('st.menu'), onclick: (e) => popMenu(e.currentTarget, [
          { label: t('st.edit'), onClick: () => go(pages.account) },
          { label: t('settings.logout'), danger: true, onClick: logout },
        ]) }, icon('more', 22))],
      };
    },
  };

  // Telegram-style own profile: big photo, name, "online", then values with captions
  pages.profile = {
    title: () => t('st.my_profile'),
    render() {
      const me = S.me;
      return {
        actions: [h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('st.edit'), onclick: () => go(pages.account) }, icon('edit', 22))],
        nodes: [
          h('div', { class: 'st-hero' },
            h('button', { class: 'st-hero-photo', type: 'button', onclick: (e) => photoMenu(e.currentTarget), 'aria-label': t('st.photo_change') }, avatar({ ...me, online: false }, 'xl')),
            h('h3', null, me.name),
            h('div', { class: 'accent' }, t('st.online'))),
          group(
            info(phoneOf(), t('st.phone')),
            info(me.bio, t('st.about')),
            info(me.username ? `@${me.username}` : '', t('st.username'),
              me.username ? h('button', { class: 'icon-btn accent', type: 'button', 'aria-label': t('st.qr'), onclick: () => openQr(me) }, icon('qr', 24)) : null),
            info(me.birthday ? `${isBirthdayToday(me.birthday) ? '\u{1F382} ' : ''}${formatBirthday(me.birthday)}` : '', t('st.birthday'))),
          heading(t('st.album')),
          h('div', { class: 'sgroup album' }, photoGrid(me.id, true, () => draw())),
        ].filter(Boolean),
      };
    },
  };

  pages.account = {
    title: () => t('st.account'),
    render() {
      const me = S.me;
      const name = h('input', { class: 'input', value: me.name, maxLength: LIMITS.NAME_MAX, 'aria-label': t('settings.name') });
      const username = h('input', { class: 'input', value: me.username ?? '', maxLength: LIMITS.USERNAME_MAX, autocapitalize: 'none', spellcheck: false, 'aria-label': t('settings.username') });
      const bio = h('textarea', { class: 'input', rows: 3, maxLength: LIMITS.BIO_MAX, 'aria-label': t('settings.bio') }, me.bio ?? '');
      const status = h('input', { class: 'input', value: me.status ?? '', maxLength: LIMITS.STATUS_MAX, 'aria-label': t('settings.status') });
      const noYear = /^--/.test(me.birthday || '');
      const bday = h('input', { class: 'input', type: 'date', max: new Date().toISOString().slice(0, 10), 'aria-label': t('st.birthday'),
        value: me.birthday ? (noYear ? `2000${me.birthday.slice(1)}` : me.birthday) : '' });
      const hideYear = h('input', { type: 'checkbox', id: 'bday-noyear', checked: noYear });
      const err = h('div', { class: 'err', role: 'alert' });
      const save = h('button', { class: 'btn', type: 'button' }, t('settings.save'));
      save.onclick = async () => {
        err.textContent = '';
        try {
          const bd = bday.value ? (hideYear.checked ? `--${bday.value.slice(5)}` : bday.value) : '';
          const r = await api('PATCH', '/api/me', { name: name.value, username: username.value, status: status.value, bio: bio.value, birthday: bd });
          S.me = r.user;
          fire('me');
          toast(t('settings.saved'));
        } catch (e) { err.textContent = errText(e.code); }
      };
      const emailBox = h('div', { class: 'st-email' });
      drawEmail(emailBox, () => draw());
      return {
        nodes: [
          h('div', { class: 'st-hero small' },
            h('button', { class: 'st-hero-photo', type: 'button', onclick: (e) => photoMenu(e.currentTarget), 'aria-label': t('st.photo_change') }, avatar({ ...me, online: false }, 'lg'))),
          group(h('div', { class: 'sfield' }, h('span', null, t('settings.name')), name),
            h('div', { class: 'sfield' }, h('span', null, t('settings.username')), username),
            h('div', { class: 'sfield' }, h('span', null, t('settings.bio')), bio),
            h('div', { class: 'sfield' }, h('span', null, t('settings.status')), status),
            h('div', { class: 'sfield' }, h('span', null, t('st.birthday')), bday, h('label', { class: 'row', for: 'bday-noyear' }, hideYear, t('st.hide_year'))),
            err, h('div', { class: 'sfield' }, save)),
          group(info(me.phone || '—', t('st.phone'))),
          heading(t('settings.email')),
          group(h('div', { class: 'sfield' }, emailBox)),
          heading(t('st.password')),
          group(h('div', { class: 'sfield' }, passwordBox(() => draw()))),
        ],
      };
    },
  };

  pages.notifications = {
    title: () => t('st.notifications'),
    render() {
      const bgBox = h('div');
      const bgRow = () => {
        clear(bgBox);
        if (inShell) {
          const nat = window.SuhbatNative;
          const unrestricted = nat?.isBatteryUnrestricted ? nat.isBatteryUnrestricted() : true;
          bgBox.append(group(
            h('div', { class: 'srow static' }, h('span', { class: 'srow-ico' }, icon('bolt', 22)), h('span', { class: 'srow-label' }, t('st.bg'), h('small', null, t('st.bg_native')))),
            nat?.openBatterySettings && !unrestricted ? row('battery', t('st.battery'), { hint: t('st.battery_hint'), onclick: () => nat.openBatterySettings() }) : null));
          return;
        }
        // iPhone / iPad: notifications and incoming calls in the background only work for the app added to the Home Screen
        if (/iPhone|iPad|iPod/.test(navigator.userAgent) && !navigator.standalone && !matchMedia('(display-mode: standalone)').matches) {
          bgBox.append(group(h('div', { class: 'srow static' }, h('span', { class: 'srow-ico' }, icon('bolt', 22)), h('span', { class: 'srow-label' }, t('st.bg'), h('small', null, t('st.bg_ios'))))));
          return;
        }
        if (!pushSupported()) { bgBox.append(group(h('div', { class: 'srow static' }, h('span', { class: 'srow-ico' }, icon('bolt', 22)), h('span', { class: 'srow-label' }, t('st.bg'), h('small', null, t('st.bg_unsupported')))))); return; }
        pushEnabled().then((on) => {
          clear(bgBox).append(group(switchRow(t('st.bg'), on, async (v, input) => {
            if (v) {
              const r = await enablePush();
              if (r !== 'ok') { input.checked = false; toast(r === 'denied' ? t('st.bg_denied') : t('err.generic'), 5000); }
            } else {
              await disablePush();
            }
          }, t('st.bg_hint'))));
        });
      };
      bgRow();
      return {
        nodes: [
          heading(t('settings.notifications')),
          group(
            switchRow(t('settings.sound'), S.prefs.sound, (v) => { S.prefs.sound = v; savePrefs(); }),
            switchRow(t('settings.desktop'), !!S.prefs.desktop && window.Notification?.permission === 'granted', async (v, input) => {
              if (v && window.Notification) {
                const p = await Notification.requestPermission();
                input.checked = p === 'granted';
                S.prefs.desktop = p === 'granted';
              } else S.prefs.desktop = false;
              savePrefs();
            })),
          bgBox,
          ...(window.suhbatShell?.getNotifPrefs ? [heading(t('st.notif_where')), notifPlacement()] : []),
          heading(t('dnd.title')),
          group(...dndRows(row, draw)),
          heading(t('quiet.title')),
          group(h('div', { class: 'sfield' }, ...quietSettings())),
          note(t('st.sound_hint')),
        ],
      };
    },
  };

  // ---- status (available / busy / away) and the auto-reply
  pages.presence = {
    title: () => t('pres.title'),
    render() {
      const cur = S.me.presence || '';
      const save = async (patch) => {
        try { S.me = (await api('PATCH', '/api/me', patch)).user; fire('me'); draw(); } catch (e) { fail(e); }
      };
      const choice = (value, labelKey, ico) => h('button', { class: 'srow', type: 'button', 'aria-pressed': String(cur === value), onclick: () => save({ presence: value }) },
        h('span', { class: 'srow-ico' }, icon(ico, 22)), h('span', { class: 'srow-label' }, t(labelKey)),
        cur === value ? h('span', { class: 'srow-value' }, '✓') : null);
      const text = h('textarea', { class: 'input', rows: 3, maxLength: 300, placeholder: t('pres.auto_ph'), 'aria-label': t('pres.auto_text') });
      text.value = S.me.auto_reply || '';
      // working hours: outside them people who write get an automatic answer; a greeting goes to everybody who writes for the first time
      const w = { ...S.me.work, days: [...(S.me.work?.days || [1, 2, 3, 4, 5])] };
      const saveWork = (patch) => save({ work: { ...w, ...patch, tz: -new Date().getTimezoneOffset() } });
      const from = h('input', { class: 'input', type: 'time', value: w.from, 'aria-label': t('work.from') });
      const to = h('input', { class: 'input', type: 'time', value: w.to, 'aria-label': t('work.to') });
      const away = h('textarea', { class: 'input', rows: 2, maxLength: 300, placeholder: t('work.text_ph'), 'aria-label': t('work.text') });
      away.value = w.text || '';
      const greet = h('textarea', { class: 'input', rows: 2, maxLength: 300, placeholder: t('work.greeting_ph'), 'aria-label': t('work.greeting') });
      greet.value = S.me.greeting || '';
      const dayNames = [t('day.sun'), t('day.mon'), t('day.tue'), t('day.wed'), t('day.thu'), t('day.fri'), t('day.sat')];
      const days = h('div', { class: 'focus-days' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('button', {
        class: 'chip', type: 'button', 'aria-pressed': String(w.days.includes(d)),
        onclick: () => { const s = new Set(w.days); if (s.has(d)) s.delete(d); else s.add(d); if (!s.size) return; saveWork({ days: [...s] }); },
      }, dayNames[d])));
      return {
        nodes: [
          group(choice('', 'pres.online', 'user'), choice('busy', 'pres.busy', 'bell'), choice('away', 'pres.away', 'clock')),
          note(t('pres.hint')),
          heading(t('pres.auto')),
          group(switchRow(t('pres.auto_on'), S.me.auto_reply_on, (v) => save({ auto_reply_on: v }), t('pres.auto_hint'))),
          group(h('div', { class: 'sfield' }, text,
            h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } },
              h('button', { class: 'btn', type: 'button', onclick: () => save({ auto_reply: text.value.trim() }).then(() => toast(t('pres.saved'))) }, t('settings.save'))))),
          heading(t('work.title')),
          group(switchRow(t('work.on'), w.on, (v) => saveWork({ on: v }), t('work.hint'))),
          w.on ? group(h('div', { class: 'sfield' }, days,
            h('div', { class: 'focus-times' }, h('label', null, t('work.from'), from), h('label', null, t('work.to'), to)),
            away,
            h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } },
              h('button', { class: 'btn', type: 'button', onclick: () => saveWork({ from: from.value || w.from, to: to.value || w.to, text: away.value.trim() }).then(() => toast(t('pres.saved'))) }, t('settings.save'))))) : null,
          heading(t('work.greeting')),
          group(h('div', { class: 'sfield' }, greet, h('small', { class: 'muted' }, t('work.greeting_hint')),
            h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '8px' } },
              h('button', { class: 'btn', type: 'button', onclick: () => save({ greeting: greet.value.trim() }).then(() => toast(t('pres.saved'))) }, t('settings.save'))))),
        ].filter(Boolean),
      };
    },
  };

  const privacyRow = (field, labelKey) => {
    const cur = S.me.privacy?.[field] || 'everyone';
    return row(null, t(labelKey), { value: t(`privacy.${cur}`), onclick: () => go({
      title: () => t(labelKey),
      render: () => ({
        nodes: [heading(t('st.who_sees')), group(...PRIVACY_VALUES.map((v) => radio(t(`privacy.${v}`), (S.me.privacy?.[field] || 'everyone') === v, async () => {
          try { S.me = (await api('PATCH', '/api/me', { privacy: { [field]: v } })).user; fire('me'); draw(); } catch (e) { fail(e); }
        })))],
      }),
    }) });
  };

  pages.privacy = {
    title: () => t('st.privacy'),
    render() {
      const sessN = h('span');
      const blockN = h('span');
      api('GET', '/api/sessions').then((r) => { sessN.textContent = String(r.sessions.length); }).catch(() => {});
      api('GET', '/api/blocks').then((r) => { blockN.textContent = String(r.users.length); }).catch(() => {});
      return {
        nodes: [
          heading(t('st.security')),
          group(
            row('lock', t('lock.title'), { value: lockEnabled() ? t('lock.on') : t('lock.off'), onclick: () => go(pages.applock) }),
            row('user', t('md.title'), { onclick: () => go(pages.mydata) }),
            row('block', t('settings.blocked'), { value: blockN, onclick: () => go(pages.blocked) }),
            row('devices', t('settings.sessions'), { value: sessN, onclick: () => go(pages.sessions) }),
            row('mail', t('settings.email'), { value: S.me.email || t('settings.email_none'), onclick: () => go(pages.account) })),
          note(t('st.sessions_hint')),
          group(switchRow(t('readers.setting'), S.me.read_receipts !== false, async (v) => { try { S.me = (await api('PATCH', '/api/me', { read_receipts: v })).user; fire('me'); } catch (e) { fail(e); } }, t('readers.setting_hint'))),
          group(switchRow(t('shot.setting'), !!S.prefs.noShot, (v) => { S.prefs.noShot = v; savePrefs(); fire('shotguard'); }, screenGuardNative() ? t('shot.hint_app') : t('shot.hint_web'))),
          group(switchRow(t('lp.setting'), !S.prefs.noPreview, (v) => { S.prefs.noPreview = !v; savePrefs(); }, t('lp.setting_hint')), switchRow(t('e2e.default'), S.prefs.secretDefault, (v) => { S.prefs.secretDefault = v; savePrefs(); }, t('e2e.default_hint'))),
          heading(t('settings.privacy')),
          group(privacyRow('photo', 'st.photo'), privacyRow('status', 'st.status'), privacyRow('last_seen', 'st.lastseen'), privacyRow('birthday', 'st.birthday')),
          heading(t('export.title')),
          group(row('download', t('export.all'), { onclick: () => { const a = h('a', { href: '/api/export', download: '' }); document.body.append(a); a.click(); a.remove(); } })),
          note(t('export.hint')),
        ],
      };
    },
  };

  // ---- app lock (PIN / fingerprint)
  pages.applock = {
    title: () => t('lock.title'),
    render() {
      const on = lockEnabled();
      const bioBox = h('div');
      const times = [[0, 'lock.t0'], [60, 'lock.t60'], [300, 'lock.t300'], [900, 'lock.t900'], [3600, 'lock.t3600']];
      if (on) {
        bioAvailable().then((ok) => {
          if (!ok) return;
          clear(bioBox).append(group(switchRow(t('lock.bio'), bioOn(), async (v, input) => {
            if (v) { const done = await enableBio(); if (!done) { input.checked = false; toast(t('lock.bio_fail')); } } else disableBio();
          }, t('lock.bio_hint'))));
        });
      }
      return {
        nodes: [
          group(switchRow(t('lock.enable'), on, async (v, input) => {
            if (v) {
              const ok = await createPin();
              if (!ok) { input.checked = false; return; }
            } else if (await confirmPin()) {
              disableLock();
            } else { input.checked = true; return; }
            draw();
          }, t('lock.hint'))),
          ...(on ? [
            heading(t('lock.after')),
            group(...times.map(([sec, key]) => h('button', { class: 'srow', type: 'button', onclick: () => { setTimeoutSec(sec); draw(); } },
              h('span', { class: 'srow-ico none' }), h('span', { class: 'srow-label' }, t(key)),
              lockTimeout() === sec ? h('span', { class: 'srow-value' }, '\u2713') : null))),
            bioBox,
            group(row('lock', t('lock.now'), { onclick: () => { m.close(); showLock(); } })),
            note(t('lock.note')),
          ] : [note(t('lock.note'))]),
        ],
      };
    },
  };

  // ---- my data: what is stored, my security log, export, delete the account
  pages.mydata = {
    title: () => t('md.title'),
    render() {
      const sumBox = h('div');
      const logBox = h('div');
      api('GET', '/api/me/data').then((d) => {
        clear(sumBox).append(group(
          info(String(d.messages), t('md.messages')), info(String(d.chats), t('md.chats')),
          info(`${d.files} \u00B7 ${formatBytes(d.files_bytes)}`, t('md.files')), info(String(d.drive), t('md.drive')),
          info(String(d.links), t('md.links')), info(String(d.sessions), t('md.sessions')), info(String(d.push_devices), t('md.push'))));
      }).catch(() => {});
      api('GET', '/api/me/activity').then((r) => {
        const names = { 'auth.login': 'md.a_login', 'auth.logout': 'md.a_logout', 'auth.login_failed': 'md.a_failed', 'auth.password_set': 'md.a_password', 'drive.share': 'md.a_share' };
        clear(logBox).append(group(...(r.events.length ? r.events.slice(0, 25).map((e) => h('div', { class: 'srow static md-log' },
          h('span', { class: 'srow-label' }, t(names[e.action] || 'md.a_other'), h('small', null, [new Date(e.ts).toLocaleString(), e.ip, (e.device || '').slice(0, 60)].filter(Boolean).join(' \u00B7 '))))) : [h('div', { class: 'srow static' }, t('md.no_events'))])));
      }).catch(() => {});
      const del = () => {
        const word = h('input', { class: 'input', autocomplete: 'off', placeholder: t('md.type_delete'), 'aria-label': t('md.type_delete') });
        const pw = S.me.has_password ? h('input', { class: 'input', type: 'password', autocomplete: 'current-password', placeholder: t('login.password'), 'aria-label': t('login.password') }) : null;
        const err = h('div', { class: 'err', role: 'alert' });
        const dlg = modal({
          title: t('md.delete'),
          body: [h('p', null, t('md.delete_text')), word, pw, err,
            h('button', { class: 'btn danger', type: 'button', onclick: async (e) => {
              if (!/^(удалить|o['‘’]?chirish|delete)$/i.test(word.value.trim())) { err.textContent = t('md.type_delete'); return; }
              e.currentTarget.disabled = true;
              try {
                await api('DELETE', '/api/me', { confirm: 'DELETE', password: pw?.value || undefined });
                dlg.close();
                fire('logged-out');
              } catch (x) { err.textContent = errText(x.code); e.currentTarget.disabled = false; }
            } }, t('md.delete'))],
        });
      };
      return {
        nodes: [
          heading(t('md.stored')), sumBox, note(t('md.stored_note')),
          heading(t('export.title')),
          group(row('download', t('export.all'), { onclick: () => { const a = h('a', { href: '/api/export', download: '' }); document.body.append(a); a.click(); a.remove(); } })),
          note(t('export.hint')),
          heading(t('md.security')),
          group(row('devices', t('settings.sessions'), { onclick: () => go(pages.sessions) })),
          logBox,
          heading(t('md.danger')),
          group(S.me.is_admin ? h('div', { class: 'srow static' }, t('md.admin_cannot')) : row('trash', t('md.delete'), { danger: true, onclick: del })),
          note(t('md.delete_note')),
        ],
      };
    },
  };

  pages.blocked = {
    title: () => t('settings.blocked'),
    render() {
      const box = h('div');
      const load = async () => {
        try {
          const r = await api('GET', '/api/blocks');
          clear(box).append(r.users.length ? group(...r.users.map((u) => h('div', { class: 'srow static' }, avatar(u, 'sm'),
            h('span', { class: 'srow-label' }, u.name),
            h('button', { class: 'btn secondary', type: 'button', onclick: async () => { await api('DELETE', `/api/blocks/${u.id}`).catch(fail); load(); } }, t('chat.unblock')))))
            : note(t('settings.blocked_none')));
        } catch { /* offline */ }
      };
      return { nodes: [box], after: load };
    },
  };

  pages.sessions = {
    title: () => t('settings.sessions'),
    render() {
      const box = h('div');
      const load = async () => {
        try {
          const r = await api('GET', '/api/sessions');
          clear(box).append(group(...r.sessions.map((s) => h('div', { class: 'srow static' }, h('span', { class: 'srow-ico' }, icon('devices', 22)),
            h('span', { class: 'srow-label' }, shortUA(s.device) || '—',
              h('small', null, `${s.ip} · ${new Date(s.last_active).toLocaleString()}${s.current ? ` · ${t('settings.this_device')}` : ''}`)),
            s.current ? null : h('button', { class: 'btn secondary', type: 'button', onclick: async () => { await api('DELETE', `/api/sessions/${s.id}`).catch(fail); load(); } }, t('settings.terminate'))))),
          r.sessions.length > 1 ? group(row('logout', t('settings.terminate_all'), { danger: true, onclick: async () => { await api('DELETE', '/api/sessions').catch(fail); load(); } })) : null);
        } catch { /* offline */ }
      };
      return { nodes: [box], after: load };
    },
  };

  const themeTile = (key, label) => h('button', {
    class: `theme-tile ${key}${S.prefs.theme === key ? ' on' : ''}`, type: 'button', 'aria-pressed': String(S.prefs.theme === key),
    onclick: () => { S.prefs.theme = key; savePrefs(); fire('theme'); draw(); },
  }, h('span', { class: 'tt-prev' }, h('i'), h('i')), h('span', { class: 'tt-name' }, label));

  const timeInput = (key, def) => {
    const input = h('input', { class: 'input', type: 'time', value: S.prefs[key] || def, style: { width: 'auto' } });
    input.addEventListener('change', () => { S.prefs[key] = input.value || def; savePrefs(); fire('theme'); });
    return input;
  };

  pages.chats = {
    title: () => t('st.chats'),
    render() {
      const size = h('input', { type: 'range', min: 90, max: 150, step: 5, value: Math.round(Number(S.prefs.textScale || 1) * 100), 'aria-label': t('settings.text_size') });
      const val = h('span', { class: 'accent' }, `${size.value}%`);
      size.oninput = () => { val.textContent = `${size.value}%`; };
      size.onchange = () => { S.prefs.textScale = Number(size.value) / 100; savePrefs(); fire('theme'); };
      return {
        nodes: [
          heading(t('st.themes')),
          h('div', { class: 'theme-tiles' }, themeTile('auto', t('st.theme_auto')), themeTile('light', t('st.theme_light')), themeTile('dark', t('st.theme_dark')), themeTile('schedule', t('st.theme_schedule'))),
          ...(S.prefs.theme === 'schedule' ? [group(h('div', { class: 'sfield' }, h('div', { class: 'row between' },
            h('label', null, t('st.theme_from'), ' ', timeInput('themeFrom', '21:00')),
            h('label', null, t('st.theme_to'), ' ', timeInput('themeTo', '07:00')))))] : []),
          heading(t('settings.text_size')),
          group(h('div', { class: 'sfield' }, h('div', { class: 'row between' }, h('span', null, t('settings.text_size')), val), size)),
          group(row('folder', t('st.folders'), { value: String((S.folders || []).length), onclick: () => openFolders() })),
        ],
      };
    },
  };

  pages.advanced = {
    title: () => t('st.advanced'),
    render() {
      const server = navigator.userAgent.includes('SuhbatShell/') ? shellNodes() : [];
      return {
        nodes: [
          heading(t('st.motion')),
          group(switchRow(t('st.motion_lite'), motionLevel() === 'lite', (v) => setLiteMotion(v), t('st.motion_hint'))),
          heading(t('st.updates')),
          group(h('div', { class: 'sfield' }, ...updatesSection().slice(1))),
          heading(t('settings.shortcuts')),
          group(h('dl', { class: 'keys sfield' }, [['Ctrl/⌘ + K', 'search'], ['Ctrl/⌘ + ,', 'settings'], ['Ctrl/⌘ + Shift + F', 'search'], ['Alt + ↑ / ↓', 'next'], ['Esc', 'close'], ['Ctrl/⌘ + I', 'info'], ['Enter', 'send'], ['↑', 'edit']]
            .flatMap(([k, v]) => [h('dt', null, h('kbd', null, k)), h('dd', null, t(`shortcuts.${v}`))]))),
        ],
      };
    },
  };

  const KB = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);
  const stateText = (s, err) => ({ preparing: t('up.preparing'), queued: t('up.queued'), uploading: t('dl.active'), downloading: t('dl.active'), paused: t('up.paused'), waiting: t('up.waiting'), done: t('dl.done'), error: err ? `${t('up.error')} (${err})` : t('up.error') })[s] || s;

  // everything that is being sent or received, with controls; interrupted uploads that the server still holds are listed too
  pages.transfers = {
    title: () => t('dl.title'),
    render() {
      const box = h('div');
      let remote = [];
      const item = (name, size, loaded, state, err, actions) => {
        const pct = size ? Math.min(100, Math.round((loaded / size) * 100)) : 0;
        const bar = h('span', { class: 'up-bar' });
        bar.style.width = `${pct}%`;
        return h('div', { class: 'xfer' },
          h('div', { class: 'xfer-main' }, h('b', { class: 'ellipsis' }, name),
            h('span', { class: 'muted' }, `${stateText(state, err)} · ${KB(loaded)} / ${KB(size)} · ${pct}%`),
            h('span', { class: 'up-track' }, bar)),
          h('div', { class: 'xfer-act' }, actions));
      };
      const btn = (txt, label, fn) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, onclick: fn }, txt);
      const paint = () => {
        if (!box.isConnected) return;
        const ups = listUploads();
        const downs = listDownloads();
        const localIds = new Set(ups.map((u) => u.uploadId).filter(Boolean));
        const nodes = [];
        nodes.push(heading(t('dl.sending')));
        const upRows = ups.filter((u) => u.state !== 'done').map((u) => item(u.name, u.size, u.loaded || u.sent || 0, u.state, u.error, [
          ['uploading', 'preparing', 'queued'].includes(u.state) ? btn('⏸', t('up.pause'), () => pauseUpload(u.id)) : null,
          ['paused', 'waiting', 'error'].includes(u.state) ? btn('▶', t('up.resume'), () => resumeUpload(u.id)) : null,
          btn('✕', t('chat.cancel'), () => { cancelUpload(u.id); paint(); }),
        ]));
        const staleRows = remote.filter((r) => !localIds.has(r.upload_id)).map((r) => item(r.name, r.size, r.received, 'paused', '', [
          btn('✕', t('dl.discard'), async () => { try { await api('DELETE', `/api/uploads/${r.upload_id}`); remote = remote.filter((x) => x !== r); paint(); } catch (e) { fail(e); } }),
        ]));
        nodes.push(group(...(upRows.length || staleRows.length ? [...upRows, ...staleRows] : [h('div', { class: 'sfield muted' }, t('dl.none'))])));
        if (staleRows.length) nodes.push(note(t('dl.stale_hint')));
        nodes.push(heading(t('dl.receiving')));
        const downRows = downs.map((d) => item(d.file.name, d.total, d.loaded, d.state, d.error, [
          ['downloading', 'queued'].includes(d.state) ? btn('⏸', t('up.pause'), () => pauseDownload(d.id)) : null,
          ['paused', 'error'].includes(d.state) ? btn(d.state === 'error' ? '↻' : '▶', t('up.resume'), () => resumeDownload(d.id)) : null,
          btn('✕', t('chat.cancel'), () => { cancelDownload(d.id); paint(); }),
        ]));
        nodes.push(group(...(downRows.length ? downRows : [h('div', { class: 'sfield muted' }, t('dl.none'))])));
        box.replaceChildren(...nodes);
      };
      const offs = [onUpload((_t, type) => { if (type === 'state') paint(); else paintLight(); }), onDownload((_t, type) => { if (type === 'state') paint(); else paintLight(); })];
      let lightT = 0;
      function paintLight() { const n = Date.now(); if (n - lightT > 400) { lightT = n; paint(); } }
      api('GET', '/api/uploads').then((r) => { remote = r.uploads || []; paint(); }).catch(() => {});
      queueMicrotask(paint);
      const timer = setInterval(() => { if (!box.isConnected) { clearInterval(timer); offs.forEach((o) => o()); } }, 2000);
      return { nodes: [box] };
    },
  };

  // automatic download: separately for Wi-Fi, mobile data and roaming
  pages.autodl = {
    title: () => t('auto.title'),
    render() {
      const cur = netClass();
      const nodes = [note(t('auto.hint', { net: t(`auto.net_${cur}`) }))];
      for (const net of ['wifi', 'cellular', 'roaming']) {
        const p = autoPolicy()[net];
        const max = h('input', { class: 'input', type: 'number', min: 0, max: 2000, value: p.max, 'aria-label': t('auto.max'), style: { maxWidth: '110px' } });
        max.addEventListener('change', () => setAutoPolicy(net, { max: Math.max(0, Math.min(2000, Number(max.value) || 0)) }));
        nodes.push(heading(t(`auto.net_${net}`) + (net === cur ? ` · ${t('auto.now')}` : '')));
        nodes.push(group(
          switchRow(t('auto.photo'), p.photo, (v) => setAutoPolicy(net, { photo: v })),
          switchRow(t('auto.video'), p.video, (v) => setAutoPolicy(net, { video: v })),
          switchRow(t('auto.file'), p.file, (v) => setAutoPolicy(net, { file: v })),
          h('div', { class: 'sfield row' }, h('span', null, t('auto.max')), max, h('span', { class: 'muted' }, 'MB'))));
      }
      nodes.push(group(h('div', { class: 'sfield' }, h('button', { class: 'btn secondary', type: 'button', onclick: () => { S.prefs.auto = JSON.parse(JSON.stringify(DEFAULT_AUTO)); savePrefs(); toast(t('settings.saved')); go(pages.autodl); } }, t('auto.reset')))));
      return { nodes };
    },
  };

  pages.av = {
    title: () => t('st.av'),
    render() {
      const box = h('div', { class: 'sfield' });
      return {
        nodes: [group(box)],
        after: () => callSettingsSection().then((nodes) => box.append(...nodes)).catch(() => {}),
      };
    },
  };

  pages.language = {
    title: () => t('settings.language'),
    render: () => ({
      nodes: [heading(t('st.language_pick')), group(...Object.entries(LANGS).map(([k, label]) => radio(label, getLang() === k, () => {
        S.prefs.lang = k;
        savePrefs();
        fire('relang');
        m.close();
      })))],
    }),
  };

  m = modal({ title: t('settings.title'), body: [], className: 'settings-modal', bare: true, onClose: () => { while (pageLayers.length) closeLayer(pageLayers.pop()); } });
  stack.push(pages.root);
  draw();
  void home;
  return m;
}

/** Where the notification windows appear (desktop app): a monitor with four corners + how many at once. */
function notifPlacement() {
  const box = h('div', { class: 'sgroup notif-place' });
  const paint = (p) => {
    const corner = (key) => h('button', { class: `np-corner ${key}${p.corner === key ? ' on' : ''}`, type: 'button', 'aria-label': key, onclick: async () => paint(await window.suhbatShell.setNotifPrefs({ corner: key, count: p.count })) },
      h('i'), h('i'), h('i'));
    const counts = h('div', { class: 'np-counts', role: 'radiogroup', 'aria-label': t('st.notif_count') }, [1, 2, 3, 4, 5].map((n) => h('button', {
      class: p.count === n ? 'on' : '', type: 'button', role: 'radio', 'aria-checked': String(p.count === n),
      onclick: async () => paint(await window.suhbatShell.setNotifPrefs({ corner: p.corner, count: n })),
    }, String(n))));
    clear(box).append(
      h('div', { class: 'np-screen' }, corner('tl'), corner('tr'), corner('bl'), corner('br')),
      h('div', { class: 'sheading' }, t('st.notif_count')), counts);
  };
  window.suhbatShell.getNotifPrefs().then(paint).catch(() => {});
  return box;
}

/** "Used X of Y" for the storage quota the administrator set (hidden when unlimited). */
function usageGroup() {
  const box = h('div');
  api('GET', '/api/me/usage').then((u) => {
    const mb = (n) => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : `${(n / 1048576).toFixed(1)} MB`);
    clear(box).append(group(h('div', { class: 'sfield' }, h('span', null, t('quota.title')),
      h('b', null, u.quota ? `${mb(u.used)} / ${mb(u.quota)}` : `${mb(u.used)} · ${t('quota.unlimited')}`))));
  }).catch(() => {});
  return box;
}

function radio(label, on, onclick) {
  return h('button', { class: 'srow', type: 'button', role: 'radio', 'aria-checked': String(on), onclick },
    h('span', { class: `radio${on ? ' on' : ''}` }), h('span', { class: 'srow-label' }, label));
}

function shortUA(ua = '') {
  const br = /(Edg|Chrome|Firefox|Safari|OPR)\//.exec(ua)?.[1];
  const os = /(Windows|Android|iPhone|iPad|Mac OS X|Linux)/.exec(ua)?.[1];
  return [br === 'Edg' ? 'Edge' : br === 'OPR' ? 'Opera' : br, os].filter(Boolean).join(' · ') || ua.slice(0, 40);
}

function shellNodes() {
  const ua = navigator.userAgent;
  const out = [h('div', { class: 'muted', style: { marginBottom: '8px' } }, location.origin)];
  if (ua.includes('SuhbatShell/mobile')) {
    const homeUrl = /Android/i.test(ua) ? 'https://localhost/?change=1' : 'capacitor://localhost/?change=1';
    out.push(h('button', { class: 'btn secondary', type: 'button', onclick: () => { location.href = homeUrl; } }, t('settings.server_change')));
  } else {
    out.push(h('div', { class: 'muted' }, t('settings.server_hint')));
  }
  return out;
}

/** Set or change the password (the account's login is its username). */
function passwordBox(refresh) {
  const box = h('div', { class: 'st-password' });
  const me = S.me;
  const msg = h('div', { class: 'err', role: 'alert' });
  const login = me.username ? null : h('input', { class: 'input', autocomplete: 'username', autocapitalize: 'none', spellcheck: false, maxLength: LIMITS.USERNAME_MAX, placeholder: t('login.login'), 'aria-label': t('login.login') });
  const cur = me.has_password ? h('input', { class: 'input', type: 'password', autocomplete: 'current-password', maxLength: 200, placeholder: t('st.password_current'), 'aria-label': t('st.password_current') }) : null;
  const next = h('input', { class: 'input', type: 'password', autocomplete: 'new-password', maxLength: 200, placeholder: t('st.password_new'), 'aria-label': t('st.password_new') });
  const go = h('button', { class: 'btn', type: 'button' }, me.has_password ? t('st.password_change') : t('st.password_set'));
  go.onclick = async () => {
    msg.textContent = '';
    go.disabled = true;
    try {
      const r = await api('POST', '/api/me/password', {
        new_password: next.value, ...(cur ? { current_password: cur.value } : {}), ...(login ? { username: login.value.trim() } : {}),
      });
      S.me = r.user;
      fire('me');
      toast(t('st.password_saved'));
      refresh();
    } catch (e) { msg.textContent = errText(e.code); go.disabled = false; }
  };
  box.append(me.username ? h('p', { class: 'muted' }, `${t('login.login')}: ${me.username}`) : login, cur, next, msg, go);
  return box;
}

/** Link / change / unlink an e-mail address (a second way to sign in). */
export function drawEmail(box, refresh) {
  const view = (stage = 'view', pending = '') => {
    clear(box);
    const msg = h('div', { class: 'err', role: 'alert' });
    if (stage === 'view') {
      box.append(
        h('div', null, S.me.email ? h('b', null, S.me.email) : h('span', { class: 'muted' }, t('settings.email_none'))),
        h('div', { class: 'row', style: { marginTop: '8px' } },
          h('button', { class: 'btn secondary', type: 'button', onclick: () => view('enter') }, S.me.email ? t('settings.email_change') : t('settings.email_link')),
          S.me.email ? h('button', { class: 'btn link', type: 'button', onclick: async () => {
            try { S.me = (await api('DELETE', '/api/me/email')).user; view(); refresh(); } catch (e) { toast(errText(e.code)); }
          } }, t('common.delete')) : null));
    } else if (stage === 'enter') {
      const input = h('input', { class: 'input', type: 'email', placeholder: 'name@example.com', autocomplete: 'email', 'aria-label': t('settings.email') });
      const go = h('button', { class: 'btn', type: 'button' }, t('login.email_send'));
      go.onclick = async () => {
        msg.textContent = '';
        go.disabled = true;
        try { await api('POST', '/api/me/email', { email: input.value.trim() }); view('code', input.value.trim().toLowerCase()); } catch (e) { msg.textContent = errText(e.code); go.disabled = false; }
      };
      box.append(input, msg, go);
    } else {
      const code = h('input', { class: 'input', inputMode: 'numeric', maxLength: 6, placeholder: '000000', autocomplete: 'one-time-code', 'aria-label': t('login.code') });
      const ok = h('button', { class: 'btn', type: 'button' }, t('login.verify'));
      ok.onclick = async () => {
        msg.textContent = '';
        ok.disabled = true;
        try { S.me = (await api('POST', '/api/me/email/verify', { email: pending, code: code.value.trim() })).user; fire('me'); view(); refresh(); toast(t('settings.saved')); } catch (e) { msg.textContent = errText(e.code); ok.disabled = false; }
      };
      box.append(h('p', { class: 'muted' }, t('login.email_sent', { email: pending })), code, msg, ok);
    }
  };
  view();
}

void confirmDialog;
