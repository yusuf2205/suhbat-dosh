// Built-in viewer for Word (.docx) and Excel (.xlsx) files. The libraries are loaded only when a document is opened.
import { h, formatBytes } from './dom.js';
import { t } from './i18n.js';
import { modal, toast } from './ui.js';
import { fileBlob, onDownload, requestFile } from './downloads.js';

const loaded = new Map();
function loadScript(src, global) {
  if (window[global]) return Promise.resolve(window[global]);
  if (loaded.has(src)) return loaded.get(src);
  const p = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => (window[global] ? resolve(window[global]) : reject(new Error('lib')));
    s.onerror = () => reject(new Error('lib'));
    document.head.appendChild(s);
  });
  loaded.set(src, p);
  return p;
}

export const isDocx = (f) => /\.docx$/i.test(f?.name || '') || /wordprocessingml/.test(f?.mime || '');
export const isXlsx = (f) => /\.xlsx$/i.test(f?.name || '') || /spreadsheetml/.test(f?.mime || '');
export const canViewInApp = (f) => isDocx(f) || isXlsx(f);

// ---- Word: convert to HTML, then rebuild the nodes from an allow-list (no scripts, no handlers, no remote content)
const ALLOWED = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'LI', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'STRONG', 'B', 'EM', 'I', 'U', 'BR', 'A', 'SUB', 'SUP', 'IMG', 'BLOCKQUOTE', 'S']);
function safeClone(node, doc) {
  if (node.nodeType === 3) return doc.createTextNode(node.nodeValue);
  if (node.nodeType !== 1 || !ALLOWED.has(node.tagName)) {
    const frag = doc.createDocumentFragment();
    node.childNodes?.forEach((c) => frag.appendChild(safeClone(c, doc)));
    return frag;
  }
  const el = doc.createElement(node.tagName.toLowerCase());
  if (node.tagName === 'A') {
    const href = node.getAttribute('href') || '';
    if (/^https?:|^mailto:/i.test(href)) { el.setAttribute('href', href); el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer nofollow'); }
  }
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') || '';
    if (/^data:image\/(png|jpe?g|gif|webp);base64,/i.test(src)) { el.setAttribute('src', src); el.setAttribute('alt', node.getAttribute('alt') || ''); }
    else return doc.createDocumentFragment();
  }
  if (node.tagName === 'TD' || node.tagName === 'TH') {
    for (const a of ['colspan', 'rowspan']) { const v = Number(node.getAttribute(a)); if (v > 1 && v < 100) el.setAttribute(a, String(v)); }
  }
  node.childNodes.forEach((c) => el.appendChild(safeClone(c, doc)));
  return el;
}

async function renderDocx(buf, box) {
  const mammoth = await loadScript('/js/vendor/mammoth.js', 'mammoth');
  const out = await mammoth.convertToHtml({ arrayBuffer: buf });
  const parsed = new DOMParser().parseFromString(`<body>${out.value}</body>`, 'text/html');
  const page = h('article', { class: 'doc-page' });
  parsed.body.childNodes.forEach((c) => page.appendChild(safeClone(c, document)));
  if (!page.childNodes.length) page.append(h('p', { class: 'muted' }, t('doc.empty')));
  box.replaceChildren(page);
}

// ---- Excel: sheets as tables (the first rows / columns; the file itself stays untouched)
const MAX_ROWS = 500;
const MAX_COLS = 40;
async function renderXlsx(buf, box) {
  const XLSX = await loadScript('/js/vendor/xlsx.js', 'XLSX');
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const tabs = h('div', { class: 'doc-tabs', role: 'tablist' });
  const body = h('div', { class: 'doc-sheet' });
  const show = (name) => {
    for (const b of tabs.children) b.setAttribute('aria-selected', String(b.dataset.name === name));
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: '' });
    const trimmed = rows.slice(0, MAX_ROWS);
    const width = Math.min(MAX_COLS, trimmed.reduce((m, r) => Math.max(m, r.length), 0));
    const table = h('table', { class: 'doc-table' },
      h('tbody', null, trimmed.map((r) => h('tr', null, Array.from({ length: width }, (_, i) => h('td', null, String(r[i] ?? ''))))))); 
    body.replaceChildren(table);
    if (rows.length > MAX_ROWS) body.append(h('p', { class: 'muted' }, t('doc.truncated', { n: MAX_ROWS })));
    if (!rows.length) body.append(h('p', { class: 'muted' }, t('doc.empty')));
  };
  for (const name of wb.SheetNames) {
    tabs.append(h('button', { class: 'doc-tab', type: 'button', role: 'tab', dataset: { name }, onclick: () => show(name) }, name));
  }
  box.replaceChildren(tabs, body);
  if (wb.SheetNames.length) show(wb.SheetNames[0]);
}

/** Opens the document in a window of its own; shows the download progress while the file is on its way. */
export function openDocument(file, { onSave } = {}) {
  const status = h('div', { class: 'doc-status muted' }, t('doc.loading'));
  const bar = h('span', { class: 'up-bar' });
  const track = h('span', { class: 'up-track' }, bar);
  const content = h('div', { class: 'doc-body' }, status, track);
  const save = h('button', { class: 'btn secondary', type: 'button', onclick: () => onSave?.(file) }, t('doc.save'));
  const m = modal({
    title: file.name,
    className: 'doc-modal',
    body: h('div', { class: 'doc-wrap' }, content, h('div', { class: 'row', style: { justifyContent: 'flex-end' } }, save)),
  });
  const off = onDownload((x) => {
    if (x.id !== file.id || x.state === 'done') return;
    const pct = x.total ? Math.round((x.loaded / x.total) * 100) : 0;
    bar.style.width = `${pct}%`;
    status.textContent = `${t('doc.loading')} ${formatBytes(x.loaded)} / ${formatBytes(x.total)}`;
  });
  (async () => {
    try {
      const blob = await fileBlob(file, 2);
      off();
      status.textContent = t('doc.rendering');
      const buf = await blob.arrayBuffer();
      if (isDocx(file)) await renderDocx(buf, content);
      else await renderXlsx(buf, content);
    } catch (e) {
      off();
      content.replaceChildren(h('p', { class: 'err' }, e.code === 'forbidden' ? t('err.forbidden') : t('doc.failed')),
        h('button', { class: 'btn', type: 'button', onclick: () => { m.close(); toast(t('doc.retrying')); openDocument(file, { onSave }); } }, t('up.retry')));
    }
  })();
  void requestFile;
  return m;
}
