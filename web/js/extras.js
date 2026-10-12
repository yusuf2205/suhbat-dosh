// Extras: chat folders, search across all chats, scheduled messages / reminders, polls, sounds & quiet hours.
import { h, clear, debounce } from './dom.js';
import { t, errText } from './i18n.js';
import { S, chatTitle, fire, savePrefs } from './state.js';
import { api } from './net.js';
import { avatar, confirmDialog, fmtDay, fmtTime, modal, popMenu, previewText, toast } from './ui.js';
import { getLang } from './i18n.js';
import { icon } from './icons.js';

// ---------------------------------------------------------------- sounds + quiet hours
export const SOUNDS = ['default', 'chime', 'pop', 'bell', 'none'];
let ac;
const TONES = {
  default: [[880, 0, 0.25]],
  chime: [[1046, 0, 0.18], [1318, 0.16, 0.3]],
  pop: [[520, 0, 0.09], [780, 0.07, 0.12]],
  bell: [[1568, 0, 0.5], [2093, 0.02, 0.35]],
};

export function playSound(name = 'default') {
  if (name === 'none') return;
  try {
    ac ||= new (window.AudioContext || window.webkitAudioContext)();
    const seq = TONES[name] || TONES.default;
    for (const [freq, at, len] of seq) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      o.type = name === 'bell' ? 'triangle' : 'sine';
      o.frequency.value = freq;
      const t0 = ac.currentTime + at;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.16, t0 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + len);
      o.connect(g).connect(ac.destination);
      o.start(t0);
      o.stop(t0 + len + 0.02);
    }
  } catch { /* autoplay policy */ }
}

/** "Do not disturb" window from the settings (may wrap past midnight). */
export function isQuietNow(d = new Date()) {
  if (S.prefs.dndUntil && S.prefs.dndUntil > Date.now()) return true; // "do not disturb" for a set time
  const q = S.prefs.quiet;
  if (!q?.on) return false;
  const [fh, fm] = String(q.from || '23:00').split(':').map(Number);
  const [th, tm] = String(q.to || '07:00').split(':').map(Number);
  const cur = d.getHours() * 60 + d.getMinutes();
  const a = fh * 60 + fm;
  const b = th * 60 + tm;
  if (a === b) return false;
  return a < b ? cur >= a && cur < b : cur >= a || cur < b;
}

export function soundMenu(anchor, chat) {
  const cur = chat.sound || 'default';
  popMenu(anchor, SOUNDS.map((s) => ({
    label: `${cur === s ? '✓ ' : ''}${t(`sound.${s}`)}`,
    onClick: () => {
      playSound(s === 'default' ? 'default' : s);
      api('POST', `/api/chats/${chat.id}/sound`, { sound: s === 'default' ? null : s }).catch((e) => toast(errText(e.code)));
    },
  })));
}

// ---------------------------------------------------------------- folders
export async function loadFolders() {
  try { S.folders = (await api('GET', '/api/folders')).folders; } catch { S.folders ||= []; }
  fire('folders');
}

export function setFolders(list) {
  S.folders = list;
  if (S.filter.startsWith('f:') && !list.some((f) => `f:${f.id}` === S.filter)) S.filter = 'all';
  fire('folders');
}

export function folderPicker(anchor, chat) {
  const folders = S.folders || [];
  if (!folders.length) return openFolders();
  popMenu(anchor, [
    ...folders.map((f) => {
      const inside = f.chat_ids.includes(chat.id);
      return {
        label: `${inside ? '✓ ' : ''}${f.emoji ? `${f.emoji} ` : ''}${f.name}`,
        onClick: () => api('PATCH', `/api/folders/${f.id}`, { chat_ids: inside ? f.chat_ids.filter((x) => x !== chat.id) : [...f.chat_ids, chat.id] })
          .then((r) => setFolders(r.folders)).catch((e) => toast(errText(e.code))),
      };
    }),
    { label: `+ ${t('folders.new')}`, onClick: () => openFolders() },
  ]);
}

export function openFolders() {
  const box = h('div');
  const m = modal({ title: t('folders.title'), body: [box] });
  const draw = () => {
    clear(box);
    const list = S.folders || [];
    box.append(
      ...(list.length ? list.map((f) => h('div', { class: 'list-item' },
        h('span', { class: 'grow' }, h('b', null, `${f.emoji ? `${f.emoji} ` : ''}${f.name}`), h('span', { class: 'muted' }, ` · ${f.chat_ids.length}`)),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => edit(f) }, t('bots.edit')),
        h('button', { class: 'btn link', type: 'button', onclick: async () => {
          if (!(await confirmDialog(t('folders.delete_confirm'), { okLabel: t('common.delete'), danger: true }))) return;
          try { setFolders((await api('DELETE', `/api/folders/${f.id}`)).folders); draw(); } catch (e) { toast(errText(e.code)); }
        } }, t('common.delete'))))
        : [h('p', { class: 'muted' }, t('folders.none'))]),
      h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, `+ ${t('folders.new')}`));
  };
  const edit = (f) => {
    const name = h('input', { class: 'input', value: f?.name || '', maxLength: 24, placeholder: t('folders.name'), 'aria-label': t('folders.name') });
    const emoji = h('input', { class: 'input', value: f?.emoji || '', maxLength: 4, placeholder: '📁', 'aria-label': 'emoji' });
    const chosen = new Set(f?.chat_ids || []);
    const chats = [...S.chats.values()].filter((c) => !c.saved).sort((a, b) => chatTitle(a).localeCompare(chatTitle(b)));
    const boxes = chats.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(c.id), onchange: () => (cb.checked ? chosen.add(c.id) : chosen.delete(c.id)) });
      return h('label', { class: 'row folder-chat' }, cb, avatar(c.type === 'direct' ? c.peer : { id: c.id, name: c.title }, 'sm'), h('span', { class: 'ellipsis' }, chatTitle(c)));
    });
    const err = h('div', { class: 'err', role: 'alert' });
    clear(box).append(
      h('div', { class: 'row' }, emoji, name), h('div', { class: 'folder-chats' }, boxes), err,
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try {
            const body = { name: name.value.trim(), emoji: emoji.value.trim(), chat_ids: [...chosen] };
            const r = f ? await api('PATCH', `/api/folders/${f.id}`, body) : await api('POST', '/api/folders', body);
            setFolders(r.folders);
            draw();
          } catch (e) { err.textContent = errText(e.code); }
        } }, t('settings.save')),
        h('button', { class: 'btn secondary', type: 'button', onclick: draw }, t('chat.cancel'))));
  };
  draw();
  return m;
}

// ---------------------------------------------------------------- when? (schedule / reminder)
const pad = (n) => String(n).padStart(2, '0');
export function localInput(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Quick presets + a date/time picker. onPick(timestamp). */
export function pickTime(anchor, onPick) {
  const now = Date.now();
  const tomorrow9 = new Date();
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  popMenu(anchor, [
    { label: t('when.20m'), onClick: () => onPick(now + 20 * 60_000) },
    { label: t('when.1h'), onClick: () => onPick(now + 3600_000) },
    { label: t('when.3h'), onClick: () => onPick(now + 3 * 3600_000) },
    { label: t('when.tomorrow'), onClick: () => onPick(tomorrow9.getTime()) },
    { label: t('when.custom'), onClick: () => {
      const input = h('input', { class: 'input', type: 'datetime-local', value: localInput(now + 3600_000), min: localInput(now + 60_000), 'aria-label': t('when.custom') });
      const err = h('div', { class: 'err', role: 'alert' });
      const m = modal({ title: t('when.custom'), body: [input, err, h('button', { class: 'btn', type: 'button', onclick: () => {
        const ts = new Date(input.value).getTime();
        if (!Number.isFinite(ts) || ts < Date.now() + 5000) { err.textContent = t('when.past'); return; }
        m.close();
        onPick(ts);
      } }, t('common.ok'))] });
    } },
  ]);
}

export function whenLabel(ts) {
  const d = new Date(ts);
  return `${fmtDay(ts)}, ${fmtTime(ts)}${d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''}`;
}

export async function scheduleText(chatId, text, replyTo, ts) {
  await api('POST', `/api/chats/${chatId}/schedule`, { text, send_at: ts, ...(replyTo ? { reply_to: replyTo } : {}) });
  toast(`${t('when.scheduled')} ${whenLabel(ts)}`);
}

export async function remind(text, chatId, ts) {
  await api('POST', '/api/reminders', { text, send_at: ts, ...(chatId ? { chat_id: chatId } : {}) });
  toast(`${t('when.reminder_set')} ${whenLabel(ts)}`);
}

export async function openScheduled() {
  const box = h('div');
  const m = modal({ title: t('sched.title'), body: [box] });
  const draw = (list) => {
    clear(box).append(...(list.length ? list.map((s) => {
      const c = s.chat_id ? S.chats.get(s.chat_id) : null;
      return h('div', { class: 'list-item sched-item' },
        h('span', { class: 'grow' },
          h('b', { class: 'ellipsis', style: { display: 'block' } }, `${s.kind === 'reminder' ? '⏰ ' : ''}${s.text}`),
          h('span', { class: 'muted' }, `${whenLabel(s.send_at)}${c ? ` · ${chatTitle(c)}` : ''}`)),
        h('button', { class: 'btn link', type: 'button', onclick: async () => { draw((await api('DELETE', `/api/scheduled/${s.id}`)).scheduled); } }, t('chat.cancel')));
    }) : [h('p', { class: 'muted' }, t('sched.none'))]));
  };
  try { draw((await api('GET', '/api/scheduled')).scheduled); } catch (e) { toast(errText(e.code)); m.close(); }
}

// ---------------------------------------------------------------- polls
export function openPollCreate(chatId) {
  const q = h('input', { class: 'input', maxLength: 255, placeholder: t('poll.question'), 'aria-label': t('poll.question') });
  const opts = h('div', { class: 'poll-opts' });
  const multi = h('input', { type: 'checkbox', id: 'poll-multi' });
  const err = h('div', { class: 'err', role: 'alert' });
  const add = () => {
    if (opts.children.length >= 10) return;
    opts.append(h('input', { class: 'input', maxLength: 100, placeholder: `${t('poll.option')} ${opts.children.length + 1}`, 'aria-label': t('poll.option') }));
  };
  add(); add();
  const addBtn = h('button', { class: 'btn secondary', type: 'button', onclick: add }, `+ ${t('poll.add')}`);
  const m = modal({
    title: t('poll.new'),
    body: [q, opts, addBtn, h('label', { class: 'row', for: 'poll-multi' }, multi, t('poll.allow_multi')), err,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        const options = [...opts.querySelectorAll('input')].map((i) => i.value.trim()).filter(Boolean);
        if (!q.value.trim() || options.length < 2) { err.textContent = t('poll.need'); return; }
        try {
          await api('POST', `/api/chats/${chatId}/polls`, { question: q.value.trim(), options, multiple: multi.checked });
          m.close();
        } catch (e) { err.textContent = errText(e.code); }
      } }, t('chat.send'))],
  });
}

export function pollNode(m) {
  const p = m.poll;
  const mine = new Set();
  p.options.forEach((o, i) => { if (o.votes.includes(S.me.id)) mine.add(i); });
  const total = p.options.reduce((a, o) => a + o.votes.length, 0) || 0;
  const vote = async (i) => {
    const next = new Set(mine);
    if (p.multiple) { if (next.has(i)) next.delete(i); else next.add(i); } else if (next.has(i)) next.clear(); else { next.clear(); next.add(i); }
    try { await api('POST', `/api/polls/${p.id}/vote`, { options: [...next] }); } catch (e) { toast(errText(e.code)); }
  };
  const rows = p.options.map((o, i) => {
    const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
    const bar = h('i', { class: 'poll-bar' });
    bar.dataset.w = String(pct);
    queueMicrotask(() => { bar.style.width = `${pct}%`; });
    const names = o.votes.map((id) => S.users.get(id)?.name || (id === S.me.id ? S.me.name : '')).filter(Boolean).join(', ');
    return h('button', {
      class: `poll-opt${mine.has(i) ? ' mine' : ''}`, type: 'button', disabled: p.closed || m.pending, title: names, onclick: () => vote(i),
      'aria-pressed': String(mine.has(i)),
    }, h('span', { class: 'poll-mark' }, mine.has(i) ? icon('check', 14) : null), h('span', { class: 'poll-text' }, o.text),
    h('span', { class: 'poll-pct' }, `${pct}%`), bar);
  });
  const author = m.sender_id === S.me.id;
  return h('div', { class: 'poll' },
    h('div', { class: 'poll-q' }, p.question),
    h('div', { class: 'poll-sub' }, p.closed ? t('poll.closed') : p.multiple ? t('poll.multi') : t('poll.single')),
    rows,
    h('div', { class: 'poll-foot' }, `${p.total_voters} ${t('poll.voters')}`,
      author && !p.closed ? h('button', { class: 'btn link', type: 'button', onclick: () => api('POST', `/api/polls/${p.id}/close`).catch((e) => toast(errText(e.code))) }, t('poll.close')) : null));
}

// ---------------------------------------------------------------- search across all chats
export function openGlobalSearch() {
  const q = h('input', { class: 'input', type: 'search', placeholder: t('gsearch.placeholder'), 'aria-label': t('gsearch.placeholder') });
  const people = [...S.users.values()].filter((u) => u.id !== S.me.id).sort((a, b) => a.name.localeCompare(b.name));
  const from = h('select', { class: 'input', 'aria-label': t('gsearch.from') },
    h('option', { value: '' }, t('gsearch.anyone')), people.map((u) => h('option', { value: u.id }, u.name)));
  const type = h('select', { class: 'input', 'aria-label': t('gsearch.type') },
    ['', 'text', 'image', 'video', 'voice', 'file', 'link', 'poll'].map((v) => h('option', { value: v }, t(`gsearch.t_${v || 'any'}`))));
  const where = h('select', { class: 'input', 'aria-label': t('gsearch.where') },
    ['', 'direct', 'group', 'channel'].map((v) => h('option', { value: v }, t(`gsearch.w_${v || 'any'}`))));
  const since = h('input', { class: 'input', type: 'date', 'aria-label': t('gsearch.since') });
  const until = h('input', { class: 'input', type: 'date', 'aria-label': t('gsearch.until') });
  const out = h('div', { class: 'gs-results' });
  const m = modal({
    title: t('gsearch.title'), className: 'gsearch',
    body: [q, h('div', { class: 'gs-filters' },
      h('label', { class: 'field' }, h('span', null, t('gsearch.from')), from),
      h('label', { class: 'field' }, h('span', null, t('gsearch.type')), type),
      h('label', { class: 'field' }, h('span', null, t('gsearch.where')), where),
      h('label', { class: 'field' }, h('span', null, t('gsearch.since')), since),
      h('label', { class: 'field' }, h('span', null, t('gsearch.until')), until)), out],
  });
  const run = debounce(async () => {
    const term = q.value.trim();
    const params = new URLSearchParams();
    if (term) params.set('q', term);
    if (from.value) params.set('from_user', from.value);
    if (type.value) params.set('type', type.value);
    if (where.value) params.set('chat_type', where.value);
    if (since.value) params.set('since', String(new Date(`${since.value}T00:00:00`).getTime()));
    if (until.value) params.set('until', String(new Date(`${until.value}T23:59:59`).getTime()));
    if (term.length < 2 && ![from.value, type.value, since.value, until.value].some(Boolean)) { clear(out).append(h('p', { class: 'muted' }, t('gsearch.hint'))); return; }
    clear(out).append(h('p', { class: 'muted' }, t('list.loading')));
    try {
      const r = await api('GET', `/api/search/global?${params}`);
      clear(out).append(...(r.results.length ? r.results.map((x) => h('button', {
        class: 'ci', type: 'button',
        onclick: () => { m.close(); fire('open-chat', x.message.chat_id); setTimeout(() => fire('jump', { chatId: x.message.chat_id, msgId: x.message.id }), 80); },
      }, h('span', { class: 'ci-main' },
        h('span', { class: 'ci-top' }, h('span', { class: 'ci-title ellipsis' }, `${x.chat_title}${x.sender_name && x.chat_type !== 'direct' ? ` · ${x.sender_name}` : ''}`),
          h('span', { class: 'ci-time' }, `${fmtDay(x.message.created_at)} ${fmtTime(x.message.created_at)}`)),
        h('span', { class: 'ci-last ellipsis' }, previewText(x.message))))) : [h('p', { class: 'muted' }, t('list.nothing'))]));
    } catch (e) { clear(out).append(h('p', { class: 'err' }, errText(e.code))); }
  }, 350);
  for (const el of [q, from, type, where, since, until]) el.addEventListener(el === q ? 'input' : 'change', run);
  run();
  q.focus();
  return m;
}

// ---------------------------------------------------------------- quiet hours (settings fragment)
export function quietSettings() {
  const cfg = (S.prefs.quiet ||= { on: false, from: '23:00', to: '07:00' });
  const on = h('input', { type: 'checkbox', id: 's-quiet', checked: !!cfg.on, onchange: () => { cfg.on = on.checked; savePrefs(); } });
  const from = h('input', { class: 'input', type: 'time', value: cfg.from, 'aria-label': t('quiet.from'), onchange: () => { cfg.from = from.value || '23:00'; savePrefs(); } });
  const to = h('input', { class: 'input', type: 'time', value: cfg.to, 'aria-label': t('quiet.to'), onchange: () => { cfg.to = to.value || '07:00'; savePrefs(); } });
  return [
    h('label', { class: 'row', for: 's-quiet' }, on, t('quiet.title')),
    h('div', { class: 'row quiet-times' }, h('span', null, t('quiet.from')), from, h('span', null, t('quiet.to')), to),
    h('p', { class: 'muted' }, t('quiet.hint')),
  ];
}

// ---------------------------------------------------------------- report / auto-delete / translate
const TTLS = [0, 3600, 86400, 604800, 2592000];
export const ttlLabel = (s) => t(`ttl.${s || 0}`);

export function ttlMenu(anchor, chat) {
  popMenu(anchor, TTLS.map((s) => ({
    label: `${(chat.ttl || 0) === s ? '\u2713 ' : ''}${ttlLabel(s)}`,
    onClick: () => api('POST', `/api/chats/${chat.id}/ttl`, { seconds: s }).then(() => toast(s ? t('ttl.on', { v: ttlLabel(s) }) : t('ttl.off'))).catch((e) => toast(errText(e.code))),
  })));
}

export function reportMenu(anchor, m) {
  const send = (reason) => api('POST', `/api/messages/${m.id}/report`, { reason }).then(() => toast(t('report.sent'))).catch((e) => toast(errText(e.code)));
  popMenu(anchor, ['spam', 'scam', 'abuse', 'illegal', 'other'].map((k) => ({ label: t(`report.${k}`), onClick: () => send(t(`report.${k}`)) })));
}

/** Uses the browser's built-in translator when there is one; otherwise offers the web translator (asks first). */
export async function translateMessage(m) {
  const target = getLang() === 'uz' ? 'uz' : 'ru';
  try {
    if ('Translator' in self) {
      let source = 'en';
      if ('LanguageDetector' in self) {
        const det = await self.LanguageDetector.create();
        source = (await det.detect(m.text))[0]?.detectedLanguage || 'en';
      }
      if (source === target) { toast(t('tr.same')); return; }
      const tr = await self.Translator.create({ sourceLanguage: source, targetLanguage: target });
      const out = await tr.translate(m.text);
      modal({ title: t('msg.translate'), body: [h('p', { class: 'muted' }, m.text), h('p', { style: { fontSize: '1.05rem' } }, out)] });
      return;
    }
  } catch { /* fall back below */ }
  if (await confirmDialog(t('tr.external'), { okLabel: t('tr.open') })) {
    window.open(`https://translate.google.com/?sl=auto&tl=${target}&text=${encodeURIComponent(m.text)}&op=translate`, '_blank', 'noopener,noreferrer');
  }
}

export function dndRows(rowFn, redraw) {
  const until = S.prefs.dndUntil && S.prefs.dndUntil > Date.now() ? S.prefs.dndUntil : 0;
  const set = (ms) => { S.prefs.dndUntil = ms ? Date.now() + ms : 0; savePrefs(); redraw(); };
  const morning = new Date();
  morning.setHours(7, 0, 0, 0);
  if (morning.getTime() < Date.now() + 60_000) morning.setDate(morning.getDate() + 1);
  return [
    until ? rowFn('bell', `${t('dnd.until')} ${fmtTime(until)}`, { hint: t('dnd.hint'), value: t('st.on') }) : null,
    rowFn(null, t('dnd.1h'), { onclick: () => set(3600_000) }),
    rowFn(null, t('dnd.8h'), { onclick: () => set(8 * 3600_000) }),
    rowFn(null, t('dnd.morning'), { onclick: () => set(morning.getTime() - Date.now()) }),
    until ? rowFn(null, t('dnd.off'), { danger: true, onclick: () => set(0) }) : null,
  ].filter(Boolean);
}
