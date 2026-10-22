// Sharing of files kept in Saved messages (link, password, expiry, download limit, QR code), and "limit access" for a file you sent.
// There is no separate Drive screen: files live in Saved messages.
import { h, clear, formatBytes } from './dom.js';
import { t, errText, getLang } from './i18n.js';
import { api } from './net.js';
import { modal, popMenu, toast } from './ui.js';
import { showQr } from './qr.js';

const fmtDate = (ts) => new Date(ts).toLocaleDateString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { day: 'numeric', month: 'short', year: 'numeric' });
const fmtWhen = (ts) => new Date(ts).toLocaleString(getLang() === 'uz' ? 'uz-UZ' : 'ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Share the file of a message (a message in Saved): a link with an optional password, expiry and download limit, and its QR code. */
export async function shareMessageFile(m) {
  try {
    const r = await api('POST', '/api/drive', { file_id: m.file.id, folder: '' });
    shareDialog(r.item, () => {});
  } catch (e) { toast(errText(e.code)); }
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
