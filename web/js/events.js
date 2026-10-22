// Meetings and events in chats: an event card with RSVP, a creation dialog, and the calendar of upcoming events.
import { h, clear } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { chatTitle } from './state.js';
import { modal, toast, confirmDialog } from './ui.js';

const loc = () => (getLang() === 'uz' ? 'uz-UZ' : 'ru-RU');
const fmtFull = (ts) => new Date(ts).toLocaleString(loc(), { weekday: 'short', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
const fmtTimeOnly = (ts) => new Date(ts).toLocaleTimeString(loc(), { hour: '2-digit', minute: '2-digit' });
const fmtDayHead = (ts) => new Date(ts).toLocaleDateString(loc(), { weekday: 'long', day: 'numeric', month: 'long' });
const dayKey = (ts) => new Date(ts).toDateString();

function relative(ev) {
  const now = Date.now();
  if (ev.canceled) return t('ev.canceled');
  if (now >= ev.start_at && now <= ev.end_at) return t('ev.now');
  if (now > ev.end_at) return t('ev.over');
  const min = Math.round((ev.start_at - now) / 60000);
  if (min < 60) return t('ev.in_min', { n: min });
  if (min < 24 * 60) return t('ev.in_h', { n: Math.round(min / 60) });
  return t('ev.in_d', { n: Math.round(min / 1440) });
}

// ---------------------------------------------------------------- the card in a chat
export function eventNode(m) {
  const ev = m.event;
  const mine = ev.rsvp.yes.includes(S.me.id) ? 'yes' : ev.rsvp.maybe.includes(S.me.id) ? 'maybe' : ev.rsvp.no.includes(S.me.id) ? 'no' : null;
  const answer = async (status) => {
    try { await api('POST', `/api/events/${ev.id}/rsvp`, { status: mine === status ? null : status }); } catch (e) { toast(errText(e.code)); }
  };
  const nameOf = (id) => S.users.get(id)?.name || (id === S.me.id ? S.me.name : '');
  const who = (ids) => ids.map(nameOf).filter(Boolean).join(', ');
  const over = Date.now() > ev.end_at;
  const btn = (status, label) => h('button', {
    class: `ev-btn${mine === status ? ' on' : ''}`, type: 'button', 'aria-pressed': String(mine === status), disabled: ev.canceled || over || m.pending, onclick: () => answer(status),
  }, `${label} · ${ev.rsvp[status].length}`);
  const canJoin = ev.meeting && !ev.canceled && Date.now() >= ev.start_at - 10 * 60000 && !over;
  const chat = S.chats.get(m.chat_id);
  const join = canJoin ? h('button', { class: 'btn small', type: 'button', onclick: async () => {
    if (chat?.type === 'direct') { const { startCall } = await import('./call.js'); startCall(chat.id, true); } else { const g = await import('./gcall.js'); g.joinGroupCall(m.chat_id, true); }
  } }, `\u{1F4F9} ${t('ev.join')}`) : null;
  const author = ev.creator_id === S.me.id || chat?.my_role === 'owner' || chat?.my_role === 'admin';
  return h('div', { class: `event${ev.canceled ? ' canceled' : ''}${over ? ' over' : ''}` },
    h('div', { class: 'ev-head' },
      h('span', { class: 'ev-ico' }, icon('clock', 22)),
      h('div', { class: 'ev-main' }, h('b', { class: 'ev-title' }, ev.title),
        h('div', { class: 'ev-when' }, `${fmtFull(ev.start_at)} – ${fmtTimeOnly(ev.end_at)}`),
        h('div', { class: 'ev-rel' }, relative(ev)))),
    ev.location ? h('div', { class: 'ev-line' }, `\u{1F4CD} ${ev.location}`) : null,
    ev.meeting ? h('div', { class: 'ev-line' }, `\u{1F4F9} ${t('ev.video')}`) : null,
    ev.description ? h('div', { class: 'ev-desc' }, ev.description) : null,
    h('div', { class: 'ev-rsvp' }, btn('yes', t('ev.yes')), btn('maybe', t('ev.maybe')), btn('no', t('ev.no'))),
    ev.rsvp.yes.length ? h('small', { class: 'ev-who' }, `${t('ev.yes')}: ${who(ev.rsvp.yes)}`) : null,
    h('div', { class: 'ev-foot' },
      join,
      h('a', { class: 'btn secondary small', href: `/api/events/${ev.id}/ics`, download: `event-${ev.id}.ics` }, t('ev.ics')),
      author && !ev.canceled && !over ? h('button', { class: 'btn link', type: 'button', onclick: async () => {
        if (await confirmDialog(t('ev.cancel_confirm'), { okLabel: t('ev.cancel'), danger: true })) api('POST', `/api/events/${ev.id}/cancel`).catch((e) => toast(errText(e.code)));
      } }, t('ev.cancel')) : null));
}

// ---------------------------------------------------------------- creation dialog
export function openEventCreate(chatId) {
  const title = h('input', { class: 'input', maxLength: 120, placeholder: t('ev.title_ph'), 'aria-label': t('ev.title_ph') });
  const when = h('input', { class: 'input', type: 'datetime-local', 'aria-label': t('ev.when') });
  const soon = new Date(Date.now() + 3600000);
  soon.setMinutes(0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  when.value = `${soon.getFullYear()}-${pad(soon.getMonth() + 1)}-${pad(soon.getDate())}T${pad(soon.getHours())}:00`;
  const dur = h('select', { class: 'input', 'aria-label': t('ev.duration') },
    [[30, 'ev.d30'], [60, 'ev.d60'], [90, 'ev.d90'], [120, 'ev.d120'], [240, 'ev.d240']].map(([v, k]) => h('option', { value: v, selected: v === 60 }, t(k))));
  const place = h('input', { class: 'input', maxLength: 120, placeholder: t('ev.place_ph'), 'aria-label': t('ev.place_ph') });
  const desc = h('textarea', { class: 'input', rows: 2, maxLength: 500, placeholder: t('ev.desc_ph'), 'aria-label': t('ev.desc_ph') });
  const meeting = h('input', { type: 'checkbox', id: 'ev-meeting' });
  const err = h('div', { class: 'err', role: 'alert' });
  const m = modal({
    title: t('ev.new'),
    body: [title, h('label', { class: 'field' }, h('span', null, t('ev.when')), when), h('label', { class: 'field' }, h('span', null, t('ev.duration')), dur), place, desc,
      h('label', { class: 'row', for: 'ev-meeting' }, meeting, t('ev.with_video')), err,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const start = new Date(when.value).getTime();
        if (!title.value.trim()) { err.textContent = t('ev.need_title'); return; }
        if (!Number.isFinite(start) || start < Date.now() - 60000) { err.textContent = t('ev.need_future'); return; }
        try {
          await api('POST', `/api/chats/${chatId}/events`, {
            title: title.value.trim(), start_at: start, duration_min: Number(dur.value), location: place.value.trim(), description: desc.value.trim(), meeting: meeting.checked,
          });
          m.close();
        } catch (e) { err.textContent = errText(e.code); }
      } }, t('chat.send'))],
  });
  setTimeout(() => title.focus(), 50);
}

// ---------------------------------------------------------------- calendar
export async function openCalendar() {
  const box = h('div', { class: 'cal' }, h('p', { class: 'muted' }, t('net.connecting')));
  const win = modal({ title: t('ev.calendar'), className: 'drive', body: [box] });
  let events = [];
  try { events = (await api('GET', '/api/events/upcoming')).events; } catch (e) { toast(errText(e.code)); }
  clear(box);
  if (!events.length) { box.append(h('p', { class: 'muted drive-empty' }, t('ev.none'))); return; }
  let last = '';
  for (const e of events) {
    if (dayKey(e.start_at) !== last) { last = dayKey(e.start_at); box.append(h('h3', { class: 'cal-day' }, fmtDayHead(e.start_at))); }
    const chat = S.chats.get(e.chat_id);
    box.append(h('button', { class: 'cal-row', type: 'button', onclick: () => {
      win.close();
      fire('open-chat', e.chat_id);
      import('./chat.js').then((c) => c.jumpTo(e.chat_id, e.message_id));
    } },
    h('span', { class: 'cal-time' }, fmtTimeOnly(e.start_at)),
    h('span', { class: 'cal-main' }, h('b', { class: 'ellipsis' }, e.title),
      h('small', { class: 'muted ellipsis' }, [chat ? chatTitle(chat) : e.chat_title, e.location, e.meeting ? '\u{1F4F9}' : ''].filter(Boolean).join(' · '))),
    e.mine ? h('span', { class: `cal-rsvp ${e.mine}` }, t(`ev.${e.mine}`)) : null));
  }
}
