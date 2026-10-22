// Stories: 24-hour photo / text posts for your contacts; the author keeps an archive.
import { closeLayer, openLayer } from './backnav.js';
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { avatar, confirmDialog, fmtDay, fmtTime, modal, toast } from './ui.js';
import { icon } from './icons.js';

const COLORS = ['#fbc700', '#2563eb', '#16a34a', '#db2777', '#7c3aed', '#ea580c', '#0f172a'];
let feed = [];
let barEl = null;
let loadedAt = 0;

export async function refreshStories() {
  try {
    feed = (await api('GET', '/api/stories')).feed;
    loadedAt = Date.now();
  } catch { /* offline */ }
  paint();
}

function paint() {
  if (!barEl) return;
  // nothing to show: the strip takes no room at all (stories are added from Settings)
  barEl.hidden = !feed.some((f) => f.stories.length);
  if (barEl.hidden) return;
  const me = feed.find((f) => f.user.id === S.me?.id);
  const others = feed.filter((f) => f.user.id !== S.me?.id);
  const items = [];
  items.push(h('button', {
    class: `story-item${me?.stories.length ? ' mine has' : ' mine'}`, type: 'button',
    'aria-label': t('story.mine'), onclick: () => (me?.stories.length ? openViewer([me], 0) : compose()),
  }, h('span', { class: 'story-ring' }, avatar({ ...S.me, online: false })),
  h('span', { class: 'story-add', onclick: (e) => { e.stopPropagation(); compose(); } }, icon('plus', 14)),
  h('span', { class: 'story-name' }, t('story.mine'))));
  others.forEach((f) => {
    items.push(h('button', { class: `story-item${f.all_seen ? ' seen' : ''}`, type: 'button', onclick: () => openViewer(others, others.indexOf(f)) },
      h('span', { class: 'story-ring' }, avatar({ ...f.user, online: false })),
      h('span', { class: 'story-name' }, f.user.name)));
  });
  clear(barEl).append(...items);
}

/** The strip above the chat list. */
export function storiesBar() {
  barEl = h('div', { class: 'stories-bar', role: 'list', 'aria-label': t('story.title') });
  paint();
  refreshStories();
  setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - loadedAt > 45_000) refreshStories(); }, 30_000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshStories(); });
  return barEl;
}

// ---------------------------------------------------------------- viewer
function openViewer(groups, startGroup, { archive = false } = {}) {
  let gi = startGroup;
  let si = 0;
  let timer = null;
  const root = document.getElementById('modal-root');
  const bars = h('div', { class: 'sv-bars' });
  const head = h('div', { class: 'sv-head' });
  const stage = h('div', { class: 'sv-stage' });
  const foot = h('div', { class: 'sv-foot' });
  const el = h('div', { class: 'story-viewer', role: 'dialog', 'aria-modal': 'true' }, bars, head, stage, foot,
    h('button', { class: 'sv-nav prev', type: 'button', 'aria-label': t('viewer.prev'), onclick: () => step(-1) }),
    h('button', { class: 'sv-nav next', type: 'button', 'aria-label': t('viewer.next'), onclick: () => step(1) }));
  const layer = openLayer(() => close());
  function close() { clearTimeout(timer); closeLayer(layer); el.remove(); document.removeEventListener('keydown', onKey); refreshStories(); }
  const onKey = (e) => { if (e.key === 'Escape') close(); else if (e.key === 'ArrowRight') step(1); else if (e.key === 'ArrowLeft') step(-1); };
  document.addEventListener('keydown', onKey);

  function step(d) {
    si += d;
    const g = groups[gi];
    if (si >= g.stories.length) { gi += 1; si = 0; }
    if (si < 0) { gi -= 1; si = gi >= 0 ? Math.max(0, groups[gi].stories.length - 1) : 0; }
    if (gi < 0) gi = 0;
    if (gi >= groups.length) { close(); return; }
    show();
  }

  function show() {
    clearTimeout(timer);
    const g = groups[gi];
    const s = g.stories[si];
    if (!s) { close(); return; }
    const own = g.user.id === S.me.id;
    clear(bars).append(...g.stories.map((x, i) => h('span', { class: `sv-bar${i < si ? ' done' : ''}${i === si ? ' now' : ''}` }, h('i'))));
    clear(head).append(avatar({ ...g.user, online: false }, 'sm'),
      h('span', { class: 'grow' }, h('b', null, own ? t('story.mine') : g.user.name), h('small', null, `${fmtDay(s.created_at)} ${fmtTime(s.created_at)}`)),
      own ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.delete'), onclick: async () => {
        clearTimeout(timer);
        if (!(await confirmDialog(t('story.delete_confirm'), { okLabel: t('common.delete'), danger: true }))) { show(); return; }
        try { await api('DELETE', `/api/stories/${s.id}`); g.stories.splice(si, 1); if (!g.stories.length) groups.splice(gi, 1); if (si >= (groups[gi]?.stories.length || 0)) { gi = Math.min(gi, groups.length - 1); si = 0; } show(); } catch (e) { toast(errText(e.code)); show(); }
      } }, icon('trash', 20)) : null,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), onclick: close }, icon('close', 22)));
    clear(stage);
    if (s.media) stage.append(h('img', { src: s.media, alt: '' }));
    if (s.text) stage.append(h('div', { class: `sv-text${s.media ? ' cap' : ''}` }, s.text));
    if (!s.media) stage.style.background = s.bg || '#fbc700';
    else stage.style.background = '#000';
    clear(foot);
    if (own && typeof s.views === 'number') {
      foot.append(h('button', { class: 'sv-views', type: 'button', onclick: () => { clearTimeout(timer); viewers(s).then(show); } }, `\u{1F441} ${s.views}`));
    }
    if (!own && !archive) api('POST', `/api/stories/${s.id}/view`).then(() => { s.seen = true; }).catch(() => {});
    el.querySelector('.sv-bar.now i')?.getBoundingClientRect(); // restart the CSS animation
    timer = setTimeout(() => step(1), 5500);
  }

  root.append(el);
  show();
}

function viewers(s) {
  return new Promise((resolve) => {
    const box = h('div', null, h('p', { class: 'muted' }, t('list.loading')));
    const m = modal({ title: t('story.viewers'), body: [box], onClose: resolve });
    api('GET', `/api/stories/${s.id}/viewers`).then((r) => {
      clear(box).append(...(r.viewers.length ? r.viewers.map((v) => h('div', { class: 'list-item' }, avatar(v.user, 'sm'),
        h('span', { class: 'grow' }, v.user.name), h('span', { class: 'muted' }, fmtTime(v.at)))) : [h('p', { class: 'muted' }, t('story.no_views'))]));
    }).catch((e) => { toast(errText(e.code)); m.close(); });
  });
}

// ---------------------------------------------------------------- compose
export function compose() {
  let color = COLORS[0];
  const text = h('textarea', { class: 'input story-text', rows: 4, maxLength: 280, placeholder: t('story.text_ph'), 'aria-label': t('story.text_ph') });
  const swatches = h('div', { class: 'story-colors' }, COLORS.map((c) => {
    const b = h('button', { class: `story-color${c === color ? ' on' : ''}`, type: 'button', 'aria-label': c, onclick: () => {
      color = c;
      swatches.querySelectorAll('.story-color').forEach((x) => x.classList.toggle('on', x === b));
      text.style.background = c;
      text.style.color = c === '#fbc700' ? '#2b2b2e' : '#fff';
    } });
    b.style.background = c;
    return b;
  }));
  text.style.background = color;
  text.style.color = '#2b2b2e';
  const cap = h('input', { class: 'input', maxLength: 280, placeholder: t('story.caption_ph'), 'aria-label': t('story.caption_ph') });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', class: 'sr', tabIndex: -1 });
  const err = h('div', { class: 'err', role: 'alert' });
  const aud = S.cfg?.stories_audience ? audiencePicker() : null; // switched off by the administrator until this is released
  const m = modal({
    title: t('story.new'),
    body: [
      h('div', { class: 'row' },
        h('button', { class: 'btn', type: 'button', onclick: () => file.click() }, `${t('story.photo')}…`)),
      cap, file,
      h('h3', null, t('story.text_title')), text, swatches, aud?.node, err,
      h('button', { class: 'btn', type: 'button', onclick: async () => {
        err.textContent = '';
        try {
          if (file.files[0]) {
            await api('POST', `/api/stories?caption=${encodeURIComponent(cap.value.trim())}${aud?.ids().length ? `&audience=${aud.ids().join(',')}` : ''}`, undefined, { raw: file.files[0], headers: { 'content-type': 'application/octet-stream' } });
          } else if (text.value.trim()) {
            await api('POST', '/api/stories', { text: text.value.trim(), bg: color, ...(aud?.ids().length ? { audience: aud.ids() } : {}) });
          } else { err.textContent = t('story.empty'); return; }
          m.close();
          toast(t('story.posted'));
          refreshStories();
        } catch (e) { err.textContent = errText(e.code); }
      } }, t('story.publish')),
    ],
  });
}

/** "Who sees it": every contact, or only the people ticked here (with saved lists such as "Close friends"). */
function audiencePicker() {
  const people = [...S.chats.values()].filter((c) => c.type === 'direct' && c.peer && !c.saved && !c.peer.is_bot).map((c) => c.peer);
  const picked = new Set();
  let only = false;
  const box = h('div', { class: 'aud-box', hidden: true });
  const lists = h('div', { class: 'aud-lists' });
  const rows = people.map((p) => {
    const cb = h('input', { type: 'checkbox' });
    cb.addEventListener('change', () => { if (cb.checked) picked.add(p.id); else picked.delete(p.id); });
    return { cb, p, el: h('label', { class: 'aud-row' }, cb, avatar(p, 'sm'), h('span', null, p.name)) };
  });
  const loadLists = async () => {
    try {
      const r = await api('GET', '/api/stories/lists');
      clear(lists).append(...r.lists.map((l) => h('button', { class: 'chip', type: 'button', onclick: () => { for (const x of rows) { x.cb.checked = l.members.includes(x.p.id); if (x.cb.checked) picked.add(x.p.id); else picked.delete(x.p.id); } } }, l.name)),
        h('button', { class: 'chip', type: 'button', onclick: async () => {
          const name = window.prompt(t('aud.list_name'));
          if (!name || !picked.size) return;
          try { await api('POST', '/api/stories/lists', { name, members: [...picked] }); loadLists(); } catch (e) { toast(errText(e.code)); }
        } }, `+ ${t('aud.save_list')}`));
    } catch { /* lists are optional */ }
  };
  const mode = h('select', { class: 'input', 'aria-label': t('aud.who') }, h('option', { value: 'all' }, t('aud.all')), h('option', { value: 'some' }, t('aud.some')));
  mode.addEventListener('change', () => { only = mode.value === 'some'; box.hidden = !only; if (only) loadLists(); });
  box.append(lists, ...rows.map((r) => r.el));
  return { node: h('div', { class: 'aud' }, h('h3', null, t('aud.who')), mode, box), ids: () => (only ? [...picked] : []) };
}

// ---------------------------------------------------------------- archive (settings)
export async function openStoryArchive() {
  const box = h('div', { class: 'photo-grid' });
  const m = modal({ title: t('story.archive'), body: [box] });
  try {
    const r = await api('GET', '/api/stories/archive');
    if (!r.stories.length) { clear(box).append(h('p', { class: 'muted' }, t('story.archive_empty'))); box.classList.remove('photo-grid'); return; }
    clear(box).append(...r.stories.map((s) => h('button', { class: 'photo-tile story-tile', type: 'button', onclick: () => {
      m.close();
      openViewer([{ user: S.me, stories: [s], all_seen: true }], 0, { archive: true });
    } }, s.media ? h('img', { src: s.media, alt: '', loading: 'lazy' }) : h('span', { class: 'story-tile-text' }, s.text.slice(0, 40)),
    h('small', { class: 'story-tile-date' }, fmtDay(s.created_at)))));
  } catch (e) { toast(errText(e.code)); m.close(); }
}
