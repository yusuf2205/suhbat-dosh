// Native "open this file": the Android app / desktop app download it and hand it to the right program (Word, Excel, PDF ...).
/** Word / Excel / PowerPoint and similar: opened by the programs installed on the device. */
export const isOffice = (f) => /\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf|csv)$/i.test(f?.name || '');
export const canOpenNative = () => !!(window.SuhbatNative?.openFile || window.suhbatShell?.openFile);

import { autoAllowed } from './downloads.js';
const warmed = new Set();
/** Android: fetch a received document in the background, so tapping it opens at once. */
export function prefetchNative(file) {
  try {
    if (!window.SuhbatNative?.prefetchFile || !file?.url || file.local || warmed.has(file.id)) return;
    if (!autoAllowed('file', file.size) || warmed.size >= 40) return; // the Wi-Fi / mobile / roaming policy decides
    warmed.add(file.id);
    window.SuhbatNative.prefetchFile(`${new URL(file.url, location.origin).href}?dl=1`, file.name);
  } catch { /* optional */ }
}

/** Returns true when a native shell took over; false means: use the normal web viewer / download. */
export async function openNative(file) {
  const abs = `${new URL(file.url, location.origin).href}?dl=1`;
  try {
    if (window.SuhbatNative?.openFile) { window.SuhbatNative.openFile(abs, file.name, file.mime || ''); return true; }
    if (window.suhbatShell?.openFile) { await window.suhbatShell.openFile(abs, file.name); return true; }
  } catch { /* fall back to the viewer */ }
  return false;
}

const OFFICE_MIME = {
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet', odp: 'application/vnd.oasis.opendocument.presentation', rtf: 'application/rtf', csv: 'text/csv',
};
const mimeOf = (name, mime) => (mime && mime !== 'application/octet-stream' ? mime : OFFICE_MIME[String(name || '').split('.').pop().toLowerCase()] || 'application/octet-stream');
const prepared = new Map();   // documents already fetched for the share sheet (a second tap shares at once: iOS wants the sheet to open inside the tap)
const touchDevice = () => !!window.matchMedia?.('(pointer: coarse)').matches;

/**
 * A document (Word, Excel ...) is opened by the device, not saved. The app hands it over; on a phone the share sheet of the system offers the programs that
 * open it (and Quick Look on an iPhone); where that is not possible the browser opens it as a document. `url` is the address of the file itself.
 */
export async function openDocument({ url, name, mime }, { toast } = {}) {
  if (canOpenNative() && (await openNative({ url, name, mime }))) return true;
  const plain = () => { window.open(`${url}${url.includes('?') ? '&' : '?'}inline=1`, '_blank', 'noopener'); return true; };
  if (!touchDevice() || !navigator.canShare || !navigator.share) return plain();
  let file = prepared.get(url);
  if (!file) {
    toast?.('Открываю…');
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) return plain();
      file = new File([await r.blob()], name || 'document', { type: mimeOf(name, mime) });
      if (prepared.size >= 4) prepared.delete(prepared.keys().next().value);
      prepared.set(url, file);
    } catch { return plain(); }
  }
  if (!navigator.canShare({ files: [file] })) return plain();
  try { await navigator.share({ files: [file] }); return true; } catch (e) {
    if (e?.name === 'AbortError') return true;            // the person closed the sheet
    if (e?.name === 'NotAllowedError') { toast?.('Файл готов: нажмите ещё раз'); return true; }   // the tap was used up while the file came; it is ready now
    return plain();
  }
}
/** Kept for the messenger: the same, with the app's own toast. */
export const openInSystem = (file, opts) => openDocument(file, opts);
