// Extras: chat folders, search across all chats, scheduled messages / reminders, polls, sounds & quiet hours.
import { h, clear, debounce } from './dom.js';
import { t, errText } from './i18n.js';
import { S, chatTitle, fire, savePrefs } from './state.js';
import { api } from './net.js';
import { avatar, confirmDialog, fmtDay, fmtTime, matchLine, modal, popMenu, previewText, toast } from './ui.js';
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
      ...(list.length ? list.map((f, i) => h('div', { class: 'list-item' },
        h('span', { class: 'folder-move' },
          h('button', { class: 'icon-btn sm', type: 'button', disabled: i === 0, 'aria-label': t('folders.up'), onclick: () => moveFolder(i, -1) }, '↑'),
          h('button', { class: 'icon-btn sm', type: 'button', disabled: i === list.length - 1, 'aria-label': t('folders.down'), onclick: () => moveFolder(i, 1) }, '↓')),
        h('span', { class: 'grow' }, h('b', null, `${f.emoji ? `${f.emoji} ` : ''}${f.name}`), h('span', { class: 'muted' }, ` · ${f.chat_ids.length}${f.rules?.include?.length ? ` + ${t('folders.auto')}` : ''}`)),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => edit(f) }, t('bots.edit')),
        h('button', { class: 'btn link', type: 'button', onclick: async () => {
          if (!(await confirmDialog(t('folders.delete_confirm'), { okLabel: t('common.delete'), danger: true }))) return;
          try { setFolders((await api('DELETE', `/api/folders/${f.id}`)).folders); draw(); } catch (e) { toast(errText(e.code)); }
        } }, t('common.delete'))))
        : [h('p', { class: 'muted' }, t('folders.none'))]),
      h('button', { class: 'btn', type: 'button', onclick: () => edit(null) }, `+ ${t('folders.new')}`));
  };
  const moveFolder = async (i, d) => {
    const ids = (S.folders || []).map((f) => f.id);
    [ids[i], ids[i + d]] = [ids[i + d], ids[i]];
    try { setFolders((await api('PUT', '/api/folders/order', { ids })).folders); draw(); } catch (e) { toast(errText(e.code)); }
  };
  const edit = (f) => {
    const name = h('input', { class: 'input', value: f?.name || '', maxLength: 24, placeholder: t('folders.name'), 'aria-label': t('folders.name') });
    const rules = { include: new Set(f?.rules?.include || []), exclude: new Set(f?.rules?.exclude || []) };
    const ruleBox = (side, key) => {
      const cb = h('input', { type: 'checkbox', checked: rules[side].has(key), onchange: () => (cb.checked ? rules[side].add(key) : rules[side].delete(key)) });
      return h('label', { class: 'row rule' }, cb, h('span', null, t(`folders.${side === 'include' ? 'in' : 'out'}.${key}`)));
    };
    const ruleBlock = h('div', { class: 'folder-rules' },
      h('p', { class: 'muted' }, t('folders.rules_hint')),
      h('b', null, t('folders.include')), ...['direct', 'groups', 'channels', 'bots', 'telegram'].map((k) => ruleBox('include', k)),
      h('b', null, t('folders.exclude')), ...['muted', 'read', 'archived'].map((k) => ruleBox('exclude', k)));
    const emoji = h('input', { class: 'input', value: f?.emoji || '', maxLength: 4, placeholder: '📁', 'aria-label': 'emoji' });
    const chosen = new Set(f?.chat_ids || []);
    const chats = [...S.chats.values()].filter((c) => !c.saved).sort((a, b) => chatTitle(a).localeCompare(chatTitle(b)));
    const boxes = chats.map((c) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(c.id), onchange: () => (cb.checked ? chosen.add(c.id) : chosen.delete(c.id)) });
      return h('label', { class: 'row folder-chat' }, cb, avatar(c.type === 'direct' ? c.peer : { id: c.id, name: c.title, avatar: c.avatar }, 'sm'), h('span', { class: 'ellipsis' }, chatTitle(c)));
    });
    const err = h('div', { class: 'err', role: 'alert' });
    clear(box).append(
      h('div', { class: 'row' }, emoji, name), ruleBlock, h('b', null, t('folders.pick')), h('div', { class: 'folder-chats' }, boxes), err,
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          try {
            const body = { name: name.value.trim(), emoji: emoji.value.trim(), chat_ids: [...chosen], rules: { include: [...rules.include], exclude: [...rules.exclude] } };
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
export function pickTime(anchor, onPick, { online = false } = {}) {
  const now = Date.now();
  const tomorrow9 = new Date();
  tomorrow9.setDate(tomorrow9.getDate() + 1);
  tomorrow9.setHours(9, 0, 0, 0);
  popMenu(anchor, [
    ...(online ? [{ label: t('when.online'), onClick: () => onPick(now + 5_000, { when_online: true }) }] : []),
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

export async function scheduleText(chatId, text, replyTo, ts, flags = {}) {
  await api('POST', `/api/chats/${chatId}/schedule`, { text, send_at: ts, ...(replyTo ? { reply_to: replyTo } : {}), ...(flags.silent ? { silent: true } : {}), ...(flags.when_online ? { when_online: true } : {}) });
  toast(flags.when_online ? t('when.scheduled_online') : `${t('when.scheduled')} ${whenLabel(ts)}${flags.silent ? ` \u00b7 ${t('sched.silent')}` : ''}`);
}

export async function remind(text, chatId, ts) {
  await api('POST', '/api/reminders', { text, send_at: ts, ...(chatId ? { chat_id: chatId } : {}) });
  toast(`${t('when.reminder_set')} ${whenLabel(ts)}`);
}

/** The list of messages and reminders waiting to be sent; `chatId` shows only one chat's. A row opens for editing. */
export async function openScheduled(chatId = null) {
  const box = h('div');
  const m = modal({ title: t('sched.title'), body: [box] });
  let only = chatId;
  const draw = (all) => {
    const list = only ? all.filter((s) => s.chat_id === only) : all;
    clear(box).append(...(list.length ? list.map((s) => {
      const c = s.chat_id ? S.chats.get(s.chat_id) : null;
      return h('div', { class: 'list-item sched-item' },
        h('button', { class: 'sched-main grow', type: 'button', onclick: () => edit(s, all) },
          h('b', { class: 'ellipsis', style: { display: 'block' } }, `${s.kind === 'reminder' ? '\u23f0 ' : ''}${s.text}`),
          h('span', { class: 'muted' }, `${s.when_online ? t('when.online') : whenLabel(s.send_at)}${c ? ` \u00b7 ${chatTitle(c)}` : ''}${s.silent ? ` \u00b7 \u{1f515} ${t('sched.silent')}` : ''}`)),
        h('button', { class: 'btn link', type: 'button', onclick: async () => { draw((await api('DELETE', `/api/scheduled/${s.id}`)).scheduled); } }, t('chat.cancel')));
    }) : [h('p', { class: 'muted' }, t('sched.none'))]), only && list.length < all.length ? h('button', { class: 'btn link', type: 'button', onclick: () => { only = null; draw(all); } }, t('sched.all', { n: all.length })) : null);
  };
  const edit = (s, all) => {
    const text = h('textarea', { class: 'input', rows: 4, maxLength: 4000, 'aria-label': t('sched.text') }, s.text);
    const when = h('input', { class: 'input', type: 'datetime-local', value: localInput(s.send_at), min: localInput(Date.now() + 60_000), 'aria-label': t('sched.time') });
    const silent = h('input', { type: 'checkbox', id: 'sc-silent', checked: !!s.silent });
    const online = h('input', { type: 'checkbox', id: 'sc-online', checked: !!s.when_online });
    const direct = s.kind === 'message' && S.chats.get(s.chat_id)?.type === 'direct';
    const err = h('div', { class: 'err', role: 'alert' });
    clear(box).append(text, when,
      s.kind === 'message' ? h('label', { class: 'row', for: 'sc-silent' }, silent, h('span', null, t('sched.silent'))) : null,
      direct ? h('label', { class: 'row', for: 'sc-online' }, online, h('span', null, t('when.online'))) : null, err,
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const ts = new Date(when.value).getTime();
          if (!Number.isFinite(ts) || ts < Date.now() + 5000) { err.textContent = t('when.past'); return; }
          try {
            const r = await api('PATCH', `/api/scheduled/${s.id}`, { text: text.value.trim(), send_at: ts, ...(s.kind === 'message' ? { silent: silent.checked, when_online: online.checked } : {}) });
            draw(r.scheduled);
          } catch (e) { err.textContent = errText(e.code); }
        } }, t('settings.save')),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => draw(all) }, t('chat.cancel'))));
  };
  try { draw((await api('GET', '/api/scheduled')).scheduled); } catch (e) { toast(errText(e.code)); m.close(); }
}

// ---------------------------------------------------------------- polls
export function openPollCreate(chatId) {
  let kind = 'poll';
  let correct = 0;
  const q = h('input', { class: 'input', maxLength: 255, 'aria-label': t('poll.question') });
  const opts = h('div', { class: 'poll-opts' });
  const multi = h('input', { type: 'checkbox', id: 'poll-multi' });
  const multiRow = h('label', { class: 'row', for: 'poll-multi' }, multi, t('poll.allow_multi'));
  const expl = h('input', { class: 'input', maxLength: 200, placeholder: t('poll.explanation'), 'aria-label': t('poll.explanation') });
  const err = h('div', { class: 'err', role: 'alert' });
  const tabs = h('div', { class: 'poll-tabs', role: 'tablist' });
  const addBtn = h('button', { class: 'btn secondary', type: 'button', onclick: () => addRow() }, `+ ${t('poll.add')}`);

  const addRow = () => {
    if (opts.children.length >= 10) return;
    const idx = opts.children.length;
    const input = kind === 'slots'
      ? h('input', { class: 'input', type: 'datetime-local', 'aria-label': t('poll.slot') })
      : h('input', { class: 'input', maxLength: 100, placeholder: `${t('poll.option')} ${idx + 1}`, 'aria-label': t('poll.option') });
    const kids = [];
    if (kind === 'quiz') {
      const r = h('input', { type: 'radio', name: 'poll-correct', 'aria-label': t('poll.right'), title: t('poll.right') });
      r.checked = idx === correct;
      r.addEventListener('change', () => { correct = idx; });
      kids.push(r);
    }
    kids.push(input);
    opts.append(h('div', { class: 'poll-row' }, ...kids));
  };
  const build = () => {
    clear(tabs).append(...['poll', 'quiz', 'slots'].map((k) => h('button', {
      class: 'chip', type: 'button', role: 'tab', 'aria-selected': String(kind === k), 'aria-pressed': String(kind === k),
      onclick: () => { kind = k; correct = 0; build(); },
    }, t(`poll.k_${k}`))));
    q.placeholder = kind === 'slots' ? t('poll.slots_q') : t('poll.question');
    clear(opts);
    addRow(); addRow();
    multiRow.hidden = kind !== 'poll';
    expl.hidden = kind !== 'quiz';
    err.textContent = '';
  };
  build();
  const slotLabel = (v) => new Date(v).toLocaleString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  const m = modal({
    title: t('poll.new'),
    body: [tabs, q, opts, addBtn, multiRow, expl, err,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        let options = [...opts.querySelectorAll('input:not([type=radio])')].map((i) => i.value.trim());
        if (kind === 'slots') options = options.filter(Boolean).map(slotLabel);
        // keep the right-answer index pointing at the same option after empty rows are dropped
        let right = correct;
        if (kind === 'quiz') {
          const kept = [];
          options.forEach((v, i) => { if (v) { if (i === correct) right = kept.length; kept.push(v); } });
          options = kept;
          if (!options[right] || opts.querySelectorAll('input:not([type=radio])')[correct]?.value.trim() === '') { err.textContent = t('poll.need_right'); return; }
        } else options = options.filter(Boolean);
        if (!q.value.trim() || options.length < 2) { err.textContent = t('poll.need'); return; }
        try {
          await api('POST', `/api/chats/${chatId}/polls`, {
            question: q.value.trim(), options, kind, multiple: kind === 'poll' && multi.checked,
            ...(kind === 'quiz' ? { correct: right, explanation: expl.value.trim() } : {}),
          });
          m.close();
        } catch (e) { err.textContent = errText(e.code); }
      } }, t('chat.send'))],
  });
}

const quizResults = new Map(); // poll id -> { correct, explanation }

export function pollNode(m) {
  const p = m.poll;
  const quiz = p.kind === 'quiz';
  const slots = p.kind === 'slots';
  const mine = new Set();
  p.options.forEach((o, i) => { if (o.votes.includes(S.me.id)) mine.add(i); });
  const total = p.options.reduce((a, o) => a + o.votes.length, 0) || 0;
  const best = slots ? Math.max(0, ...p.options.map((o) => o.votes.length)) : 0;
  const vote = async (i) => {
    const next = new Set(mine);
    if (p.multiple) { if (next.has(i)) next.delete(i); else next.add(i); } else if (next.has(i)) next.clear(); else { next.clear(); next.add(i); }
    try { await api('POST', `/api/polls/${p.id}/vote`, { options: [...next] }); } catch (e) { toast(errText(e.code)); }
  };
  const nameOf = (id) => S.users.get(id)?.name || (id === S.me.id ? S.me.name : '');
  const rows = p.options.map((o, i) => {
    const pct = total ? Math.round((o.votes.length / total) * 100) : 0;
    const bar = h('i', { class: 'poll-bar' });
    bar.dataset.w = String(pct);
    queueMicrotask(() => { bar.style.width = `${pct}%`; });
    const names = o.votes.map(nameOf).filter(Boolean).join(', ');
    const isBest = slots && best > 0 && o.votes.length === best;
    const lockedQuiz = quiz && (mine.size > 0 || p.closed);
    const btn = h('button', {
      class: `poll-opt${mine.has(i) ? ' mine' : ''}${isBest ? ' best' : ''}`, type: 'button', disabled: p.closed || m.pending || lockedQuiz, title: names, onclick: () => vote(i),
      'aria-pressed': String(mine.has(i)),
    }, h('span', { class: 'poll-mark' }, mine.has(i) ? icon('check', 14) : null), h('span', { class: 'poll-text' }, isBest ? `\u2605 ${o.text}` : o.text),
    h('span', { class: 'poll-pct' }, slots ? String(o.votes.length) : `${pct}%`), bar);
    // "when are you free": the names are always visible under the slot
    return slots && names ? h('div', { class: 'poll-slot' }, btn, h('small', { class: 'poll-who' }, names)) : btn;
  });
  const optButtons = () => rows.map((r) => (r.classList.contains('poll-opt') ? r : r.querySelector('.poll-opt')));
  const note = h('div', { class: 'poll-expl', hidden: true });
  const paintQuiz = (res) => {
    if (!res || res.correct == null) return;
    optButtons().forEach((b, i) => {
      b.classList.toggle('right', i === res.correct);
      b.classList.toggle('wrong', mine.has(i) && i !== res.correct);
    });
    if (res.explanation) { note.textContent = res.explanation; note.hidden = false; }
  };
  if (quiz) {
    const done = p.correct != null ? { correct: p.correct, explanation: p.explanation } : quizResults.get(p.id);
    if (done) queueMicrotask(() => paintQuiz(done));
    else if (mine.size || p.closed || m.sender_id === S.me.id) {
      api('GET', `/api/polls/${p.id}/result`).then((r) => { if (r.correct != null) { quizResults.set(p.id, r); paintQuiz(r); } }).catch(() => {});
    }
  }
  const author = m.sender_id === S.me.id;
  const sub = p.closed ? t('poll.closed') : quiz ? t('poll.quiz') : slots ? t('poll.slots_hint') : p.multiple ? t('poll.multi') : t('poll.single');
  return h('div', { class: `poll${quiz ? ' quiz' : ''}${slots ? ' slots' : ''}` },
    h('div', { class: 'poll-q' }, p.question),
    h('div', { class: 'poll-sub' }, sub),
    rows, note,
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
  const meaning = S.cfg?.semantic ? h('input', { type: 'checkbox', id: 'gs-meaning' }) : null;
  const m = modal({
    title: t('gsearch.title'), className: 'gsearch',
    body: [q, meaning ? h('label', { class: 'row', for: 'gs-meaning' }, meaning, h('span', null, `\u2728 ${t('sem.toggle')}`), h('small', { class: 'muted' }, ` ${t('sem.hint')}`)) : null, h('div', { class: 'gs-filters' },
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
    if (!meaning?.checked && term.length < 2 && ![from.value, type.value, since.value, until.value].some(Boolean)) { clear(out).append(h('p', { class: 'muted' }, t('gsearch.hint'))); return; }
    clear(out).append(h('p', { class: 'muted' }, t('list.loading')));
    try {
      if (meaning?.checked && term.length >= 3) {
        const sr = await api('GET', `/api/search/semantic?q=${encodeURIComponent(term)}`);
        const best = sr.results[0]?.score || 0;
        const keep = sr.results.filter((x) => x.score >= Math.max(0.8, best - 0.05));
        clear(out).append(...(keep.length ? keep.map((x) => h('button', {
          class: 'ci', type: 'button',
          onclick: () => { m.close(); fire('open-chat', x.message.chat_id); setTimeout(() => fire('jump', { chatId: x.message.chat_id, msgId: x.message.id }), 80); },
        }, h('span', { class: 'ci-main' },
          h('span', { class: 'ci-top' }, h('span', { class: 'ci-title ellipsis' }, S.chats.get(x.message.chat_id) ? chatTitle(S.chats.get(x.message.chat_id)) : ''), h('span', { class: 'ci-time' }, `${fmtDay(x.message.created_at)} ${fmtTime(x.message.created_at)}`)),
          h('span', { class: 'ci-last' }, previewText(x.message))))) : [h('p', { class: 'muted' }, t('list.nothing'))]));
        return;
      }
      const draw = (r, append) => {
        if (!append) clear(out);
        out.querySelector('.more')?.remove();
        if (!r.results.length && !append) { out.append(h('p', { class: 'muted' }, t('list.nothing'))); return; }
        out.append(...r.results.map((x) => h('button', {
          class: 'ci', type: 'button',
          onclick: () => { m.close(); fire('open-chat', x.message.chat_id); setTimeout(() => fire('jump', { chatId: x.message.chat_id, msgId: x.message.id }), 80); },
        }, h('span', { class: 'ci-main' },
          h('span', { class: 'ci-top' }, h('span', { class: 'ci-title ellipsis' }, `${x.chat_title}${x.sender_name && x.chat_type !== 'direct' ? ` \u00b7 ${x.sender_name}` : ''}`),
            h('span', { class: 'ci-time' }, `${fmtDay(x.message.created_at)} ${fmtTime(x.message.created_at)}`)),
          h('span', { class: 'ci-last ellipsis' }, matchLine(x.message, term))))));
        if (r.more) {
          const last = r.results.at(-1).message.id;
          out.append(h('button', { class: 'btn secondary more', type: 'button', onclick: async () => {
            try { draw(await api('GET', `/api/search/global?${params}&before=${last}`), true); } catch (e) { toast(errText(e.code)); }
          } }, t('search.more')));
        }
      };
      draw(await api('GET', `/api/search/global?${params}`), false);
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
