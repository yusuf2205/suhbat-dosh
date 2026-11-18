// Old files that an iPhone cannot play as they are: the voice messages that came from Telegram (Ogg/Opus) and the videos whose index
// ("moov") is at the end of the file (a phone then waits for the whole file, or the player never starts). For such a request from an
// Apple browser a playable copy is made once (the sound as AAC in an .m4a, the video moved into a "fast start" order without
// re-encoding) and kept next to the files; every other browser gets the original, and a download is always the original.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './util.js';
import { filePath } from './files.js';

const DIR = path.join(config.dataDir, 'playable');
const MAX_PARALLEL = 2;
const TIMEOUT_MS = 5 * 60_000;
const FAIL_PAUSE_MS = 10 * 60_000;
const CAP_BYTES = Number(process.env.PLAYABLE_CAP_GB || 20) * 1024 ** 3;   // the copies are only a cache: the oldest are removed when they grow past this
let sinceCheck = 0;

/** Keeps the folder of copies under its limit: the least recently made go first (they are made again when asked for). */
function prune() {
  try {
    const list = fs.readdirSync(DIR).filter((n) => !n.includes('.tmp.')).map((n) => { const st = fs.statSync(path.join(DIR, n)); return { n, size: st.size, at: st.mtimeMs }; });
    let total = list.reduce((a, x) => a + x.size, 0);
    if (total <= CAP_BYTES) return;
    for (const x of list.sort((p, q) => p.at - q.at)) {
      if (total <= CAP_BYTES * 0.8) break;
      try { fs.unlinkSync(path.join(DIR, x.n)); total -= x.size; } catch { /* gone */ }
    }
  } catch { /* nothing to prune */ }
}

let ffmpegOk = null;
const haveFfmpeg = () => {
  if (ffmpegOk === null) ffmpegOk = !spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).error;
  return ffmpegOk;
};

/** Safari on a Mac, and every browser on an iPhone or iPad (they all use the engine of Safari). */
export const isAppleWebkit = (ua) => /iPhone|iPad|iPod/.test(ua || '') || (/Safari\//.test(ua || '') && !/Chrome|Chromium|CriOS|Android|Edg|OPR/.test(ua || ''));

/** Is the index of an MP4 file near its start (the video can play while it arrives)? */
export function moovAtStart(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const head = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 64 && pos + 8 <= size; i += 1) {
      fs.readSync(fd, head, 0, 16, pos);
      let len = head.readUInt32BE(0);
      const type = head.toString('latin1', 4, 8);
      if (type === 'moov') return pos < 256 * 1024;
      if (type === 'mdat' && pos > 256 * 1024) return false;
      if (len === 1) len = Number(head.readBigUInt64BE(8));
      if (len < 8) return true;   // a box that cannot be read: leave the file as it is
      pos += len;
    }
    return false;
  } catch { return true; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ } }
}

/** What this file needs to play on an Apple browser, or null when it plays as it is. */
function plan(f) {
  if ((f.mime === 'audio/ogg' || f.mime === 'audio/webm') && (f.size || 1) > 0) {
    return { ext: 'm4a', mime: 'audio/mp4', args: ['-vn', '-c:a', 'aac', '-b:a', '64k', '-ac', '1', '-movflags', '+faststart'] };
  }
  if (f.mime === 'video/mp4' && (f.size || 0) > 1_000_000 && (f.size || 0) < 700 * 1024 * 1024 && !moovAtStart(filePath(f.id))) {
    return { ext: 'mp4', mime: 'video/mp4', args: ['-c', 'copy', '-movflags', '+faststart'] };
  }
  return null;
}

const running = new Map();   // file id -> the copy being made
const failed = new Map();    // file id -> when it failed (not tried again at once)
let active = 0;
const waiting = [];
const slot = () => new Promise((resolve) => { if (active < MAX_PARALLEL) { active += 1; resolve(); } else waiting.push(resolve); });
const release = () => { const next = waiting.shift(); if (next) next(); else active -= 1; };

function convert(f, p, out) {
  return new Promise((resolve) => {
    const tmp = `${out}.${process.pid}.tmp.${p.ext}`;
    fs.mkdirSync(DIR, { recursive: true });
    const child = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', filePath(f.id), ...p.args, tmp], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { if (err.length < 500) err += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', (e) => { clearTimeout(timer); err = e.message; resolve(false); });
    child.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code === 0 && fs.statSync(tmp).size > 0) { fs.renameSync(tmp, out); sinceCheck += 1; if (sinceCheck % 20 === 1) prune(); return resolve(true); }
      } catch { /* failed */ }
      try { fs.unlinkSync(tmp); } catch { /* none */ }
      log('warn', 'playable copy failed', { file: f.id, code, err: err.trim().slice(0, 200) });
      resolve(false);
    });
  });
}

/** The file to serve instead of the original for this browser: { path, mime }, or null (serve the original). */
export async function playableFor(f, userAgent) {
  if (!f || !isAppleWebkit(userAgent) || !haveFfmpeg()) return null;
  const p = plan(f);
  if (!p) return null;
  const out = path.join(DIR, `${f.id}.${p.ext}`);
  if (fs.existsSync(out)) return { path: out, mime: p.mime };
  const bad = failed.get(f.id);
  if (bad && Date.now() - bad < FAIL_PAUSE_MS) return null;
  let job = running.get(f.id);
  if (!job) {
    job = (async () => {
      await slot();
      try { return await convert(f, p, out); } finally { release(); }
    })().finally(() => running.delete(f.id));
    running.set(f.id, job);
  }
  if (await job) return { path: out, mime: p.mime };
  failed.set(f.id, Date.now());
  return null;
}
