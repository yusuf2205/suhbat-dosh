// The daily check that everything is recorded and nothing is lost. It runs on the server at a fixed time (02:30 by default, night),
// whether the people are online or not: it does not need a single device. It checks the database, the files on the disk,
// the search index, scheduled messages, unfinished uploads, the backups, the free space and the Telegram copies (the bridge is asked
// to catch up on whatever it missed). Every run is kept; a problem is reported to the administrator.
import fs from 'node:fs';
import { config } from './config.js';
import { q } from './db.js';
import { getSetting, setSetting } from './access.js';
import { filePath } from './files.js';
import { bridgeConfigured, bridgeLiveAccounts, bridgeResync } from './bridge.js';
import { alert, listBackups, verifyStatus } from './ops.js';
import { log, now } from './util.js';
import { localClock, TZ, AT } from './clock.js';

const GB = 1024 ** 3;

const state = { running: false, progress: '', startedAt: 0 };
export const integrityState = () => ({ ...state, at: AT(), tz: TZ() });

const check = (name, status, text, extra = {}) => ({ name, status, text, ...extra });   // status: ok | warn | bad
const scalar = (sql, ...a) => q.get(sql, ...a)?.n ?? 0;
const fmtGb = (b) => `${(b / GB).toFixed(1)} ГБ`;

// ---------------------------------------------------------------- the checks (each one is independent: a failure of one does not stop the rest)
function checkDatabase() {
  const r = Object.values(q.get('PRAGMA quick_check') || {})[0];
  return r === 'ok' ? check('База данных', 'ok', 'целая, ошибок нет') : check('База данных', 'bad', `повреждена: ${String(r).slice(0, 120)}`);
}

function checkSearchIndex() {
  const have = scalar('SELECT COUNT(*) AS n FROM msg_fts');
  const need = scalar("SELECT COUNT(*) AS n FROM messages WHERE kind NOT IN ('secret', 'call')");
  if (have === need) return check('Индекс поиска', 'ok', `все ${need} сообщений в индексе`);
  // anything that is missing is added back (the index is only a copy of what is in the messages)
  let fixed = 0;
  try {
    const r = q.run(
      `INSERT INTO msg_fts (rowid, body)
       SELECT m.id, TRIM(COALESCE(m.text, '') || ' ' || COALESCE(t.text, '') || ' ' || COALESCE(f.name, ''))
       FROM messages m LEFT JOIN transcripts t ON t.message_id = m.id AND t.status = 'done' LEFT JOIN files f ON f.id = m.file_id
       WHERE m.kind NOT IN ('secret', 'call') AND m.id NOT IN (SELECT rowid FROM msg_fts)`,
    );
    fixed = Number(r.changes || 0);
  } catch (e) { return check('Индекс поиска', 'bad', `расхождение ${need - have}, исправить не удалось: ${String(e.message).slice(0, 80)}`); }
  const after = scalar('SELECT COUNT(*) AS n FROM msg_fts');
  return after >= need ? check('Индекс поиска', 'warn', `не хватало ${need - have}, добавлено ${fixed}`, { fixed }) : check('Индекс поиска', 'bad', `в индексе ${after} из ${need}`);
}

function checkFiles() {
  const rows = q.all('SELECT id, name, size, chat_id FROM files');
  const lost = [];
  let small = 0;
  for (const f of rows) {
    let st = null;
    try { st = fs.statSync(filePath(f.id)); } catch { /* not there */ }
    if (!st) lost.push(f); else if (st.size !== f.size) small += 1;
  }
  const orphans = scalar('SELECT COUNT(*) AS n FROM messages m WHERE m.file_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM files f WHERE f.id = m.file_id)');
  if (!lost.length && !small && !orphans) return check('Файлы на диске', 'ok', `все ${rows.length} файлов на месте`);
  const parts = [];
  if (lost.length) parts.push(`нет на диске: ${lost.length}`);
  if (small) parts.push(`размер не совпадает: ${small}`);
  if (orphans) parts.push(`сообщений без записи о файле: ${orphans}`);
  return check('Файлы на диске', 'bad', parts.join('; '), { examples: lost.slice(0, 5).map((f) => `${f.name} (чат ${f.chat_id ?? '—'})`) });
}

function checkUploads() {
  // an upload that the phone started and did not finish: the phone is offline or closed; it continues by itself when it is back
  const day = now() - 24 * 3600_000;
  const n = scalar('SELECT COUNT(*) AS n FROM uploads WHERE updated_at < ?', day);
  const week = scalar('SELECT COUNT(*) AS n FROM uploads WHERE updated_at < ?', now() - 7 * 24 * 3600_000);
  if (!n) return check('Недогруженные файлы', 'ok', 'всё дослано');
  return check('Недогруженные файлы', week ? 'warn' : 'ok', `ждут устройств: ${n}${week ? `, дольше недели: ${week} (будут убраны сами)` : ''}. Устройства дошлют их, когда вернутся в сеть.`);
}

function checkScheduled() {
  const late = scalar('SELECT COUNT(*) AS n FROM scheduled WHERE send_at < ?', now() - 15 * 60_000);
  return late ? check('Запланированные сообщения', 'bad', `не отправлены вовремя: ${late}`) : check('Запланированные сообщения', 'ok', 'всё отправляется вовремя');
}

function checkBackups() {
  const newest = listBackups()[0];
  if (!newest) return check('Резервные копии', 'bad', 'копий нет');
  const age = now() - newest.created_at;
  const hours = Math.round(age / 3600_000);
  const v = verifyStatus.last;
  if (age > 26 * 3600_000) return check('Резервные копии', 'bad', `последняя копия сделана ${hours} ч назад`);
  if (v && !v.ok) return check('Резервные копии', 'bad', `проверка последней копии не прошла: ${(v.problems || []).join('; ').slice(0, 120)}`);
  return check('Резервные копии', age > 8 * 3600_000 ? 'warn' : 'ok', `последняя ${hours < 1 ? 'меньше часа' : `${hours} ч`} назад${v ? (v.ok ? ', проверена' : '') : ', ещё не проверялась'}`);
}

function checkDisk() {
  try {
    const s = fs.statfsSync(config.dataDir);
    const free = s.bavail * s.bsize;
    const total = s.blocks * s.bsize;
    const low = Math.max(5 * GB, total * 0.05);
    return free < low ? check('Место на диске', 'bad', `свободно ${fmtGb(free)} из ${fmtGb(total)}`) : check('Место на диске', free < low * 3 ? 'warn' : 'ok', `свободно ${fmtGb(free)} из ${fmtGb(total)}`);
  } catch { return check('Место на диске', 'warn', 'не удалось узнать'); }
}

function checkMeaning() {
  const need = scalar("SELECT COUNT(*) AS n FROM messages m WHERE m.kind = 'text' AND length(m.text) >= 12 AND m.once = 0");
  const have = scalar("SELECT COUNT(*) AS n FROM embeddings e JOIN messages m ON m.id = e.message_id WHERE m.kind = 'text' AND length(m.text) >= 12 AND m.once = 0");
  if (!need) return check('Поиск по смыслу', 'ok', 'нечего индексировать');
  const pct = Math.round((Math.min(have, need) / need) * 100);
  return check('Поиск по смыслу', pct >= 90 ? 'ok' : 'warn', `проиндексировано ${pct}% (${have} из ${need}); остальное досчитывается само`);
}

/** Telegram: every linked account is brought up to date and the result is counted. */
async function checkTelegram() {
  const linked = q.all('SELECT b.user_id, u.name FROM tg_bridge b JOIN users u ON u.id = b.user_id');
  if (!bridgeConfigured() || !linked.length) return check('Копии из Телеграма', 'ok', 'нет подключённых аккаунтов');
  const imported = () => scalar("SELECT COUNT(*) AS n FROM messages WHERE import_key LIKE 'tg:%'");
  const before = imported();
  let live;
  try { live = await bridgeLiveAccounts(); } catch { return check('Копии из Телеграма', 'bad', 'сервис связи с Телеграмом не отвечает'); }
  const started = Math.floor(Date.now() / 1000);
  const asked = [];
  for (const a of linked) {
    state.progress = `Телеграм: догоняю ${a.name}`;
    try { if (live[String(a.user_id)]) { await bridgeResync(a.user_id); asked.push(a); } } catch { /* reported below by its state */ }
  }
  // wait until every asked account has finished its pass (at most ten minutes)
  const until = Date.now() + 10 * 60_000;
  let done = new Set();
  while (Date.now() < until && done.size < asked.length) {
    await new Promise((r) => setTimeout(r, 5000));
    try { live = await bridgeLiveAccounts(); } catch { continue; }
    done = new Set(asked.filter((a) => (live[String(a.user_id)]?.last_sync || 0) >= started && !live[String(a.user_id)]?.resyncing).map((a) => a.user_id));
  }
  const off = linked.filter((a) => !live[String(a.user_id)]?.connected);
  const added = imported() - before;
  const marks = scalar(`SELECT COUNT(*) AS n FROM messages m WHERE m.kind = 'text' AND m.file_id IS NULL AND m.import_key LIKE 'tg:%' AND m.tg_deleted = 0
    AND (m.text LIKE '[Фото]%' OR m.text LIKE '[Видео%' OR m.text LIKE '[Файл]%' OR m.text LIKE '[Голос%' OR m.text LIKE '[Аудио]%')
    AND m.id NOT IN (SELECT message_id FROM tg_media_skip)`);
  const parts = [`аккаунтов: ${linked.length}`, added > 0 ? `догнано сообщений: ${added}` : 'пропущенных сообщений нет'];
  if (marks) parts.push(`вложений ещё докачивается: ${marks}`);
  if (asked.length && done.size < asked.length) parts.push(`не успели проверить: ${asked.length - done.size}`);
  if (off.length) return check('Копии из Телеграма', 'bad', `${parts.join('; ')}; нет связи: ${off.map((a) => a.name).join(', ')}`, { added });
  return check('Копии из Телеграма', added > 0 || marks || done.size < asked.length ? 'warn' : 'ok', parts.join('; '), { added });
}

// ---------------------------------------------------------------- one run
export async function runIntegrity(trigger = 'auto', { quiet = false } = {}) {
  if (state.running) return null;
  state.running = true;
  state.startedAt = Date.now();
  state.progress = 'начинаю';
  const t0 = Date.now();
  const checks = [];
  const steps = [checkDatabase, checkSearchIndex, checkFiles, checkUploads, checkScheduled, checkBackups, checkDisk, checkMeaning, checkTelegram];
  try {
    for (const fn of steps) {
      state.progress = fn.name.replace(/^check/, '');
      try { checks.push(await fn()); } catch (e) { checks.push(check(fn.name.replace(/^check/, ''), 'bad', `проверка не выполнилась: ${String(e.message).slice(0, 100)}`)); }
    }
  } finally { state.running = false; state.progress = ''; }
  const bad = checks.filter((c) => c.status === 'bad').length;
  const warn = checks.filter((c) => c.status === 'warn').length;
  const r = q.run('INSERT INTO integrity_runs (ts, trigger, ok, bad, warn, duration_ms, checks) VALUES (?,?,?,?,?,?,?)', now(), trigger, bad ? 0 : 1, bad, warn, Date.now() - t0, JSON.stringify(checks));
  q.run('DELETE FROM integrity_runs WHERE id NOT IN (SELECT id FROM integrity_runs ORDER BY id DESC LIMIT 120)');
  const prev = q.get('SELECT ok FROM integrity_runs WHERE id < ? ORDER BY id DESC LIMIT 1', r.lastInsertRowid);
  if (bad && !quiet) alert(`⚠️ Проверка записи данных (${trigger === 'auto' ? 'ежедневная' : 'по запросу'}): есть проблемы.\n${checks.filter((c) => c.status === 'bad').map((c) => `• ${c.name}: ${c.text}`).join('\n')}`);
  else if (!bad && prev && !prev.ok) alert('✅ Проверка записи данных: проблемы устранены, всё в порядке.');
  log('info', 'integrity check', { bad, warn, ms: Date.now() - t0 });
  return { id: Number(r.lastInsertRowid), ok: !bad, bad, warn, checks };
}

/** The words of a problem report: what failed and why. */
const problemsText = (res, kind) => `⚠️ Проверка записи данных (${kind}): есть проблемы.\n${res.checks.filter((c) => c.status === 'bad').map((c) => `• ${c.name}: ${c.text}`).join('\n')}`;

export function lastRuns(limit = 14) {
  return q.all('SELECT id, ts, trigger, ok, bad, warn, duration_ms, checks FROM integrity_runs ORDER BY id DESC LIMIT ?', limit)
    .map((r) => ({ ...r, ok: !!r.ok, checks: JSON.parse(r.checks || '[]') }));
}

// ---------------------------------------------------------------- the clock: once a day at the set time; a day that was missed (the server was down at that moment) is made up for as soon as it is back
export function startIntegrity() {
  let retries = 0;
  let retryAt = 0;
  const telegramDown = (res) => !!res && res.checks.some((c) => c.name === 'Копии из Телеграма' && c.status === 'bad');
  const tick = async () => {
    if (state.running) return;
    const { day, hm } = localClock();
    // the connection to Telegram may be down (no internet at that hour): the check is repeated every 20 minutes, up to six times; only the last run speaks up
    if (retryAt && Date.now() >= retryAt) {
      retryAt = 0;
      retries += 1;
      const res = await runIntegrity('auto', { quiet: retries < 6 }).catch(() => null);
      if (telegramDown(res) && retries < 6) retryAt = Date.now() + 20 * 60_000; else retries = 0;
      return;
    }
    if (getSetting('integrity_day') === day || hm < AT()) return;
    setSetting('integrity_day', day);
    const res = await runIntegrity('auto', { quiet: true }).catch((e) => { log('error', 'integrity failed', { err: e.message }); return null; });
    if (telegramDown(res)) { retries = 0; retryAt = Date.now() + 20 * 60_000; } else if (res && !res.ok) {
      // a problem that no waiting fixes: say so at once
      alert(problemsText(res, 'ежедневная'));
    }
  };
  setInterval(() => { tick().catch(() => {}); }, 30_000).unref();
  setTimeout(() => { tick().catch(() => {}); }, 60_000).unref();
}
