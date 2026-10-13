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
