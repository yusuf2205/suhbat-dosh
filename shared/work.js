// Working hours: when a person is "at work". Outside them an automatic reply can be sent. Isomorphic, no dependencies.

export const WORK_DEFAULT = { on: false, days: [1, 2, 3, 4, 5], from: '09:00', to: '18:00', tz: 0, text: '' };

export function normalizeWork(raw) {
  const w = { ...WORK_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) };
  const hm = (v, d) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : d);
  w.on = !!w.on;
  w.from = hm(w.from, WORK_DEFAULT.from);
  w.to = hm(w.to, WORK_DEFAULT.to);
  if (w.from >= w.to) { w.from = WORK_DEFAULT.from; w.to = WORK_DEFAULT.to; }
  w.days = Array.isArray(w.days) ? [...new Set(w.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))] : WORK_DEFAULT.days;
  if (!w.days.length) w.days = WORK_DEFAULT.days;
  w.tz = Number.isInteger(w.tz) && Math.abs(w.tz) <= 14 * 60 ? w.tz : 0;
  w.text = typeof w.text === 'string' ? w.text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, 300) : '';
  return w;
}

/** Is it a working moment? (When the schedule is off the answer is always true: nothing to announce.) `tz` = minutes to add to UTC. */
export function workOpen(raw, at = Date.now()) {
  const w = normalizeWork(raw);
  if (!w.on) return true;
  const local = new Date(at + w.tz * 60_000);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  return w.days.includes(local.getUTCDay()) && mins >= toMin(w.from) && mins < toMin(w.to);
}
