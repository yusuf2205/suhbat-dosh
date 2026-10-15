// Shrink a photo before sending: long side <= 1920 px, JPEG 82 %. Falls back to the original on any problem.
const MAX_SIDE = 1920;

export const canCompress = (file) => /^image\/(jpe?g|png|webp)$/.test(file.type) && file.size > 250 * 1024;

export async function compressImage(file) {
  try {
    const bmp = await createImageBitmap(file);
    const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * k));
    const hgt = Math.max(1, Math.round(bmp.height * k));
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = hgt;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#fff'; // PNG transparency becomes white in JPEG
    ctx.fillRect(0, 0, w, hgt);
    ctx.drawImage(bmp, 0, 0, w, hgt);
    bmp.close?.();
    const blob = await new Promise((res) => cv.toBlob(res, 'image/jpeg', 0.82));
    if (!blob || blob.size >= file.size * 0.95) return file;
    const base = file.name.replace(/\.[^.]+$/, '') || 'photo';
    return new File([blob], `${base}.jpg`, { type: 'image/jpeg', lastModified: Date.now() });
  } catch { return file; }
}
