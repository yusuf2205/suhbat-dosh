// How fast the messenger is, measured where it happens: on the server for every request, and on the devices for what a person waits for.
// Kept in memory for a day; nothing about who or what, only how long.
const DAY = 24 * 3600_000;
const MAX = 5000; // samples per kind; the oldest go first
const series = new Map();

export const CLIENT_KINDS = {
  send: 'Отправка: от нажатия до галочки',
  send_net: 'Отправка: дорога до сервера и обратно',
  ping: 'Пинг по открытому соединению',
  open: 'Открытие чата: сообщения на экране',
  open_net: 'Открытие чата: ответ сервера',
};

export function record(key, ms) {
  if (!Number.isFinite(ms) || ms < 0) return;
  let s = series.get(key);
  if (!s) series.set(key, (s = []));
  s.push([Date.now(), ms]);
  if (s.length > MAX) s.splice(0, s.length - MAX);
}

/** What the devices sent: only the known kinds, only plausible numbers (an hour offline is not a measure of speed). */
export function recordClient(body) {
  for (const kind of Object.keys(CLIENT_KINDS)) {
    const list = body?.[kind];
    if (!Array.isArray(list)) continue;
    for (const ms of list.slice(0, 200)) if (typeof ms === 'number' && ms >= 0 && ms <= 60_000) record(`c:${kind}`, Math.round(ms));
  }
}

function stats(s) {
  const since = Date.now() - DAY;
  const v = s.filter(([t]) => t >= since).map(([, ms]) => ms).sort((a, b) => a - b);
  if (!v.length) return null;
  const at = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
  return { n: v.length, p50: at(0.5), p90: at(0.9), p99: at(0.99) };
}

/** For the console: what people wait for, and the server's own share of it by request. */
export function timingSummary() {
  const client = Object.entries(CLIENT_KINDS).map(([kind, label]) => ({ kind, label, ...stats(series.get(`c:${kind}`) || []) }));
  const server = [...series.entries()].filter(([k]) => k.startsWith('s:'))
    .map(([k, s]) => ({ route: k.slice(2), ...stats(s) })).filter((r) => r.n)
    .sort((a, b) => b.n - a.n).slice(0, 15);
  return { client, server };
}
