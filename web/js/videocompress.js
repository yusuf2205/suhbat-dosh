// Shrink a long video before sending: it is played in the background and re-recorded at 720p / ~1.5 Mbit/s.
// This takes about as long as the video lasts, so it is offered only for big files and is optional.
// Any problem returns the original file.
const MIN_BYTES = 20 * 1048576;
const MAX_SECONDS = 5 * 60;
const MAX_SIDE = 1280;

export const canCompressVideo = (file) => /^video\//.test(file.type) && file.size >= MIN_BYTES && !!window.MediaRecorder;

function pickMime() {
  return ['video/mp4;codecs=avc1,mp4a.40.2', 'video/webm;codecs=vp8,opus', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m)) || '';
}

/** onProgress(0..1). Returns a File (smaller) or the original. Pass an AbortSignal to cancel. */
export async function compressVideo(file, onProgress, signal) {
  let url = '';
  let ac = null;
  try {
    const mime = pickMime();
    if (!mime) return file;
    url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.src = url;
    v.playsInline = true;
    v.preload = 'auto';
    await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('decode')); });
    if (v.duration === Infinity) { // webm written by a recorder has no length: seek to the end to learn it
      v.currentTime = 1e101;
      await new Promise((res) => { v.ontimeupdate = () => { v.ontimeupdate = null; res(); }; });
      v.currentTime = 0;
    }
    if (!Number.isFinite(v.duration) || v.duration > MAX_SECONDS || !v.videoWidth) return file;
    const k = Math.min(1, MAX_SIDE / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.max(2, Math.round((v.videoWidth * k) / 2) * 2);
    const hgt = Math.max(2, Math.round((v.videoHeight * k) / 2) * 2);
    if (k === 1 && file.size < 40 * 1048576) return file; // already small enough
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = hgt;
    const ctx = cv.getContext('2d');
    const out = cv.captureStream(30);
    ac = new (window.AudioContext || window.webkitAudioContext)();
    const dest = ac.createMediaStreamDestination();
    ac.createMediaElementSource(v).connect(dest); // not connected to the speakers: silent for the user
    dest.stream.getAudioTracks().forEach((tr) => out.addTrack(tr));
    const mr = new MediaRecorder(out, { mimeType: mime, videoBitsPerSecond: 1_500_000, audioBitsPerSecond: 96_000 });
    const chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const stopped = new Promise((res) => { mr.onstop = res; });
    let raf = 0;
    const draw = () => {
      ctx.drawImage(v, 0, 0, w, hgt);
      onProgress?.(Math.min(1, v.currentTime / v.duration));
      raf = v.requestVideoFrameCallback ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    };
    const abort = () => { try { v.pause(); if (mr.state !== 'inactive') mr.stop(); } catch { /* ignore */ } };
    signal?.addEventListener('abort', abort);
    v.onended = () => { if (mr.state !== 'inactive') mr.stop(); };
    mr.start(1000);
    await v.play();
    draw();
    await stopped;
    if (v.cancelVideoFrameCallback) v.cancelVideoFrameCallback(raf); else cancelAnimationFrame(raf);
    if (signal?.aborted) return file;
    const blob = new Blob(chunks, { type: mr.mimeType || mime });
    if (blob.size < 50_000 || blob.size >= file.size * 0.9) return file;
    const ext = /mp4/.test(blob.type) ? 'mp4' : 'webm';
    const base = file.name.replace(/\.[^.]+$/, '') || 'video';
    return new File([blob], `${base}.${ext}`, { type: blob.type, lastModified: Date.now() });
  } catch {
    return file;
  } finally {
    try { ac?.close(); } catch { /* ignore */ }
    if (url) URL.revokeObjectURL(url);
  }
}
