// Import of chat history from Telegram Desktop ("Export chat history" -> JSON). The export is read here in the browser
// and sent to the server in small pieces; photos and files are uploaded one by one when the folder is chosen.
import { h, clear } from './dom.js';
import { t, errText } from './i18n.js';
import { S, fire } from './state.js';
import { api } from './net.js';
import { modal, toast } from './ui.js';
import { parseExport } from './tgparse.js';
import { readZip } from './zip.js';

const MAX_JSON = 450 * 1024 * 1024;
const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase();

/** Folder pick gives paths like "ChatExport_2024/photos/a.jpg": index them without the top folder. */
function indexFiles(list) {
  const files = new Map();
  let json = null;
  for (const f of list) {
    const rel = f.webkitRelativePath ? f.webkitRelativePath.split('/').slice(1).join('/') : f.name;
    files.set(norm(rel), f);
    if (/(^|\/)result\.json$/i.test(rel) || (!json && /\.json$/i.test(f.name))) json = f;
  }
  return { files, json };
}

async function importChat(c, { meName, withMedia, files, maxBytes }, ui, ctl) {
  const start = await api('POST', '/api/import/telegram/start', { title: c.name, me_name: meName, key: c.key });
  const chatId = start.chat_id;
  const idOf = new Map();
  let batch = [];
  const flush = async () => {
    if (!batch.length) return;
    const r = await api('POST', `/api/import/telegram/${chatId}/batch`, { messages: batch.map((x) => x.payload) });
    r.ids.forEach((lid, i) => { if (lid) idOf.set(batch[i].tgId, lid); });
    ui.done += batch.length;
    batch = [];
    ui.tick();
  };
  for (const m of c.messages) {
    if (ctl.stop) break;
    const entry = withMedia && m.media ? files.get(norm(m.media.path)) : null; // a File, or a zip entry that is unpacked on demand
    const reply = m.reply ? idOf.get(m.reply) : undefined;
    if (entry && entry.size > 0 && entry.size <= maxBytes) {
      await flush();
      const file = entry.file ? await entry.file() : entry;
      const q = new URLSearchParams({ key: m.key, name: m.media.name, ts: String(m.ts), author: m.author, caption: m.text, ...(reply ? { reply_to: String(reply) } : {}), ...(m.media.kind === 'voice' ? { voice: '1' } : {}), ...(m.media.duration ? { duration: String(Math.round(m.media.duration)) } : {}) });
      try {
        const r = await api('POST', `/api/import/telegram/${chatId}/file?${q}`, undefined, { raw: file, headers: { 'content-type': 'application/octet-stream' } });
        if (r?.id) idOf.set(m.tgId, r.id);
        ui.files += 1;
      } catch (e) {
        if (e.code === 'quota_exceeded') throw e;
        ui.skipped += 1; // a blocked type or a damaged file: keep the text, go on
        batch.push({ tgId: m.tgId, payload: { key: m.key, ts: m.ts, author: m.author, text: `${m.text}\n[${m.media.name}]`.trim(), reply_to: reply, forwarded: m.forwarded } });
      }
      ui.done += 1;
      ui.tick();
      continue;
    }
    let text = m.text;
    if (m.media) { text = `${text}\n[${m.media.name}]`.trim(); ui.skipped += 1; }
    if (m.missing) text = `${text}\n[${t('imp.not_in_export')}]`.trim();
    if (!text && m.sticker) text = m.sticker;
    if (!text) { ui.done += 1; continue; }
    batch.push({ tgId: m.tgId, payload: { key: m.key, ts: m.ts, author: m.author, text, reply_to: reply, forwarded: m.forwarded } });
    if (batch.length >= 300) await flush();
  }
  await flush();
  if (ctl.stop) return null;
  const done = await api('POST', `/api/import/telegram/${chatId}/finish`);
  S.chats.set(done.chat.id, done.chat);
  fire('chats');
  return done.chat;
}

export function openImport() {
  const body = h('div', { class: 'imp' });
  const win = modal({ title: t('imp.title'), body: [body] });
  let parsed = null;
  let fileIndex = null;

  const pickInput = (opts) => h('input', { type: 'file', class: 'sr', tabIndex: -1, ...opts, onchange: (e) => onPicked([...e.target.files]) });
  const dirInput = pickInput({ webkitdirectory: true, multiple: true });
  const jsonInput = pickInput({ accept: '.json,.zip,application/json,application/zip' });

  function intro() {
    clear(body).append(
      h('p', null, t('imp.intro')),
      h('ol', { class: 'imp-steps' }, [1, 2, 3, 4].map((n) => h('li', null, t(`imp.step${n}`)))),
      h('p', { class: 'muted' }, t('imp.privacy')),
      h('div', { class: 'imp-pick' },
        h('button', { class: 'btn', type: 'button', onclick: () => dirInput.click() }, t('imp.pick_folder')),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => jsonInput.click() }, t('imp.pick_json'))),
      dirInput, jsonInput);
  }

  /** A .zip (a backup of ours, or a zipped export): the entries become the file index. */
  async function indexZip(zipFile) {
    const entries = await readZip(zipFile);
    let prefix = '';
    let json = null;
    for (const [name, e] of entries) if (/(^|\/)result\.json$/i.test(name)) { json = e; prefix = name.slice(0, name.length - 'result.json'.length); break; }
    const files = new Map();
    for (const [name, e] of entries) files.set(norm(prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name), e);
    return { files, json: json ? await json.file() : null };
  }

  async function onPicked(list) {
    if (!list.length) return;
    try { fileIndex = list.length === 1 && /\.zip$/i.test(list[0].name) ? await indexZip(list[0]) : indexFiles(list); } catch { toast(t('imp.bad_json')); return; }
    if (!fileIndex.json) { toast(t('imp.no_json')); return; }
    if (fileIndex.json.size > MAX_JSON) { toast(t('imp.too_big')); return; }
    clear(body).append(h('p', { class: 'muted' }, t('imp.reading')));
    try {
      parsed = parseExport(JSON.parse(await fileIndex.json.text()));
    } catch { toast(t('imp.bad_json')); intro(); return; }
    if (!parsed.chats.length) { toast(t('imp.empty')); intro(); return; }
    choose();
  }

  function choose() {
    const hasFiles = fileIndex.files.size > 1;
    const picks = parsed.chats.map((c, i) => ({
      c, on: parsed.chats.length === 1 || i < 1,
      me: c.authors.find((a) => a.name === parsed.me)?.name || c.authors[0]?.name || '',
    }));
    const media = h('input', { type: 'checkbox', checked: hasFiles, disabled: !hasFiles, id: 'imp-media' });
    const rows = picks.map((p) => {
      const meSel = h('select', { class: 'input', 'aria-label': t('imp.who_am_i'), onchange: (e) => { p.me = e.target.value; } },
        p.c.authors.slice(0, 12).map((a) => h('option', { value: a.name, selected: a.name === p.me }, `${a.name} (${a.n})`)));
      return h('div', { class: 'imp-chat' },
        h('label', { class: 'imp-chat-head' },
          h('input', { type: 'checkbox', checked: p.on, onchange: (e) => { p.on = e.target.checked; } }),
          h('span', null, h('b', { class: 'ellipsis' }, p.c.name), h('small', { class: 'muted' }, `${p.c.messages.length} ${t('imp.messages')}${p.c.media ? ` · ${p.c.media} ${t('imp.media')}` : ''}`))),
        h('label', { class: 'imp-me' }, h('small', { class: 'muted' }, t('imp.who_am_i')), meSel));
    });
    clear(body).append(
      h('p', null, t('imp.found', { n: parsed.chats.length })),
      h('div', { class: 'imp-list' }, rows),
      hasFiles ? h('label', { class: 'focus-row' }, h('span', null, h('b', null, t('imp.with_media')), h('small', { class: 'muted' }, t('imp.with_media_hint'))), media)
        : h('p', { class: 'muted' }, t('imp.no_media_folder')),
      h('button', { class: 'btn', type: 'button', onclick: () => run(picks.filter((p) => p.on), media.checked && hasFiles) }, t('imp.start')));
  }

  async function run(picks, withMedia) {
    if (!picks.length) { toast(t('imp.none_chosen')); return; }
    const ctl = { stop: false };
    const total = picks.reduce((a, p) => a + p.c.messages.length, 0);
    const bar = h('i');
    const status = h('p', { class: 'muted' });
    const ui = { done: 0, files: 0, skipped: 0, tick() { bar.style.width = `${Math.min(100, Math.round((ui.done / total) * 100))}%`; status.textContent = t('imp.progress', { done: ui.done, total, files: ui.files }); } };
    clear(body).append(
      h('b', null, t('imp.working')), h('div', { class: 'mini-bar imp-bar' }, bar), status,
      h('small', { class: 'muted' }, t('imp.keep_open')),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => { ctl.stop = true; } }, t('common.cancel')));
    ui.tick();
    let last = null;
    try {
      for (const p of picks) {
        if (ctl.stop) break;
        last = await importChat(p.c, { meName: p.me, withMedia, files: fileIndex.files, maxBytes: S.cfg?.max_upload_bytes || 50 * 1024 * 1024 }, ui, ctl) || last;
      }
    } catch (e) {
      toast(errText(e.code));
      clear(body).append(h('p', { class: 'err' }, errText(e.code)), h('p', { class: 'muted' }, t('imp.can_resume')), h('button', { class: 'btn', type: 'button', onclick: choose }, t('imp.again')));
      return;
    }
    clear(body).append(...[
      h('b', null, ctl.stop ? t('imp.stopped') : t('imp.done')),
      h('p', null, t('imp.summary', { done: ui.done, files: ui.files, skipped: ui.skipped })),
      last ? h('button', { class: 'btn', type: 'button', onclick: () => { win.close(); fire('open-chat', last.id); } }, t('imp.open')) : null,
    ].filter(Boolean));
  }

  intro();
}
