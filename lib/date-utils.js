import { config } from './config.js';

// "Today" and "N days ago" as YYYY-MM-DD, resolved in config.timezone —
// deliberately NOT `new Date().toISOString().slice(0, 10)`, which resolves
// in UTC regardless of what timezone the host machine or Node process is
// actually configured with. Near local midnight, in any timezone ahead of
// UTC, that silently returns yesterday's date instead of today's.
const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export function localIsoDate(date = new Date()) {
  return dateFormatter.format(date);
}

// A moment as local time with its UTC offset, to the second, e.g.
// "2026-10-23T21:55:23+01:00": every timestamp a tool returns uses this, so
// times line up across tools and with the user's own day, and stay
// unambiguous across a clock change. Takes ms, a Date or an ISO string;
// null for anything that isn't a time.
const timestampFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

export function localTimestamp(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (value == null || Number.isNaN(date.getTime())) return null;
  const p = Object.fromEntries(timestampFormatter.formatToParts(date).map((x) => [x.type, x.value]));
  const offset = p.timeZoneName === 'GMT' ? '+00:00' : p.timeZoneName.slice(3);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}${offset}`;
}

// Calendar arithmetic on today's Y-M-D (in config.timezone), not on the
// Date object's own local getters — those follow the host's timezone, which
// may not match config.timezone at all.
//
// Every trend tool that builds a [daysAgoIsoDate(window), localIsoDate()]
// range gets an INCLUSIVE window from SparkyFitness's range endpoints —
// days=30 returns 31 rows, days=14 returns 15. Confirmed consistent across
// endpoints; this is documented deliberately so a future "fix" doesn't
// silently shift every average and windowDays/entryCount comparison by one.
export function daysAgoIsoDate(days) {
  const [y, m, d] = localIsoDate().split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d - days)).toISOString().slice(0, 10);
}
