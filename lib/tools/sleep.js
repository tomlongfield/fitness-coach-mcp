import { z } from 'zod';
import { getSleepAnalytics, getSleepEntries, getSleepScience, getCustomMeasurementRange } from '../sparkyfitness-client.js';
import { asJson } from './shared.js';
import { localIsoDate, localTimestamp, daysAgoIsoDate } from '../date-utils.js';

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const round = (n, dp = 0) => (n == null ? null : Number(n.toFixed(dp)));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Figures on a night's own row that only some sources send (Apple Health
// sends overnight HRV, Garmin and Health Connect the rest): SparkyFitness
// column -> output field, decimal places.
//
// The row's resting_heart_rate is left out: it is not measured overnight.
// SparkyFitness's iOS app copies in the wake day's latest daily resting
// heart rate (sleepBiometrics.ts), so it equals the daily resting_heart_rate
// measurement exactly (checked on every night it was set, 2026-10-24..31),
// which get_vitals_trend and the rollup's restingHrBpm already give.
// avg_overnight_hrv is different: the mean of the HRV readings inside the
// night's longest sleep.
const NIGHT_EXTRAS = [
  ['avg_overnight_hrv', 'overnightHrvMs', 1],
  ['average_spo2_value', 'spo2AvgPct', 1],
  ['lowest_spo2_value', 'spo2MinPct', 1],
  ['average_respiration_value', 'respirationAvgBrpm', 1],
  ['avg_sleep_stress', 'sleepStressAvg', 0],
  ['restless_moments_count', 'restlessMoments', 0],
  ['body_battery_change', 'bodyBatteryChange', 0],
];

// The analytics endpoint's figures, for get_daily_summary (daily-summary.js),
// which needs only sleepScore and so skips the larger /sleep read. Its
// stagePercentages (always {unspecified: 100}, an upstream bug) and its
// per-night sleepDebt (8 h minus time in bed, not SparkyFitness's sleep
// debt) are left out.
function summarizeAnalyticsDay(e) {
  return {
    date: e.date,
    asleepMin: Math.round(e.timeAsleep / 60),
    sessionDurationMin: Math.round(e.totalSleepDuration / 60),
    sleepScore: e.sleepScore,
    bedtime: localTimestamp(e.earliestBedtime),
    wakeTime: localTimestamp(e.latestWakeTime),
    sleepEfficiencyPct: round(num(e.sleepEfficiency), 1),
    awakePeriods: e.awakePeriods,
    awakeMin: Math.round(e.totalAwakeDuration / 60),
  };
}

export async function fetchSleepEntries(days) {
  return (await getSleepAnalytics(days))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(summarizeAnalyticsDay);
}

// Each night with raw figures (seconds, unrounded) from both endpoints,
// joined on date: analytics for what it calculates (efficiency, awake
// periods, score), /sleep for the stages and the extras. Should a date have
// two rows, the longest asleep is the night, as in SparkyFitness's own
// clustering.
async function fetchNights(days) {
  const [analytics, entries] = await Promise.all([getSleepAnalytics(days), getSleepEntries(days)]);
  const rowByDate = new Map();
  for (const e of entries ?? []) {
    if (!e?.entry_date) continue;
    const kept = rowByDate.get(e.entry_date);
    if (!kept || (num(e.time_asleep_in_seconds) ?? 0) > (num(kept.time_asleep_in_seconds) ?? 0)) rowByDate.set(e.entry_date, e);
  }
  return (analytics ?? [])
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((a) => {
      const row = rowByDate.get(a.date) ?? {};
      return {
        date: a.date,
        asleepS: num(a.timeAsleep),
        inBedS: num(a.totalSleepDuration),
        score: num(a.sleepScore),
        efficiencyPct: num(a.sleepEfficiency),
        awakePeriods: num(a.awakePeriods),
        awakeS: num(a.totalAwakeDuration),
        bedtime: a.earliestBedtime ?? null,
        wakeTime: a.latestWakeTime ?? null,
        deepS: num(row.deep_sleep_seconds),
        remS: num(row.rem_sleep_seconds),
        lightS: num(row.light_sleep_seconds),
        ...Object.fromEntries(NIGHT_EXTRAS.map(([col, field]) => [field, num(row[col])])),
      };
    });
}

const minutes = (s) => (s == null ? null : Math.round(s / 60));
const present = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v != null));

function summarizeNight(n) {
  return {
    date: n.date,
    asleepMin: minutes(n.asleepS),
    sessionDurationMin: minutes(n.inBedS),
    sleepScore: n.score,
    bedtime: localTimestamp(n.bedtime),
    wakeTime: localTimestamp(n.wakeTime),
    sleepEfficiencyPct: round(n.efficiencyPct, 1),
    awakePeriods: n.awakePeriods,
    awakeMin: minutes(n.awakeS),
    ...present({
      deepMin: minutes(n.deepS),
      remMin: minutes(n.remS),
      lightMin: minutes(n.lightS),
      ...Object.fromEntries(NIGHT_EXTRAS.map(([, field, dp]) => [field, round(n[field], dp)])),
    }),
  };
}

// Clock times as minutes after 18:00 local, so bedtimes either side of
// midnight sit next to each other (23:50 and 00:10 have a median of 00:00).
const EVENING = 18 * 60;
function clockMinutes(value) {
  const ts = localTimestamp(value);
  if (!ts) return null;
  return (Number(ts.slice(11, 13)) * 60 + Number(ts.slice(14, 16)) - EVENING + 1440) % 1440;
}
function clockLabel(m) {
  if (m == null) return null;
  const t = (Math.round(m) + EVENING) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}
function quantile(sorted, q) {
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  return sorted[lo] + (sorted[Math.ceil(pos)] - sorted[lo]) * (pos - lo);
}
function clockStats(values) {
  const xs = values.filter((v) => v != null).sort((a, b) => a - b);
  return {
    median: xs.length ? quantile(xs, 0.5) : null,
    iqr: xs.length >= 4 ? quantile(xs, 0.75) - quantile(xs, 0.25) : null,
    n: xs.length,
  };
}
const midpoint = (n) => (n.bedtime && n.wakeTime ? new Date((Date.parse(n.bedtime) + Date.parse(n.wakeTime)) / 2) : null);

// Per-night means, each over the nights that have the figure.
// Output field, the night's raw field, divisor (seconds to minutes),
// decimal places.
const NIGHT_MEANS = [
  ['asleepMin', 'asleepS', 60, 0],
  ['inBedMin', 'inBedS', 60, 0],
  ['efficiencyPct', 'efficiencyPct', 1, 1],
  ['score', 'score', 1, 1],
  ['awakePeriods', 'awakePeriods', 1, 1],
  ['awakeMin', 'awakeS', 60, 0],
  ['deepMin', 'deepS', 60, 0],
  ['remMin', 'remS', 60, 0],
  ['lightMin', 'lightS', 60, 0],
];
const STAGES = [['deepPct', 'deepS'], ['remPct', 'remS'], ['lightPct', 'lightS']];

// One window's figures as { field: { v, n, dp } }: v unrounded, n the
// nights (or days) behind it. nest marks figures shown with their own count
// because not every night has them. extras: the NIGHT_EXTRAS fields to
// include, those some night in the longest window has.
function windowStats(nights, daily, needHours, extras) {
  const s = {};
  const put = (field, values, dp, extra = {}) => {
    const xs = values.filter((v) => v != null);
    s[field] = { v: mean(xs), n: xs.length, dp, ...extra };
  };
  for (const [field, key, div, dp] of NIGHT_MEANS) put(field, nights.map((n) => (n[key] == null ? null : n[key] / div)), dp);

  const staged = nights.filter((n) => n.deepS != null && n.remS != null && n.lightS != null && n.deepS + n.remS + n.lightS > 0);
  const stagedTotal = staged.reduce((a, n) => a + n.deepS + n.remS + n.lightS, 0);
  for (const [field, key] of STAGES) {
    s[field] = { v: staged.length ? (staged.reduce((a, n) => a + n[key], 0) / stagedTotal) * 100 : null, n: staged.length, dp: 1 };
  }

  const asleep = nights.map((n) => n.asleepS).filter((v) => v != null);
  s.shortestAsleepMin = { v: asleep.length ? Math.min(...asleep) / 60 : null, n: asleep.length, dp: 0, noChange: true };
  s.longestAsleepMin = { v: asleep.length ? Math.max(...asleep) / 60 : null, n: asleep.length, dp: 0, noChange: true };
  s.nightsBelowNeed = { v: needHours != null ? asleep.filter((v) => v < needHours * 3600).length : null, n: asleep.length, dp: 0, noChange: true };

  const bed = clockStats(nights.map((n) => clockMinutes(n.bedtime)));
  const wake = clockStats(nights.map((n) => clockMinutes(n.wakeTime)));
  const mid = clockStats(nights.map((n) => clockMinutes(midpoint(n))));
  s.usualBedtime = { v: bed.median, n: bed.n, clock: true };
  s.usualWake = { v: wake.median, n: wake.n, clock: true };
  s.usualMidpoint = { v: mid.median, n: mid.n, clock: true };
  s.bedtimeSpreadMin = { v: bed.iqr, n: bed.n, dp: 0 };
  s.wakeSpreadMin = { v: wake.iqr, n: wake.n, dp: 0 };

  for (const [, field, dp] of NIGHT_EXTRAS) {
    if (extras.has(field)) put(field, nights.map((n) => n[field]), dp, { nest: 'nights' });
  }
  put('hrvMs', daily.hrv, 1, { nest: 'days' });
  put('restingHrBpm', daily.rhr, 1, { nest: 'days' });
  return s;
}

function formatWindow(s) {
  const out = {};
  for (const [field, f] of Object.entries(s)) {
    if (f.nest) out[field] = { mean: round(f.v, f.dp), [f.nest]: f.n };
    else if (f.clock) out[field] = clockLabel(f.v);
    else out[field] = round(f.v, f.dp);
  }
  return out;
}

// The shorter window minus the longer, field by field. A comparison needs
// the longer window to hold at least twice the nights of the shorter one:
// otherwise the two cover mostly the same nights (as with a figure that only
// began syncing recently) and the difference says nothing.
function windowChange(short, long) {
  const out = {};
  for (const [field, a] of Object.entries(short)) {
    const b = long[field];
    if (a.noChange) continue;
    const ok = a.v != null && b.v != null && b.n >= 2 * a.n;
    if (a.clock) out[`${field}Min`] = ok ? Math.round(a.v - b.v) : null;
    else out[field] = ok ? round(a.v - b.v, a.dp) : null;
  }
  return out;
}

function summarizeNeed(need, mctq) {
  const p = mctq?.profile;
  if (!need && !p) return null;
  const c = mctq?.latestCalculation ?? {};
  const clock = (t) => (typeof t === 'string' ? t.slice(0, 5) : null);
  return {
    baselineHours: num(need?.baseline_need ?? p?.baselineSleepNeed),
    todayHours: num(need?.total_need),
    debtAdditionHours: num(need?.debt_addition),
    strainAdditionHours: num(need?.strain_addition),
    napSubtractionHours: num(need?.nap_subtraction),
    method: need?.method ?? p?.method ?? null,
    confidence: need?.confidence ?? p?.confidence ?? null,
    calculatedAt: p?.lastCalculated ? localTimestamp(p.lastCalculated) : null,
    basedOnNights: p?.basedOnDays ?? null,
    workdaySleepHours: num(p?.sdWorkday),
    freedaySleepHours: num(p?.sdFreeday),
    socialJetlagHours: num(p?.socialJetlag),
    workdayMidSleep: clock(c.mid_sleep_workday),
    freedayMidSleep: clock(c.mid_sleep_freeday),
  };
}

function summarizeDebt(d) {
  if (!d || d.currentDebt == null) return null;
  return {
    hours: num(d.currentDebt),
    category: d.debtCategory ?? null,
    trend: d.trend?.direction ?? null,
    change7dHours: num(d.trend?.change7d),
    paybackNights: num(d.paybackTime),
  };
}

function summarizeChronotype(c) {
  if (!c?.success) return null;
  return {
    type: c.chronotype ?? null,
    usualSleep: c.averageSleepTime ?? null,
    usualWake: c.averageWakeTime ?? null,
    circadianLow: c.circadianNadir ?? null,
    circadianHigh: c.circadianAcrophase ?? null,
    melatoninWindow: c.melatoninWindowStart ? { from: c.melatoninWindowStart, to: c.melatoninWindowEnd ?? null } : null,
    nights: c.basedOnDays ?? null,
    confidence: c.confidence ?? null,
  };
}

const WINDOWS = [7, 28, 84];

// Daily values by date from a custom-measurement range (rows use "date").
async function dailyByDate(category, days) {
  const map = new Map();
  for (const e of await getCustomMeasurementRange(category, days)) {
    const v = num(e.value);
    if (v != null && e.date) map.set(e.date, v);
  }
  return map;
}

export function registerSleepTools(server) {
  server.registerTool(
    'get_sleep_trend',
    {
      title: 'Get sleep trend',
      description:
        "Nightly sleep from SparkyFitness, dated by the wake day: duration, score, efficiency, bed and wake times, stage minutes, and overnight HRV (mean over the night) where synced. Absent means not recorded.",
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Days back (default 14).') },
    },
    async ({ days }) => {
      const window = days ?? 14;
      // Averaged from raw seconds (rounded once at the end), not from the
      // already-per-day-rounded asleepMin — summing pre-rounded minutes and
      // rounding again would compound rounding error across the window.
      const nights = await fetchNights(window);
      const asleep = nights.map((n) => n.asleepS).filter((v) => v != null);
      const scored = nights.map((n) => n.score).filter((v) => v != null);
      return asJson({
        windowDays: window,
        entryCount: nights.length,
        avgAsleepMin: asleep.length ? Math.round(mean(asleep) / 60) : null,
        avgSleepScore: scored.length ? round(mean(scored), 1) : null,
        entries: nights.map(summarizeNight),
      });
    }
  );

  server.registerTool(
    'get_sleep_rollup',
    {
      title: 'Get sleep rollup',
      description:
        "Sleep over the last 7, 28 and 84 nights, ending last night: means of each nightly figure, stage shares of time asleep, median bed, wake and mid-sleep times with their spread (interquartile range, min). change: shorter window minus longer, null unless the longer has twice the nights. hrvMs and restingHrBpm are daily; overnightHrvMs is the night's own. need, debt (negative: surplus) and chronotype are SparkyFitness's; need.calculatedAt null: its default need.",
      inputSchema: {},
    },
    async () => {
      const longest = WINDOWS[WINDOWS.length - 1];
      const science = (name) => getSleepScience(name).catch(() => null);
      const [nights, hrv, rhr, debt, need, mctq, chronotype] = await Promise.all([
        fetchNights(longest),
        dailyByDate('HRV_SDNN_avg', longest),
        dailyByDate('resting_heart_rate', longest),
        science('sleep-debt'),
        science('daily-need'),
        science('mctq-stats'),
        science('chronotype'),
      ]);
      const needSummary = summarizeNeed(need, mctq);
      // Overnight HRV (Apple Health's) always appears; other sources'
      // figures only once some night has them.
      const extras = new Set(['overnightHrvMs']);
      for (const [, field] of NIGHT_EXTRAS) if (nights.some((n) => n[field] != null)) extras.add(field);
      const today = localIsoDate();
      const stats = {};
      const windows = {};
      for (const w of WINDOWS) {
        const from = daysAgoIsoDate(w - 1);
        const inWindow = (date) => date >= from && date <= today;
        const daily = {
          hrv: [...hrv].filter(([d]) => inWindow(d)).map(([, v]) => v),
          rhr: [...rhr].filter(([d]) => inWindow(d)).map(([, v]) => v),
        };
        const ns = nights.filter((n) => inWindow(n.date));
        stats[w] = windowStats(ns, daily, needSummary?.baselineHours, extras);
        windows[w] = { from, to: today, nights: ns.length, ...formatWindow(stats[w]) };
      }
      const change = {};
      for (let i = 0; i < WINDOWS.length - 1; i++) {
        change[`${WINDOWS[i]}vs${WINDOWS[i + 1]}`] = windowChange(stats[WINDOWS[i]], stats[WINDOWS[i + 1]]);
      }
      return asJson({
        today,
        need: needSummary,
        debt: summarizeDebt(debt),
        chronotype: summarizeChronotype(chronotype),
        windows,
        change,
      });
    }
  );
}
