// Focus mode: pause notifications by hand or on a schedule, and let chosen people, mentions and urgent messages through.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';
import { focusActive, focusAllows, normalizeFocus } from '/shared/focus.js';

export const myFocus = () => normalizeFocus(S.me?.focus);
export const focusOn = () => focusActive(myFocus());

/** Does focus mode silence this incoming message here? */
export function focusMutes(chat, m) {
  if (!S.me || !focusOn()) return false;
  const mention = !!S.me.username && new RegExp(`@${S.me.username}\\b`, 'i').test(m.text || '');
  return !focusAllows(myFocus(), { senderId: m.sender_id, urgent: !!m.urgent, mention });
}

async function save(next) {
  const tz = -new Date().getTimezoneOffset();
  const r = await api('PATCH', '/api/me', { focus: { ...next, tz } });
  S.me = r.user;
  fire('me');
  fire('focus');
}

/** Short text for the settings row / tooltip. */
export function focusSummary() {
  const f = myFocus();
  if (f.on && (f.until === 0 || f.until > Date.now())) {
    return f.until ? t('focus.until', { time: new Date(f.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) }) : t('focus.on');
  }
  if (focusOn()) return t('focus.by_schedule');
  return f.sched ? t('focus.sched_set', { from: f.sched.from, to: f.sched.to }) : t('focus.off');
}

export function openFocus() {
  const f = myFocus();
  const state = { ...f, allow: new Set(f.allow), sched: f.sched ? { ...f.sched, days: [...f.sched.days] } : null };
  const body = h('div', { class: 'focus' });
  let win;
  const dayNames = [t('day.sun'), t('day.mon'), t('day.tue'), t('day.wed'), t('day.thu'), t('day.fri'), t('day.sat')];

  const commit = async () => {
    try {
      await save({ on: state.on, until: state.until, sched: state.sched, allow: [...state.allow], calls: state.calls, mentions: state.mentions, urgent: state.urgent });
    } catch (e) { toast(errText(e.code)); }
    render();
  };
  const toggleRow = (key, label, hint) => h('label', { class: 'focus-row' },
    h('span', null, h('b', null, label), hint ? h('small', { class: 'muted' }, hint) : null),
    h('input', { type: 'checkbox', checked: state[key], onchange: (e) => { state[key] = e.target.checked; commit(); } }));

  const startFor = (minutes) => {
    state.on = true;
    if (minutes === 0) state.until = 0;
    else if (minutes === 'morning') { const d = new Date(); d.setDate(d.getDate() + (d.getHours() >= 8 ? 1 : 0)); d.setHours(8, 0, 0, 0); state.until = d.getTime(); } else state.until = Date.now() + minutes * 60_000;
    commit();
  };

  // people that can break through: everybody the user has a one-to-one chat with
  const people = [...S.chats.values()].filter((c) => c.type === 'direct' && c.peer && !c.saved && !c.peer.is_bot && !c.secret).map((c) => c.peer)
    .sort((a, b) => a.name.localeCompare(b.name));

  function render() {
    const active = focusActive({ ...state, allow: [...state.allow] });
    const manual = state.on && (state.until === 0 || state.until > Date.now());
    clear(body).append(
      h('div', { class: `focus-hero${active ? ' on' : ''}` },
        h('div', { class: 'focus-moon' }, '\u{1F319}'),
        h('b', null, active ? t('focus.active') : t('focus.inactive')),
        h('small', { class: 'muted' }, t('focus.explain'))),
      manual
        ? h('button', { class: 'btn secondary', type: 'button', onclick: () => { state.on = false; state.until = 0; commit(); } }, t('focus.turn_off'))
        : h('div', { class: 'focus-start' },
          h('b', null, t('focus.turn_on_for')),
          h('div', { class: 'task-quick' },
            h('button', { class: 'chip', type: 'button', onclick: () => startFor(60) }, t('focus.h1')),
            h('button', { class: 'chip', type: 'button', onclick: () => startFor(120) }, t('focus.h2')),
            h('button', { class: 'chip', type: 'button', onclick: () => startFor(240) }, t('focus.h4')),
            h('button', { class: 'chip', type: 'button', onclick: () => startFor('morning') }, t('focus.till_morning')),
            h('button', { class: 'chip', type: 'button', onclick: () => startFor(0) }, t('focus.manual')))),
      h('div', { class: 'focus-block' },
        h('label', { class: 'focus-row' },
          h('span', null, h('b', null, t('focus.schedule')), h('small', { class: 'muted' }, t('focus.schedule_hint'))),
          h('input', { type: 'checkbox', checked: !!state.sched, onchange: (e) => { state.sched = e.target.checked ? { from: '22:00', to: '08:00', days: [0, 1, 2, 3, 4, 5, 6] } : null; commit(); } })),
        state.sched ? h('div', { class: 'focus-sched' },
          h('div', { class: 'focus-times' },
            h('label', null, t('focus.from'), h('input', { class: 'input', type: 'time', value: state.sched.from, onchange: (e) => { if (e.target.value) { state.sched.from = e.target.value; commit(); } } })),
            h('label', null, t('focus.to'), h('input', { class: 'input', type: 'time', value: state.sched.to, onchange: (e) => { if (e.target.value) { state.sched.to = e.target.value; commit(); } } }))),
          h('div', { class: 'focus-days' }, [1, 2, 3, 4, 5, 6, 0].map((d) => h('button', {
            class: 'chip', type: 'button', 'aria-pressed': String(state.sched.days.includes(d)),
            onclick: () => {
              const s = new Set(state.sched.days);
              if (s.has(d)) s.delete(d); else s.add(d);
              if (!s.size) { toast(t('focus.need_day')); return; }
              state.sched.days = [...s];
              commit();
            },
          }, dayNames[d])))) : null),
      h('h3', null, t('focus.breaks_through')),
      toggleRow('calls', t('focus.calls'), t('focus.calls_hint')),
      toggleRow('mentions', t('focus.mentions'), t('focus.mentions_hint')),
      toggleRow('urgent', t('focus.urgent'), t('focus.urgent_hint')),
      h('h3', null, t('focus.people')),
      people.length ? h('div', { class: 'focus-people' }, people.map((u) => h('label', { class: 'focus-person' },
        h('input', { type: 'checkbox', checked: state.allow.has(u.id), onchange: (e) => { if (e.target.checked) state.allow.add(u.id); else state.allow.delete(u.id); commit(); } }),
        h('span', { class: 'ellipsis' }, u.name)))) : h('p', { class: 'muted' }, t('focus.no_people')));
  }
  render();
  win = modal({ title: t('focus.title'), body: [body] });
  return win;
}
