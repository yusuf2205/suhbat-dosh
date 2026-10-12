// Thumbnails / video posters are produced on the sender's device and uploaded next to the file.
const MAX = 360;

function toBlob(canvas) {
  return new Promise((res) => canvas.toBlob((b) => res(b), 'image/jpeg', 0.72));
}

function draw(source, w, h) {
  const k = Math.min(1, MAX / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * k));
  const ch = Math.max(1, Math.round(h * k));
  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  canvas.getContext('2d').drawImage(source, 0, 0, cw, ch);
  return canvas;
}

/** Returns { blob, w, h } where w/h are the ORIGINAL dimensions, or null when not possible. */
export async function makeThumb(file) {
  try {
    if (/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) {
      const bmp = await createImageBitmap(file);
      const blob = await toBlob(draw(bmp, bmp.width, bmp.height));
      const out = { blob, w: bmp.width, h: bmp.height };
      bmp.close?.();
      return blob ? out : null;
    }
    if (/^video\//.test(file.type)) {
      const url = URL.createObjectURL(file);
      try {
        const v = document.createElement('video');
        v.muted = true;
        v.preload = 'auto';
        v.playsInline = true;
        v.src = url;
        await new Promise((res, rej) => {
          v.onloadeddata = res;
          v.onerror = () => rej(new Error('video'));
          setTimeout(() => rej(new Error('timeout')), 8000);
        });
        v.currentTime = Math.min(1, (v.duration || 2) / 10);
        await new Promise((res) => { v.onseeked = res; setTimeout(res, 1500); });
        if (!v.videoWidth) return null;
        const blob = await toBlob(draw(v, v.videoWidth, v.videoHeight));
        return blob ? { blob, w: v.videoWidth, h: v.videoHeight } : null;
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  } catch { /* unsupported format (e.g. HEIC): the file is still sent, just without a preview */ }
  return null;
}
