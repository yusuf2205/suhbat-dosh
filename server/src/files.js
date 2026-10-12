import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { HttpError } from './util.js';

// Block file types that can execute or run script when opened. This is defence in depth only:
// every non-media file is served as an opaque attachment anyway.
const BLOCKED_EXT = new Set([
  'exe', 'dll', 'bat', 'cmd', 'com', 'scr', 'msi', 'msp', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1',
  'psm1', 'sh', 'bash', 'jar', 'hta', 'cpl', 'lnk', 'reg', 'html', 'htm', 'xhtml', 'svg', 'xml',
]);

export const filePath = (id) => path.join(config.filesDir, id);

/** Detect a media type from magic bytes. Returns { mime, kind } or null for "unknown/generic". */
export function sniff(buf, voiceHint = false) {
  const b = buf;
  const ascii = (s, o = 0) => b.length >= o + s.length && b.toString('latin1', o, o + s.length) === s;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', kind: 'image' };
  if (b[0] === 0x89 && ascii('PNG', 1)) return { mime: 'image/png', kind: 'image' };
  if (ascii('GIF87a') || ascii('GIF89a')) return { mime: 'image/gif', kind: 'image' };
  if (ascii('RIFF') && ascii('WEBP', 8)) return { mime: 'image/webp', kind: 'image' };
  if (ascii('RIFF') && ascii('WAVE', 8)) return { mime: 'audio/wav', kind: voiceHint ? 'voice' : 'audio' };
  if (ascii('OggS')) return { mime: 'audio/ogg', kind: voiceHint ? 'voice' : 'audio' };
  if (ascii('ID3') || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return { mime: 'audio/mpeg', kind: voiceHint ? 'voice' : 'audio' };
  if (ascii('fLaC')) return { mime: 'audio/flac', kind: voiceHint ? 'voice' : 'audio' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // EBML (webm/mkv): audio-only voice notes vs. video is decided by the hint.
    return voiceHint ? { mime: 'audio/webm', kind: 'voice' } : { mime: 'video/webm', kind: 'video' };
  }
  if (ascii('ftyp', 4)) {
    const brand = b.toString('latin1', 8, 12);
    if (/^(M4A |M4B )/.test(brand)) return { mime: 'audio/mp4', kind: voiceHint ? 'voice' : 'audio' };
    return voiceHint ? { mime: 'audio/mp4', kind: 'voice' } : { mime: 'video/mp4', kind: 'video' };
  }
  if (ascii('%PDF')) return { mime: 'application/pdf', kind: 'file' };
  return null;
}

export function checkName(name) {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 120) || 'file';
  const ext = clean.includes('.') ? clean.split('.').pop().toLowerCase() : '';
  if (BLOCKED_EXT.has(ext)) throw new HttpError(415, 'file_type_blocked');
  return clean;
}

/** Stream a request body to disk with a hard size cap. Returns the number of bytes written. */
export function receive(req, dest, maxBytes) {
  const declared = Number(req.headers['content-length'] || 0);
  if (declared > maxBytes) return Promise.reject(new HttpError(413, 'file_too_large'));
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest, { flags: 'wx', mode: 0o640 });
    let size = 0;
    let over = false;
    req.on('data', (chunk) => {
      if (over) return;
      size += chunk.length;
      if (size > maxBytes) {
        over = true;
        out.destroy();
        return;
      }
      if (!out.write(chunk)) {
        req.pause();
        out.once('drain', () => req.resume());
      }
    });
    req.on('end', () => {
      if (over) return fs.unlink(dest, () => reject(new HttpError(413, 'file_too_large')));
      out.end(() => resolve(size));
    });
    req.on('error', (e) => {
      out.destroy();
      fs.unlink(dest, () => reject(e));
    });
    out.on('error', (e) => {
      if (over) return;
      fs.unlink(dest, () => reject(e));
    });
  });
}

export function readHead(file, n = 32) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    const read = fs.readSync(fd, buf, 0, n, 0);
    return buf.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

export const thumbPath = (id) => `${filePath(id)}.thumb`;

export function removeFile(id) {
  fs.unlink(filePath(id), () => {});
  fs.unlink(thumbPath(id), () => {});
}
