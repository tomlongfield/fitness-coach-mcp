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

// The hour (0-23) `date` falls in, in config.timezone — used to bucket a
// timestamp into a local time-of-day window (e.g. get_daily_summary's
// overnight 00:00-08:00 HRV average), the same way localIsoDate buckets one
// into a calendar day. Same rationale as localIsoDate: a raw UTC hour is
// wrong in any timezone ahead of UTC.
const hourFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: config.timezone,
  hour: '2-digit',
  hour12: false,
});

export function localHour(date = new Date()) {
  // Verified midnight prints "00" (not "24") on this runtime's ICU, but
  // that's a known inconsistency across ICU versions for en-GB's 24h
  // format — the modulo is a cheap guard against a future runtime where it
  // doesn't, not a workaround for an observed bug here.
  return Number(hourFormatter.format(date)) % 24;
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
