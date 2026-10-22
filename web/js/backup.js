// Backup and transfer. A backup is one .zip with your chats in the same layout that Telegram uses (result.json + files/),
// so it can be restored into this or another Suhbat-dosh account with "Import" (and read by anything that reads such exports).
// It is built here in the browser from what the server shows you: nothing is stored anywhere but the file you save.
import { h, clear, formatBytes } from './dom.js';
import { t, errText } from './i18n.js';
import { S } from './state.js';
import { api } from './net.js';
import { chatTitle } from './state.js';
import { modal, toast } from './ui.js';
import { ZipWriter, blobSink, MAX_ZIP } from './zip.js';
import { openImport } from './import.js';

const safe = (s) => String(s || 'file').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 80);
const TYPE = { direct: 'personal_chat', group: 'private_group', channel: 'public_channel' };

function exportMessage(m, name, ctx) {
  const base = {
    id: m.id, type: 'message', date_unixtime: String(Math.floor(m.created_at / 1000)), from: m.sender_id === S.me.id ? S.me.name : name(m.sender_id),
    text: m.kind === 'sticker' ? '' : m.text || '', ...(m.reply_to ? { reply_to_message_id: m.reply_to.id } : {}), ...(m.forward_from ? { forwarded_from: m.forward_from } : {}),
  };
  if (m.file) {
    const path = `files/${m.id}_${safe(m.file.name)}`;
    ctx.files.push({ path, url: m.file.url, size: m.file.size });
    if (m.kind === 'image') return { ...base, photo: path };
    if (m.kind === 'voice') return { ...base, file: path, media_type: 'voice_message', duration_seconds: m.duration || 0 };
    if (m.kind === 'audio') return { ...base, file: path, media_type: 'audio_file', duration_seconds: m.duration || 0 };
    if (m.kind === 'video') return { ...base, file: path, media_type: 'video_file', duration_seconds: m.duration || 0 };
    return { ...base, file: path };
  }
  return base;
}

async function pages(chatId, ctl, onCount) {
  const all = [];
  let before = '';
  for (;;) {
    if (ctl.stop) return all;
    const r = await api('GET', `/api/chats/${chatId}/messages?limit=100${before}`);
    if (!r.messages.length) break;
    all.unshift(...r.messages);
    onCount(all.length);
    if (!r.has_more) break;
    before = `&before=${r.messages[0].id}`;
  }
  return all;
}

export function openBackup() {
  const body = h('div', { class: 'backup' });
  const win = modal({ title: t('bk.title'), body: [body] });
  const eligible = [...S.chats.values()].filter((c) => !c.secret && !c.imported).sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
  const picked = new Set(eligible.map((c) => c.id));
  const media = h('input', { type: 'checkbox', checked: true, id: 'bk-media' });

  function home() {
    clear(body).append(...[
      h('p', null, t('bk.intro')),
      h('h3', null, t('bk.create')),
      h('div', { class: 'imp-list' }, eligible.map((c) => h('label', { class: 'imp-chat-head' },
        h('input', { type: 'checkbox', checked: picked.has(c.id), onchange: (e) => { if (e.target.checked) picked.add(c.id); else picked.delete(c.id); } }),
        h('span', null, h('b', { class: 'ellipsis' }, chatTitle(c)))))),
      h('label', { class: 'focus-row' }, h('span', null, h('b', null, t('bk.with_media')), h('small', { class: 'muted' }, t('bk.with_media_hint'))), media),
      h('p', { class: 'muted' }, t('bk.skipped_secret')),
      h('button', { class: 'btn', type: 'button', onclick: () => run() }, t('bk.make')),
      h('h3', null, t('bk.restore')),
      h('p', { class: 'muted' }, t('bk.restore_hint')),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => { win.close(); openImport(); } }, t('bk.restore_btn')),
    ].filter(Boolean));
  }

  async function run() {
    if (!picked.size) { toast(t('imp.none_chosen')); return; }
    const ctl = { stop: false };
    const bar = h('i');
    const status = h('p', { class: 'muted' });
    clear(body).append(h('b', null, t('bk.working')), h('div', { class: 'mini-bar imp-bar' }, bar), status, h('small', { class: 'muted' }, t('imp.keep_open')),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => { ctl.stop = true; } }, t('common.cancel')));
    const withMedia = media.checked;
    const sink = blobSink();
    let stream = null;
    let writable = sink;
    const stamp = new Date().toISOString().slice(0, 10);
    // where the browser allows it the archive is written straight to a file chosen now, so a big one never sits in memory
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: `suhbat-backup-${stamp}.zip`, types: [{ description: 'ZIP', accept: { 'application/zip': ['.zip'] } }] });
        stream = await handle.createWritable();
        writable = stream;
      } catch (e) { if (e.name === 'AbortError') { home(); return; } }
    }
    const zip = new ZipWriter(writable);
    const chats = [];
    let done = 0;
    let bytes = 0;
    try {
      const chosen = eligible.filter((c) => picked.has(c.id));
      for (const [i, c] of chosen.entries()) {
        if (ctl.stop) break;
        const members = S.members.get(c.id) || [];
        const name = (id) => S.users.get(id)?.name || members.find((x) => x.user.id === id)?.user.name || c.peer?.name || '';
        status.textContent = `${chatTitle(c)} (${i + 1}/${chosen.length})`;
        const list = await pages(c.id, ctl, (n) => { status.textContent = `${chatTitle(c)} (${i + 1}/${chosen.length}): ${n}`; });
        const ctx = { files: [] };
        const messages = list.filter((m) => !['call', 'secret', 'sticker'].includes(m.kind) && (m.text || m.file)).map((m) => exportMessage(m, name, ctx));
        chats.push({ name: c.type === 'direct' ? (c.peer?.name || chatTitle(c)) : c.title, type: TYPE[c.type] || 'private_group', id: c.id, messages });
        if (withMedia) {
          for (const f of ctx.files) {
            if (ctl.stop) break;
            if (f.size > 300 * 1024 * 1024 || bytes + f.size > MAX_ZIP) continue;
            try {
              const r = await fetch(f.url, { credentials: 'same-origin' });
              if (!r.ok) continue;
              await zip.add(f.path, await r.blob());
              bytes += f.size;
            } catch (e) { if (e.code === 'zip_too_big') break; }
            status.textContent = `${chatTitle(c)}: ${formatBytes(bytes)}`;
          }
        }
        done += 1;
        bar.style.width = `${Math.round((done / chosen.length) * 100)}%`;
      }
      if (ctl.stop) { try { await stream?.abort(); } catch { /* ignore */ } home(); return; }
      await zip.add('result.json', JSON.stringify({ about: 'Suhbat-dosh backup', personal_information: { first_name: S.me.name, user_id: S.me.id }, chats: { about: 'Chats', list: chats } }));
      await zip.close();
      if (stream) await stream.close();
      else {
        const url = URL.createObjectURL(sink.blob());
        const a = h('a', { href: url, download: `suhbat-backup-${stamp}.zip` });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
      clear(body).append(h('b', null, t('bk.done')), h('p', null, t('bk.done_text', { chats: chats.length, size: formatBytes(bytes) })), h('button', { class: 'btn', type: 'button', onclick: () => win.close() }, t('common.close')));
    } catch (e) {
      try { await stream?.abort(); } catch { /* ignore */ }
      toast(errText(e.code));
      home();
    }
  }
  home();
}
