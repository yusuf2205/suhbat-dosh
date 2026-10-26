// Server health for the admin console: load samples, database snapshots, disk / error alerts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pipeline } from 'node:stream/promises';
import { config } from './config.js';
import { db, q } from './db.js';
import { HttpError, log, now } from './util.js';
import { notifyAdmins } from './notify.js';
import { notifyTelegram } from './telegram.js';
import { bridgeAvailable, bridgeConfigured } from './bridge.js';
import { getSetting, setSetting } from './access.js';
import { turnStatus } from './turn.js';

// counters bumped by index.js
export const counters = { requests: 0, errors: 0, bytesIn: 0 };

// ------------------------------------------------------------------ metrics (in memory, last 24 h, 1 sample / minute)
const SAMPLES = 1440;
const samples = [];
let lastCpu = null;
let lastCount = { requests: 0, errors: 0 };

const cpuTimes = () => os.cpus().reduce((a, c) => {
  const t = c.times;
  a.idle += t.idle;
  a.total += t.user + t.nice + t.sys + t.idle + t.irq;
  return a;
}, { idle: 0, total: 0 });

function disk() {
  try {
    const s = fs.statfsSync(config.dataDir);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch { return { total: 0, free: 0 }; }
}

let wsCount = () => 0;
export function setWsCounter(fn) { wsCount = fn; }

function sample() {
  const c = cpuTimes();
  let cpu = 0;
  if (lastCpu) {
    const dt = c.total - lastCpu.total;
    cpu = dt > 0 ? Math.round((1 - (c.idle - lastCpu.idle) / dt) * 1000) / 10 : 0;
  }
  lastCpu = c;
  const d = disk();
  const s = {
    t: now(), cpu,
    mem: Math.round(((os.totalmem() - os.freemem()) / os.totalmem()) * 1000) / 10,
    rss: process.memoryUsage().rss,
    disk_free: d.free,
    ws: wsCount(),
    req: counters.requests - lastCount.requests,
    err: counters.errors - lastCount.errors,
  };
  lastCount = { requests: counters.requests, errors: counters.errors };
  samples.push(s);
  if (samples.length > SAMPLES) samples.shift();
  return s;
}

export function systemSnapshot() {
  const d = disk();
  const dbSize = (() => {
    let n = 0;
    for (const ext of ['', '-wal']) { try { n += fs.statSync(config.dbFile + ext).size; } catch { /* none */ } }
    return n;
  })();
  const files = q.get('SELECT COALESCE(SUM(size),0) AS n FROM files').n;
  const last = samples.at(-1) || sample();
  return {
    now: {
      cpu: last.cpu, mem: last.mem, rss: process.memoryUsage().rss, uptime: Math.round(process.uptime()), host_uptime: Math.round(os.uptime()),
      cpus: os.cpus().length, load: os.loadavg().map((x) => Math.round(x * 100) / 100), node: process.version,
      disk_total: d.total, disk_free: d.free, db_bytes: dbSize, files_bytes: files, mem_total: os.totalmem(), turn: turnStatus(),
    },
    series: samples,
  };
}

// ------------------------------------------------------------------ database snapshots
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

export function createBackup(kind = 'manual') {
  fs.mkdirSync(config.backupDir, { recursive: true });
  const name = `db-${stamp()}-${kind}.db`;
  const dest = path.join(config.backupDir, name);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  // verify the snapshot opens and passes an integrity check
  const t = new DatabaseSync(dest, { readOnly: true });
  try {
    const ok = t.prepare('PRAGMA integrity_check').get();
    if (Object.values(ok)[0] !== 'ok') throw new Error('integrity check failed');
  } finally { t.close(); }
  prune();
  mirrorBackup(dest, name); // second disk / WebDAV cloud, in the background
  return { name, size: fs.statSync(dest).size };
}

// ---- off-site copies: a second folder (another disk / USB / NAS share) and/or a WebDAV cloud (Nextcloud, Yandex Disk, pCloud ...)
export const mirrorStatus = { last: null };
const webdavUrl = () => (process.env.BACKUP_WEBDAV_URL || '').replace(/\/+$/, '');

/** The time in a snapshot's name (db-2026-10-15T12-45-22-auto.db, UTC), for disks that do not keep file times. */
const stampOf = (name, fallback) => {
  const m = /^db-(\d{4})-(\d\d)-(\d\d)T(\d\d)-(\d\d)-(\d\d)/.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : fallback;
};

/** A plain byte copy: copyFile also tries to copy the permissions, which a Windows-formatted (NTFS/exFAT) USB disk refuses. */
const copyPlain = (from, to) => pipeline(fs.createReadStream(from), fs.createWriteStream(to));

/** An external disk that is not plugged in must not be "written" into the empty folder it leaves behind: a marker file proves it is there. */
const offsiteMissing = () => !offsite().found;

/**
 * Where the second copies go. Either fixed (BACKUP_MIRROR_DIR / BACKUP_FILES_DIR / BACKUP_MIRROR_MARKER), or found: BACKUP_OFFSITE_FIND is
 * a folder with the external disks inside (they may come up late after a reboot and under another name, sdc1 today and sdd1 tomorrow);
 * the disk that holds a folder named BACKUP_OFFSITE_NAME with the file ".offsite" in it is the one.
 */
export function offsite() {
  const find = process.env.BACKUP_OFFSITE_FIND;
  if (find) {
    const name = process.env.BACKUP_OFFSITE_NAME || 'Suhbat-backup';
    try {
      for (const d of fs.readdirSync(find)) {
        const root = path.join(find, d, name);
        if (fs.existsSync(path.join(root, '.offsite'))) return { configured: true, found: true, dir: path.join(root, 'db'), files: path.join(root, 'files'), where: `${d}/${name}` };
      }
    } catch { /* the folder is not there */ }
    return { configured: true, found: false, dir: path.join(find, '_missing', 'db'), files: null, where: null };
  }
  const dir = process.env.BACKUP_MIRROR_DIR || '';
  const marker = process.env.BACKUP_MIRROR_MARKER;
  return { configured: !!dir, found: !marker || fs.existsSync(marker), dir: dir || null, files: process.env.BACKUP_FILES_DIR || null, where: dir || null };
}

export function mirrorConfig() {
  const o = offsite();
  const dir = o.configured ? (o.where || o.dir || 'внешний диск') : '';
  const url = webdavUrl();
  return { dir: dir || null, webdav: url ? url.replace(/\/\/[^/@]*@/, '//') : null, configured: !!(dir || url) };
}

async function mirrorBackup(src, name) {
  const o = offsite();
  const dir = o.configured ? o.dir : null;
  const url = webdavUrl();
  if (!dir && !url) return;
  const out = { at: now(), name, dir: null, webdav: null };
  if (dir && offsiteMissing()) out.dir = 'внешний диск не подключён';
  else if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      // the new snapshot and every older one the second place does not have yet (the first run after it was set up)
      for (const b of listBackups()) {
        const to = path.join(dir, b.name);
        try { if (fs.statSync(to).size === b.size) continue; } catch { /* not there yet */ }
        await copyPlain(path.join(config.backupDir, b.name), to + '.part');
        fs.renameSync(to + '.part', to);
        try { fs.utimesSync(to, new Date(b.created_at), new Date(b.created_at)); } catch { /* the time is only used for the retention */ }
      }
      const here = fs.readdirSync(dir).filter((n) => /^[\w.-]+\.db$/.test(n)).map((n) => ({ name: n, created_at: stampOf(n, Math.round(fs.statSync(path.join(dir, n)).mtimeMs)), kind: n.includes('-auto') ? 'auto' : n.startsWith('pre-restore') ? 'pre-restore' : 'manual' }));
      const keep = keepSet(here);
      for (const old of here) if (!keep.has(old.name)) fs.rmSync(path.join(dir, old.name), { force: true });
      out.dir = 'ok';
    } catch (e) { out.dir = String(e.message).slice(0, 120); }
  }
  if (url) {
    try {
      const user = process.env.BACKUP_WEBDAV_USER;
      const auth = user ? { authorization: `Basic ${Buffer.from(`${user}:${process.env.BACKUP_WEBDAV_PASS || ''}`).toString('base64')}` } : {};
      const r = await fetch(`${url}/${name}`, { method: 'PUT', headers: auth, body: fs.readFileSync(src), signal: AbortSignal.timeout(10 * 60_000) });
      out.webdav = r.ok ? 'ok' : `HTTP ${r.status}`;
    } catch (e) { out.webdav = String(e.message).slice(0, 120); }
  }
  mirrorStatus.last = out;
  const bad = [];
  if (dir && out.dir !== 'ok') bad.push(`папка — ${out.dir}`);
  if (url && out.webdav !== 'ok') bad.push(`WebDAV — ${out.webdav}`);
  if (bad.length) alert(`⚠️ Копия базы не попала во внешнее хранилище: ${bad.join('; ')}`);
}

export function listBackups() {
  try {
    return fs.readdirSync(config.backupDir).filter((n) => /^[\w.-]+\.db$/.test(n)).map((n) => {
      const st = fs.statSync(path.join(config.backupDir, n));
      return { name: n, size: st.size, created_at: Math.round(st.mtimeMs), kind: n.includes('-auto') ? 'auto' : n.startsWith('pre-restore') ? 'pre-restore' : 'manual' };
    }).sort((a, b) => b.created_at - a.created_at);
  } catch { return []; }
}

/**
 * Which snapshots to keep: the newest ten, the newest of each of the last 14 days, of each of the last 8 weeks and of each
 * of the last 12 months; the ones made by hand for 90 days, the ones taken before a restore for 30 days.
 */
export function keepSet(list, at = now()) {
  const keep = new Set();
  const sorted = [...list].sort((a, b) => b.created_at - a.created_at);
  sorted.slice(0, 10).forEach((b) => keep.add(b.name));
  const seen = { d: new Set(), w: new Set(), m: new Set() };
  const DAY = 86400_000;
  for (const b of sorted) {
    const age = at - b.created_at;
    const d = new Date(b.created_at);
    const day = Math.floor(b.created_at / DAY);
    const week = Math.floor((day + 3) / 7); // weeks start on Monday (1970-01-01 was a Thursday)
    const month = d.getUTCFullYear() * 12 + d.getUTCMonth();
    if (age <= 14 * DAY && !seen.d.has(day)) { seen.d.add(day); keep.add(b.name); }
    if (age <= 56 * DAY && !seen.w.has(week)) { seen.w.add(week); keep.add(b.name); }
    if (age <= 366 * DAY && !seen.m.has(month)) { seen.m.add(month); keep.add(b.name); }
    if (b.kind === 'manual' && age <= 90 * DAY) keep.add(b.name);
    if (b.kind === 'pre-restore' && age <= 30 * DAY) keep.add(b.name);
  }
  return keep;
}

function prune() {
  const all = listBackups();
  const keep = keepSet(all);
  for (const old of all) if (!keep.has(old.name)) fs.rmSync(path.join(config.backupDir, old.name), { force: true });
}

const safeName = (n) => {
  const name = path.basename(String(n || ''));
  if (!/^[\w.-]+\.db$/.test(name) || !fs.existsSync(path.join(config.backupDir, name))) throw new HttpError(404, 'not_found');
  return name;
};
export const backupPath = (n) => path.join(config.backupDir, safeName(n));
export const deleteBackup = (n) => fs.rmSync(backupPath(n), { force: true });

/** Restore is applied at the next start (see db.js); the process exits and Docker brings it back. */
export function scheduleRestore(n) {
  const name = safeName(n);
  fs.writeFileSync(path.join(config.dataDir, 'restore.pending'), name);
  setTimeout(() => process.exit(0), 800).unref();
  return name;
}

// ------------------------------------------------------------------ is the copy usable?
export const verifyStatus = { last: null };
const COUNT_TABLES = ['users', 'chats', 'messages', 'files'];

/**
 * Opens a snapshot on its own and checks it the way a restore would need it: the database is intact, the tables are there,
 * it holds roughly what the live one holds, and the uploaded files it refers to are in the second place too.
 */
export function verifyBackup(name) {
  const file = backupPath(name);
  const out = { at: now(), name, ok: false, integrity: null, counts: {}, live: {}, newest_message_at: null, files_missing: null, problems: [] };
  const t = new DatabaseSync(file, { readOnly: true });
  try {
    out.integrity = Object.values(t.prepare('PRAGMA integrity_check').get())[0];
    if (out.integrity !== 'ok') out.problems.push('база повреждена');
    for (const tb of COUNT_TABLES) {
      try {
        out.counts[tb] = t.prepare(`SELECT COUNT(*) AS n FROM ${tb}`).get().n;
        out.live[tb] = q.get(`SELECT COUNT(*) AS n FROM ${tb}`).n;
      } catch { out.problems.push(`нет таблицы ${tb}`); }
    }
    try { out.newest_message_at = t.prepare('SELECT MAX(created_at) AS t FROM messages').get().t || null; } catch { /* no table */ }
    // a snapshot that is much smaller than the live data is not a copy of it
    for (const tb of ['users', 'messages']) if (out.live[tb] > 50 && out.counts[tb] < out.live[tb] * 0.5) out.problems.push(`в копии мало записей: ${tb}`);
    const dest = offsite().files || path.join(config.backupDir, 'files');
    try {
      const have = new Set(fs.readdirSync(dest));
      out.files_missing = t.prepare('SELECT id FROM files').all().filter((r) => fs.existsSync(path.join(config.filesDir, r.id)) && !have.has(r.id)).length;
      if (out.files_missing > 0) out.problems.push(`файлов нет в копии: ${out.files_missing}`);
    } catch { out.files_missing = null; }
  } catch (e) {
    out.problems.push(String(e.message).slice(0, 120));
  } finally { t.close(); }
  out.ok = out.problems.length === 0;
  verifyStatus.last = out;
  return out;
}

let lastVerifyAlert = 0;
function autoVerify() {
  const newest = listBackups()[0];
  if (!newest) return;
  try {
    const r = verifyBackup(newest.name);
    if (!r.ok && now() - lastVerifyAlert > 12 * 3600_000) {
      lastVerifyAlert = now();
      alert(`⚠️ Проверка резервной копии не прошла (${newest.name}): ${r.problems.join('; ')}`);
    }
  } catch (e) { log('error', 'backup verify failed', { err: e.message }); }
}

// ------------------------------------------------------------------ alerts: in the messenger and, where the administrator signed in with Telegram, there too
export function alert(text) {
  notifyAdmins(text);
  for (const r of q.all('SELECT telegram_id FROM users WHERE is_admin = 1 AND is_bot = 0 AND banned_at IS NULL AND telegram_id IS NOT NULL')) notifyTelegram(r.telegram_id, text);
}

// ------------------------------------------------------------------ monitors
let lastDiskAlert = 0;
let lastErrAlert = 0;

function check() {
  const s = sample();
  const d = disk();
  if (d.total && d.free < Math.max(5 * 1024 ** 3, d.total * 0.08) && now() - lastDiskAlert > 12 * 3600_000) {
    lastDiskAlert = now();
    alert(`⚠️ На диске сервера заканчивается место: свободно ${(d.free / 1024 ** 3).toFixed(1)} ГБ из ${(d.total / 1024 ** 3).toFixed(0)} ГБ.`);
  }
  const recentErr = samples.slice(-10).reduce((a, x) => a + x.err, 0);
  if (recentErr >= 15 && now() - lastErrAlert > 3600_000) {
    lastErrAlert = now();
    alert(`⚠️ Всплеск ошибок сервера: ${recentErr} за последние 10 минут. Проверьте журнал контейнера.`);
  }
  return s;
}

/**
 * Uploaded files are copied (never moved, never deleted) next to the database snapshots, so a lost disk
 * or a broken volume does not take the users' files with it. Only files that are not mirrored yet are copied.
 */
export const filesMirror = { last: null };
async function mirrorFiles() {
  const o = offsite();
  const dest = o.files || path.join(config.backupDir, 'files');
  let copied = 0;
  let bytes = 0;
  try {
    if (o.configured && !o.found) throw new Error('внешний диск не подключён');
    await fs.promises.mkdir(dest, { recursive: true });
    for (const ent of await fs.promises.readdir(config.filesDir, { withFileTypes: true })) {
      if (!ent.isFile()) continue;
      const src = path.join(config.filesDir, ent.name);
      const to = path.join(dest, ent.name);
      const st = await fs.promises.stat(src);
      if (Date.now() - st.mtimeMs < 60_000) continue; // still being written
      try { if ((await fs.promises.stat(to)).size === st.size) continue; } catch { /* not mirrored yet */ }
      await copyPlain(src, to + '.part');
      await fs.promises.rename(to + '.part', to);
      copied += 1;
      bytes += st.size;
    }
    filesMirror.last = { at: now(), copied, bytes, error: null };
    if (copied) log('info', 'files mirrored', { copied, bytes });
  } catch (e) {
    filesMirror.last = { at: now(), copied, bytes, error: String(e.message).slice(0, 120) };
    log('error', 'files mirror failed', { err: e.message });
  }
}

function autoBackup() {
  mirrorFiles();
  try {
    const newest = listBackups().find((b) => b.kind === 'auto' || b.kind === 'manual');
    if (!newest || now() - newest.created_at > 6 * 3600_000) {
      const b = createBackup('auto');
      log('info', 'auto backup', { name: b.name, size: b.size });
    } else mirrorBackup(path.join(config.backupDir, newest.name), newest.name); // nothing new: still bring the second place up to date
  } catch (e) { log('error', 'auto backup failed', { err: e.message }); }
}

const probes = new Map(); // name -> { fails, since, alerted }
async function probe(name, label, test) {
  const p = probes.get(name) || { fails: 0, since: 0, alerted: false };
  probes.set(name, p);
  let ok = false;
  try { ok = await test(); } catch { ok = false; }
  if (ok) {
    if (p.alerted) alert(`✅ ${label}: снова работает (не отвечал около ${Math.max(1, Math.round((now() - p.since) / 60_000))} мин).`);
    p.fails = 0; p.alerted = false;
    return;
  }
  if (!p.fails) p.since = now();
  p.fails += 1;
  if (p.fails === 3 && !p.alerted) { p.alerted = true; alert(`⚠️ ${label}: не отвечает уже несколько минут.`); }
}

/** Is everything the messenger relies on answering? The public address is checked from inside, through the tunnel, like a visitor would. */
async function runProbes() {
  const pub = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
  if (pub) await probe('site', `Сайт ${pub.replace(/^https?:\/\//, '')} снаружи`, async () => (await fetch(`${pub}/healthz`, { signal: AbortSignal.timeout(8000) })).ok);
  if (bridgeConfigured()) await probe('bridge', 'Мост с Телеграмом', () => bridgeAvailable());
}

export function startMonitors() {
  // the server was off for a while (power cut, the NAS restarted, a crash): the last heartbeat tells
  const last = Number(getSetting('heartbeat', '0')) || 0;
  setTimeout(() => {
    if (last && now() - last > 5 * 60_000) alert(`⚠️ Сервер был недоступен около ${Math.round((now() - last) / 60_000)} мин (перезагрузка, отключение питания или сбой). Сейчас работает.`);
  }, 20_000).unref();
  setInterval(() => { try { setSetting('heartbeat', String(now())); } catch { /* the database is busy */ } }, 60_000).unref();
  setInterval(runProbes, 60_000).unref();
  sample();
  setInterval(check, 60_000).unref();
  setTimeout(autoBackup, 30_000).unref();
  setInterval(autoBackup, 3600_000).unref();
  setTimeout(autoVerify, 5 * 60_000).unref();
  setInterval(autoVerify, 24 * 3600_000).unref();
}
