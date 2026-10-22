// Personal cloud drive: files kept from chats, folders, share links (password / expiry / download limit),
// and "limit access" for a file you sent.
import { h, clear, formatBytes } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { icon } from './icons.js';
import { confirmDialog, modal, popMenu, toast } from './ui.js';
import { fileIcon } from './fileicons.js';
import { showQr } from './qr.js';

const fmtDate = (ts) => new Date(ts).toLocaleDateString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtWhen = (ts) => new Date(ts).toLocaleString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** "Save to Drive" from a message. */
export async function saveToDrive(fileId, folder = '') {
  try {
    await api('POST', '/api/drive', { file_id: fileId, folder });
    toast(t('drive.saved'));
  } catch (e) { toast(errText(e.code)); }
}

export async function openDrive() {
  const state = { items: [], folders: [], folder: null, q: '', used: 0, loading: true };
  const list = h('div', { class: 'drive-list', role: 'list' });
  const chips = h('div', { class: 'drive-chips' });
  const info = h('div', { class: 'drive-info muted' });
  const search = h('input', { class: 'input', type: 'search', placeholder: t('drive.search'), 'aria-label': t('drive.search') });
  let m = null;

  const load = async () => {
    try {
      const r = await api('GET', '/api/drive');
      Object.assign(state, r, { loading: false });
    } catch (e) { state.loading = false; toast(errText(e.code)); }
    draw();
  };

  const draw = () => {
    clear(chips).append(
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.folder === null), onclick: () => { state.folder = null; draw(); } }, t('drive.all')),
      ...state.folders.map((f) => h('button', { class: 'chip', type: 'button', 'aria-pressed': String(state.folder === f), onclick: () => { state.folder = f; draw(); } }, `\u{1F4C1} ${f}`)));
    const term = state.q.trim().toLowerCase();
    const rows = state.items.filter((i) => (state.folder === null || i.folder === state.folder) && (!term || i.name.toLowerCase().includes(term)));
    clear(info).append(`${t('drive.files')}: ${rows.length} · ${formatBytes(state.used)}`);
    clear(list);
    if (state.loading) { list.append(h('p', { class: 'muted' }, t('net.connecting'))); return; }
    if (!rows.length) { list.append(h('p', { class: 'muted drive-empty' }, state.items.length ? t('drive.nothing') : t('drive.empty'))); return; }
    for (const it of rows) {
      const f = it.file;
      list.append(h('div', { class: 'drive-row', role: 'listitem' },
        h('a', { class: 'drive-main', href: `${f.url}?dl=1`, download: it.name, title: t('drive.download') },
          h('span', { class: 'ficon' }, fileIcon(it.name, f.mime, 36)),
          h('span', { class: 'drive-text' },
            h('b', { class: 'ellipsis' }, it.name),
            h('small', { class: 'muted' }, [formatBytes(f.size), fmtDate(it.created_at), it.folder ? `\u{1F4C1} ${it.folder}` : ''].filter(Boolean).join(' · '),
              it.shares ? h('span', { class: 'drive-linked' }, ` · \u{1F517} ${it.shares}`) : null))),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('drive.share'), title: t('drive.share'), onclick: () => shareDialog(it, load) }, icon('qr', 20)),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': t('msg.more'), onclick: (e) => rowMenu(e.currentTarget, it) }, icon('more', 20))));
    }
  };

  const rowMenu = (anchor, it) => popMenu(anchor, [
    { label: t('drive.download'), onClick: () => { const a = h('a', { href: `${it.file.url}?dl=1`, download: it.name }); document.body.append(a); a.click(); a.remove(); } },
    { label: t('drive.share'), onClick: () => shareDialog(it, load) },
    { label: t('drive.rename'), onClick: () => promptText(t('drive.rename'), it.name, async (v) => { await api('PATCH', `/api/drive/${it.id}`, { name: v }); load(); }) },
    { label: t('drive.move'), onClick: () => promptText(t('drive.folder_name'), it.folder, async (v) => { await api('PATCH', `/api/drive/${it.id}`, { folder: v }); load(); }, t('drive.folder_hint')) },
    { label: t('drive.remove'), danger: true, onClick: async () => {
      if (!(await confirmDialog(t('drive.remove_confirm'), { okLabel: t('drive.remove'), danger: true }))) return;
      try { await api('DELETE', `/api/drive/${it.id}`); load(); } catch (e) { toast(errText(e.code)); }
    } },
  ]);

  const upload = h('button', { class: 'btn', type: 'button', onclick: () => picker.click() }, `+ ${t('drive.upload')}`);
  const picker = h('input', { type: 'file', multiple: true, hidden: true });
  picker.addEventListener('change', async () => {
    const files = [...picker.files];
    picker.value = '';
    if (!files.length) return;
    try {
      const saved = (await api('POST', '/api/chats/saved')).chat;
      S.chats.set(saved.id, saved);
      fire('chats');
      const { attachFiles } = await import('./chat.js');
      m?.close();
      await attachFiles(saved.id, files); // goes through the usual resumable upload; it lands in the drive by itself
      toast(t('drive.uploading'));
    } catch (e) { toast(errText(e.code)); }
  });
  search.addEventListener('input', () => { state.q = search.value; draw(); });

  m = modal({
    title: t('drive.title'), className: 'drive',
    body: [h('div', { class: 'drive-bar' }, search, upload), picker, chips, info, list, h('p', { class: 'muted drive-note' }, t('drive.note'))],
  });
  draw();
  load();
}

function promptText(title, value, onOk, hint = '') {
  const input = h('input', { class: 'input', value: value || '', maxLength: 120, 'aria-label': title });
  let m = null;
  const go = async () => { try { await onOk(input.value.trim()); m.close(); } catch (e) { toast(errText(e.code)); } };
  m = modal({ title, body: [input, hint ? h('p', { class: 'muted' }, hint) : null, h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } }, h('button', { class: 'btn', type: 'button', onclick: go }, t('settings.save')))] });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  setTimeout(() => { input.focus(); input.select(); }, 50);
}

// ---------------------------------------------------------------- share links
function shareDialog(it, refresh) {
  const origin = location.origin;
  const body = h('div', { class: 'share-box' });
  let m = null;
  const draw = async () => {
    let shares = [];
    try { shares = (await api('GET', `/api/drive/${it.id}/shares`)).shares; } catch { /* offline */ }
    const pw = h('input', { class: 'input', type: 'text', maxLength: 64, placeholder: t('share.password_ph'), autocomplete: 'off', 'aria-label': t('share.password') });
    const ttl = h('select', { class: 'input', 'aria-label': t('share.expires') },
      [['1', 'share.t1h'], ['24', 'share.t1d'], ['168', 'share.t7d'], ['720', 'share.t30d'], ['', 'share.never']].map(([v, k]) => h('option', { value: v, selected: v === '168' }, t(k))));
    const lim = h('select', { class: 'input', 'aria-label': t('share.limit') },
      [['', 'share.unlimited'], ['1', 'share.once'], ['5', 'share.five'], ['20', 'share.twenty']].map(([v, k]) => h('option', { value: v }, t(k))));
    const create = h('button', { class: 'btn', type: 'button', onclick: async () => {
      create.disabled = true;
      try {
        const r = await api('POST', `/api/drive/${it.id}/share`, {
          password: pw.value || undefined, ttl_hours: ttl.value ? Number(ttl.value) : null, max_downloads: lim.value ? Number(lim.value) : null,
        });
        const link = origin + new URL(r.share.url, origin).pathname;
        try { await navigator.clipboard.writeText(link); toast(t('info.copied')); } catch { /* shown below anyway */ }
        refresh();
        draw();
      } catch (e) { toast(errText(e.code)); create.disabled = false; }
    } }, t('share.create'));
    clear(body).append(
      h('p', { class: 'muted' }, `${it.name} · ${formatBytes(it.file.size)}`),
      h('label', { class: 'field' }, h('span', null, t('share.password')), pw),
      h('div', { class: 'row' }, h('label', { class: 'field grow' }, h('span', null, t('share.expires')), ttl), h('label', { class: 'field grow' }, h('span', null, t('share.limit')), lim)),
      create,
      h('h3', null, t('share.links')),
      ...(shares.length ? shares.map((s) => {
        const link = origin + new URL(s.url, origin).pathname;
        return h('div', { class: `share-row${s.active ? '' : ' dead'}` },
          h('div', { class: 'share-meta' }, h('div', { class: 'invite' }, link),
            h('small', { class: 'muted' }, [s.has_password ? `\u{1F512} ${t('share.password')}` : t('share.open'),
              s.expires_at ? `${t('share.until')} ${fmtWhen(s.expires_at)}` : t('share.no_expiry'),
              `${t('share.downloads')}: ${s.downloads}${s.max_downloads ? `/${s.max_downloads}` : ''}`, s.active ? '' : t('share.inactive')].filter(Boolean).join(' · '))),
          h('div', { class: 'row' },
            s.active ? h('button', { class: 'btn secondary small', type: 'button', onclick: async () => { try { await navigator.clipboard.writeText(link); toast(t('info.copied')); } catch { /* ignore */ } } }, t('info.copy')) : null,
            s.active ? h('button', { class: 'btn secondary small', type: 'button', onclick: () => showQr(it.name, link) }, t('qr.show')) : null,
            s.active ? h('button', { class: 'btn link', type: 'button', onclick: async () => { await api('DELETE', `/api/drive/shares/${s.token}`).catch(() => {}); refresh(); draw(); } }, t('share.revoke')) : null));
      }) : [h('p', { class: 'muted' }, t('share.none'))]));
  };
  m = modal({ title: t('drive.share'), body: [body] });
  draw();
}

// ---------------------------------------------------------------- limited access to a sent file
export function accessMenu(anchor, m, onDone) {
  const set = async (seconds) => {
    try {
      await api('PATCH', `/api/messages/${m.id}/access`, seconds === null ? {} : { seconds });
      toast(seconds === 0 ? t('access.closed') : seconds === null ? t('access.cleared') : t('access.set'));
      onDone?.();
    } catch (e) { toast(errText(e.code)); }
  };
  popMenu(anchor, [
    { label: t('access.h1'), onClick: () => set(3600) },
    { label: t('access.d1'), onClick: () => set(86400) },
    { label: t('access.d7'), onClick: () => set(7 * 86400) },
    { label: t('access.now'), danger: true, onClick: () => set(0) },
    ...(m.access_until ? [{ label: t('access.clear'), onClick: () => set(null) }] : []),
  ]);
}

/** A badge under the file of a message: "access until ..." for the sender, nothing for others until it ends. */
export function accessBadge(m, mine) {
  if (!m.access_until) return null;
  const left = m.access_until - Date.now();
  if (left <= 0) return h('div', { class: 'access-badge dead' }, mine ? t('access.ended_mine') : t('access.ended'));
  if (!mine) return h('div', { class: 'access-badge' }, `${t('access.until')} ${fmtWhen(m.access_until)}`);
  return h('div', { class: 'access-badge' }, `${t('access.until')} ${fmtWhen(m.access_until)}`);
}
