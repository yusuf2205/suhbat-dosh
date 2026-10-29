// The time of day in the administrator's zone (the daily check runs at a fixed hour there, not in the server's UTC).
export const AT = () => process.env.INTEGRITY_AT || '14:00';
export const TZ = () => process.env.INTEGRITY_TZ || 'Asia/Tashkent';

/** The date and the time of day in the administrator's time zone: { day: '2026-10-30', hm: '14:00' }. */
export function localClock(ts = Date.now()) {
  let p;
  try {
    p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ(), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  } catch { p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(ts)).map((x) => [x.type, x.value])); }
  return { day: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}

