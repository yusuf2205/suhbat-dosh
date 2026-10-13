// Native "open this file": the Android app / desktop app download it and hand it to the right program (Word, Excel, PDF ...).
export const canOpenNative = () => !!(window.SuhbatNative?.openFile || window.suhbatShell?.openFile);

const warmed = new Set();
/** Android: fetch a received document in the background, so tapping it opens at once. */
export function prefetchNative(file) {
  try {
    if (!window.SuhbatNative?.prefetchFile || !file?.url || file.local || warmed.has(file.id)) return;
    if (file.size > 25 * 1048576 || warmed.size >= 40) return;
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
