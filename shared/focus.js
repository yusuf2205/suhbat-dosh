// Focus mode: notifications are paused by hand (until a time) or by a weekly schedule, with exceptions.
// Used by the server (push, calls) and by the web client (sounds, banners), so it must stay dependency-free.

export const FOCUS_DEFAULT = {
  on: false, until: 0, sched: null, tz: 0, allow: [], calls: true, mentions: true, urgent: true,
};

export function normalizeFocus(raw) {
  const f = { ...FOCUS_DEFAULT, ...(raw && typeof raw === 'object' ? raw : {}) };
  f.on = !!f.on;
  f.until = Number.isFinite(Number(f.until)) ? Math.max(0, Number(f.until)) : 0;
  f.tz = Number.isInteger(f.tz) && Math.abs(f.tz) <= 14 * 60 ? f.tz : 0;
  f.allow = Array.isArray(f.allow) ? [...new Set(f.allow.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200) : [];
  f.calls = f.calls !== false;
  f.mentions = f.mentions !== false;
  f.urgent = f.urgent !== false;
  const s = f.sched;
  const hm = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v) ? v : null);
  f.sched = s && hm(s.from) && hm(s.to) && s.from !== s.to
    ? { from: s.from, to: s.to, days: Array.isArray(s.days) ? [...new Set(s.days.map(Number).filter((d) => d >= 0 && d <= 6))] : [0, 1, 2, 3, 4, 5, 6] }
    : null;
  if (f.sched && !f.sched.days.length) f.sched = null;
  return f;
}

/** Is the focus on right now? `tz` is minutes to ADD to UTC to get the user's local time (the opposite sign of getTimezoneOffset). */
export function focusActive(raw, at = Date.now()) {
  const f = normalizeFocus(raw);
  if (f.on && (f.until === 0 || f.until > at)) return true;
  if (!f.sched) return false;
  const local = new Date(at + f.tz * 60_000);
  const mins = local.getUTCHours() * 60 + local.getUTCMinutes();
  const toMin = (v) => Number(v.slice(0, 2)) * 60 + Number(v.slice(3));
  const a = toMin(f.sched.from);
  const b = toMin(f.sched.to);
  const day = local.getUTCDay();
  if (a < b) return f.sched.days.includes(day) && mins >= a && mins < b;
  // overnight window (22:00-08:00): the evening part belongs to the day it started on, the morning part to the previous day
  if (mins >= a) return f.sched.days.includes(day);
  if (mins < b) return f.sched.days.includes((day + 6) % 7);
  return false;
}

/** May this event break through the focus? */
export function focusAllows(raw, { senderId = 0, urgent = false, mention = false, call = false } = {}) {
  const f = normalizeFocus(raw);
  if (f.allow.includes(senderId)) return !call || f.calls;
  if (call) return false;
  if (urgent && f.urgent) return true;
  if (mention && f.mentions) return true;
  return false;
}
