// Share a location or a contact, and the tap-on-a-phone-number menu (call / write / copy).
import { h, uuid } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { avatar, modal, popMenu, toast } from './ui.js';
import { icon } from './icons.js';
import { startCall } from './call.js';

/** Open tel:/mailto:/https: links the way the platform wants (the Android shell has its own opener). */
export function openExternal(url) {
  try {
    if (window.SuhbatNative?.openUrl) { window.SuhbatNative.openUrl(url); return; }
  } catch { /* fall through */ }
  if (/^https?:/i.test(url)) window.open(url, '_blank', 'noopener,noreferrer');
  else window.location.href = url;
}

// ------------------------------------------------------------------ location
const GEO_RE = /^geo:(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)$/;

export function parseGeo(text) {
  const m = GEO_RE.exec(String(text || '').trim());
  if (!m) return null;
  const lat = Number(m[1]);
  const lng = Number(m[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** "Where am I": once, or as a live position for a quarter of an hour, an hour or eight hours. */
export function sendLocation(chatId, done) {
  if (!navigator.geolocation) { toast(t('geo.unsupported')); return; }
  const win = modal({
    title: t('attach.location'),
    body: h('div', { class: 'geo-choice' },
      h('button', { class: 'btn', type: 'button', onclick: () => { win.close(); sendLocationOnce(chatId, done, 0); } }, t('geo.now')),
      h('p', { class: 'muted' }, t('geo.live_hint')),
      ...[[15, 'geo.live_15'], [60, 'geo.live_60'], [480, 'geo.live_480']].map(([min, key]) => h('button', { class: 'btn secondary', type: 'button', onclick: () => { win.close(); sendLocationOnce(chatId, done, min); } }, `\u{1F4E1} ${t(key)}`))),
  });
}

// ---- live position: the phone sends where it is every few seconds while the app is open
const lives = new Map(); // message id -> { until, watch }
const LIVE_KEY = 'suhbat.live';
const saveLives = () => { try { localStorage.setItem(LIVE_KEY, JSON.stringify([...lives].map(([id, v]) => [id, v.until]))); } catch { /* private mode */ } };

export function stopLive(id, tell = true) {
  const v = lives.get(id);
  if (v) { navigator.geolocation.clearWatch(v.watch); lives.delete(id); saveLives(); }
  if (tell) api('POST', `/api/messages/${id}/live/stop`).catch(() => {});
}

export function startLive(id, until) {
  if (lives.has(id) || !navigator.geolocation || until <= Date.now()) return;
  let last = 0;
  const watch = navigator.geolocation.watchPosition((p) => {
    if (Date.now() > until) { stopLive(id, false); return; }
    if (Date.now() - last < 8000) return;
    last = Date.now();
    api('PUT', `/api/messages/${id}/live`, { lat: p.coords.latitude, lon: p.coords.longitude }).catch((e) => { if (e.status === 409 || e.status === 404) stopLive(id, false); });
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  lives.set(id, { until, watch });
  saveLives();
  setTimeout(() => stopLive(id, false), Math.max(1000, until - Date.now()));
}

/** After a reload: a broadcast that has not ended yet continues. */
export function resumeLives() {
  try {
    for (const [id, until] of JSON.parse(localStorage.getItem(LIVE_KEY) || '[]')) if (until > Date.now()) startLive(id, until);
  } catch { /* nothing saved */ }
}

function sendLocationOnce(chatId, done, liveMinutes) {
  toast(t('geo.getting'));
  navigator.geolocation.getCurrentPosition(async (p) => {
    try {
      const text = `geo:${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`;
      const r = await api('POST', `/api/chats/${chatId}/messages`, { kind: 'location', text, client_id: uuid(), ...(liveMinutes ? { live_minutes: liveMinutes } : {}) });
      done?.(r.message);
      if (r.message.live_until) startLive(r.message.id, r.message.live_until);
    } catch (e) { toast(errText(e.code)); }
  }, (err) => toast(t(err.code === 1 ? 'geo.denied' : 'geo.failed')),
  { enableHighAccuracy: true, timeout: 20000, maximumAge: 30000 });
}

export function locationNode(m) {
  const g = parseGeo(m.text);
  if (!g) return h('div', { class: 'text' }, m.text);
  // Yandex Maps takes longitude first: pt=lng,lat
  const url = `https://yandex.ru/maps/?pt=${g.lng},${g.lat}&z=16&l=map`;
  const live = m.live_until ? m.live_until > Date.now() : null;
  const clock = m.live_until ? new Date(m.live_until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
  const card = h('button', { class: `geo-card${live ? ' live' : ''}`, type: 'button', onclick: () => openExternal(url) },
    h('span', { class: 'geo-pin' }, icon('pin', 26)),
    h('span', { class: 'geo-txt' }, h('b', null, live ? `\u{1F534} ${t('geo.live_on', { time: clock })}` : m.live_until ? t('geo.live_off') : t('msg.location')),
      h('span', { class: 'muted' }, `${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}`),
      h('span', { class: 'geo-open' }, t('geo.open'))));
  if (live && m.sender_id === S.me.id) {
    return h('div', { class: 'geo-wrap' }, card, h('button', { class: 'btn small danger', type: 'button', onclick: () => stopLive(m.id) }, t('geo.stop')));
  }
  return card;
}

// ------------------------------------------------------------------ contact
export function parseContact(text) {
  try {
    const c = JSON.parse(text);
    if (c && typeof c.name === 'string') return c;
  } catch { /* not JSON */ }
  return null;
}

export function contactNode(m) {
  const c = parseContact(m.text);
  if (!c) return h('div', { class: 'text' }, m.text);
  const known = c.user_id ? S.users.get(c.user_id) : null;
  const actions = [];
  if (c.phone) actions.push(h('button', { class: 'btn small', type: 'button', onclick: (e) => phoneMenu(e.currentTarget, c.phone) }, t('phone.call')));
  if (c.user_id && c.user_id !== S.me?.id) actions.push(h('button', { class: 'btn small', type: 'button', onclick: () => openUser(c.user_id) }, t('contact.write')));
  return h('div', { class: 'contact-card' },
    h('div', { class: 'contact-top' }, avatar(known || { id: c.user_id || 0, name: c.name }),
      h('span', { class: 'contact-txt' }, h('b', null, c.name), c.phone ? h('span', { class: 'muted' }, c.phone) : null)),
    actions.length ? h('div', { class: 'contact-actions' }, actions) : null);
}

async function openUser(userId) {
  try {
    const r = await api('POST', '/api/chats/direct', { user_id: userId });
    S.chats.set(r.chat.id, r.chat);
    fire('chats');
    fire('open-chat', r.chat.id);
  } catch (e) { toast(errText(e.code)); }
}

export function openContactShare(chatId, done) {
  const send = async (payload) => {
    try {
      const r = await api('POST', `/api/chats/${chatId}/messages`, { kind: 'contact', text: JSON.stringify(payload), client_id: uuid() });
      done?.(r.message);
      m.close();
    } catch (e) { toast(errText(e.code)); }
  };
  const filter = h('input', { class: 'input', placeholder: t('search.people'), 'aria-label': t('search.people') });
  const list = h('div', { class: 'contact-list', role: 'list' });
  const name = h('input', { class: 'input', maxLength: 64, placeholder: t('contact.name'), 'aria-label': t('contact.name') });
  const phone = h('input', { class: 'input', type: 'tel', maxLength: 20, placeholder: t('contact.phone'), 'aria-label': t('contact.phone') });
  const draw = () => {
    const term = filter.value.trim().toLowerCase();
    const rows = [];
    if (S.me && !term) {
      rows.push(h('button', { class: 'ci', type: 'button', role: 'listitem',
        onclick: () => send({ name: S.me.name, phone: S.me.phone || '', user_id: S.me.id }) },
      avatar(S.me), h('span', { class: 'ci-main' }, h('span', { class: 'ci-title ellipsis' }, t('contact.mine')),
        h('span', { class: 'ci-last ellipsis' }, S.me.phone || S.me.name))));
    }
    const users = [...S.users.values()].filter((u) => u.id !== S.me?.id && !u.is_bot
      && (!term || `${u.name} ${u.username || ''}`.toLowerCase().includes(term)));
    for (const u of users.slice(0, 60)) {
      rows.push(h('button', { class: 'ci', type: 'button', role: 'listitem', onclick: () => send({ name: u.name, user_id: u.id }) },
        avatar(u), h('span', { class: 'ci-main' }, h('span', { class: 'ci-title ellipsis' }, u.name),
          h('span', { class: 'ci-last ellipsis' }, u.username ? `@${u.username}` : ''))));
    }
    list.replaceChildren(...rows);
  };
  filter.addEventListener('input', draw);
  draw();
  const manual = h('div', { class: 'contact-manual' }, h('h3', null, t('contact.manual')), name, phone,
    h('button', { class: 'btn', type: 'button', onclick: () => {
      const n = name.value.trim();
      const p = phone.value.trim();
      if (!n || !/^\+?[\d\s().-]{5,20}$/.test(p)) { toast(t('contact.invalid')); return; }
      send({ name: n, phone: p });
    } }, t('contact.send')));
  const m = modal({ title: t('attach.contact'), body: [filter, list, manual] });
}

// ------------------------------------------------------------------ phone numbers inside text
async function lookupUser(phone) {
  try {
    const r = await Promise.race([
      api('GET', `/api/users/search?q=${encodeURIComponent(phone)}`),
      new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
    ]);
    return r?.users?.[0] ?? null;
  } catch { return null; }
}

async function phoneMenu(anchor, phone) {
  const user = phone === S.me?.phone ? null : await lookupUser(phone);
  const items = [{ label: `${t('phone.call')} ${phone}`, onClick: () => openExternal(`tel:${phone}`) }];
  if (user) {
    items.push({ label: `${t('contact.write')} · ${user.name}`, onClick: () => openUser(user.id) });
    items.push({ label: `${t('phone.call_app')} · ${user.name}`, onClick: async () => {
      try {
        const r = await api('POST', '/api/chats/direct', { user_id: user.id });
        S.chats.set(r.chat.id, r.chat);
        startCall(r.chat.id, false);
      } catch (e) { toast(errText(e.code)); }
    } });
  }
  items.push({ label: t('phone.copy'), onClick: () => {
    (navigator.clipboard?.writeText(phone) ?? Promise.reject()).then(() => toast(t('phone.copied')), () => toast(phone));
  } });
  popMenu(anchor, items);
}

let wired = false;
export function initPhoneMenu() {
  if (wired) return;
  wired = true;
  document.addEventListener('suhbat:phone', (e) => phoneMenu(e.detail.el, e.detail.phone));
}
