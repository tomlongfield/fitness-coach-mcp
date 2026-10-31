// Sleep tools against nights shaped like SparkyFitness 1.10's: /sleep/analytics
// (its stagePercentages bug included), /sleep with stages and overnight
// HRV, the sleep-science endpoints, and daily HRV as a custom measurement.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';

const today = new Date().toISOString().slice(0, 10); // tests run in UTC
const day = (n) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86400e3).toISOString().slice(0, 10);

// Nights by how many days ago they ended. Last week: 7 h asleep, bedtimes
// either side of midnight, no night 3 days ago, overnight HRV on the last
// three nights only. The three weeks before: 8 h, in bed at 23:00. One more
// night 60 days ago.
const LAST_WEEK_BEDTIMES = { 0: '23:30', 1: '23:50', 2: '00:10', 4: '00:20', 5: '00:40', 6: '23:40' };
const NIGHTS = [];
for (let n = 0; n < 28; n++) {
  if (n === 3) continue;
  const recent = n < 7;
  NIGHTS.push({
    n,
    bed: recent ? LAST_WEEK_BEDTIMES[n] : '23:00',
    stages: recent ? { deep: 60, rem: 90, light: 270 } : { deep: 80, rem: 100, light: 300 },
    awake: 20,
    score: recent ? 75 : 85,
    hrv: n < 3 ? 70 + n : null,
    rhr: n < 3 ? 60 : null,
  });
}
NIGHTS.push({ n: 60, bed: '23:00', stages: { deep: 50, rem: 60, light: 250 }, awake: 20, score: 70, hrv: null, rhr: null });

const asleepOf = (x) => x.stages.deep + x.stages.rem + x.stages.light;
const bedtimeOf = (x) => `${x.bed >= '18:00' ? day(x.n + 1) : day(x.n)}T${x.bed}:00.000Z`;
const wakeOf = (x) => `${day(x.n)}T07:30:00.000Z`;

const analytics = NIGHTS.map((x) => ({
  date: day(x.n),
  totalSleepDuration: (asleepOf(x) + x.awake) * 60,
  timeAsleep: asleepOf(x) * 60,
  sleepScore: x.score,
  earliestBedtime: bedtimeOf(x),
  latestWakeTime: wakeOf(x),
  sleepEfficiency: (asleepOf(x) / (asleepOf(x) + x.awake)) * 100,
  sleepDebt: 1.5,
  stagePercentages: { deep: 0, rem: 0, light: 0, awake: 0, unspecified: 100 },
  awakePeriods: 2,
  totalAwakeDuration: x.awake * 60,
}));

const entries = [
  ...NIGHTS.map((x) => ({
    entry_date: day(x.n),
    time_asleep_in_seconds: asleepOf(x) * 60,
    deep_sleep_seconds: x.stages.deep * 60,
    rem_sleep_seconds: x.stages.rem * 60,
    light_sleep_seconds: x.stages.light * 60,
    awake_sleep_seconds: x.awake * 60,
    avg_overnight_hrv: x.hrv,
    resting_heart_rate: x.rhr == null ? null : x.rhr - 1e-14, // as stored: 61.99999999999999
    average_spo2_value: null,
    stage_events: [{ stage_type: 'deep', duration_in_seconds: 60 }],
  })),
  // A short second row on last night's date, with no stages: not the night.
  { entry_date: day(1), time_asleep_in_seconds: 1200, deep_sleep_seconds: null, rem_sleep_seconds: null, light_sleep_seconds: null },
];

// Daily HRV for the last 60 days: 60 ms this week, 70 before.
const HRV_DAYS = Array.from({ length: 60 }, (_, n) => ({ date: day(n), value: String(n < 7 ? 60 : 70) }));

const SCIENCE = {
  '/sparky/sleep-science/sleep-debt': { currentDebt: -0.34, debtCategory: 'low', sleepNeed: 7.39, last14Days: [], trend: { direction: 'stable', change7d: -0.13 }, paybackTime: 0 },
  '/sparky/sleep-science/daily-need': { date: today, baseline_need: 7.39, strain_addition: 0, debt_addition: -0.08, nap_subtraction: 0, total_need: 7.31, method: 'mctq_corrected', confidence: 'medium', current_debt_hours: -0.34 },
  '/sparky/sleep-science/mctq-stats': {
    profile: { baselineSleepNeed: 7.39, method: 'mctq_corrected', confidence: 'medium', basedOnDays: 68, lastCalculated: '2026-10-31T19:56:50.981Z', sdWorkday: 7.17, sdFreeday: 6.63, socialJetlag: 0.27 },
    latestCalculation: { mid_sleep_workday: '03:30:00', mid_sleep_freeday: '03:46:00' },
    dayClassifications: [],
  },
  '/sparky/sleep-science/chronotype': { success: true, chronotype: 'intermediate', averageWakeTime: '07:53', averageSleepTime: '00:34', circadianNadir: '05:53', circadianAcrophase: '17:53', melatoninWindowStart: '22:34', melatoninWindowEnd: '00:34', basedOnDays: 31, confidence: 'high' },
};

let h;
before(async () => {
  h = await startHarness({
    routes: {
      '/sparky/sleep/analytics': analytics,
      '/sparky/sleep': entries,
      ...SCIENCE,
      '/sparky/measurements/custom-categories': [{ id: 'c-hrv', name: 'HRV_SDNN_avg' }],
      '/sparky/measurements/custom-measurements-range/c-hrv/': HRV_DAYS,
    },
  });
});
after(async () => { await h.close(); });

test('the sleep trend carries each night\'s stages and overnight HRV, from the night itself', async () => {
  const r = await h.callJson('get_sleep_trend', { days: 3 });
  const last = r.entries.find((e) => e.date === day(0));
  assert.equal(last.deepMin, 60);
  assert.equal(last.remMin, 90);
  assert.equal(last.lightMin, 270);
  assert.equal(last.awakeMin, 20);
  assert.equal(last.overnightHrvMs, 70);
  assert.equal(last.overnightRestingHrBpm, 60);
  assert.equal(last.asleepMin, 420);
  assert.equal(last.bedtime, `${day(0)}T23:30:00+00:00`.replace(day(0), day(1)));
  // The longest row on a date is the night, not a short one beside it.
  assert.equal(r.entries.find((e) => e.date === day(1)).deepMin, 60);
  // Neither the broken stage percentages nor the 8 h-in-bed "debt".
  assert.ok(!('stagePercentages' in last));
  assert.ok(!('sleepDebtHours' in last));
  // Absent, not 0, where the night has no reading.
  const older = (await h.callJson('get_sleep_trend', { days: 14 })).entries.find((e) => e.date === day(10));
  assert.ok(!('overnightHrvMs' in older));
  assert.ok(!('spo2AvgPct' in older));
});

test('the sleep rollup averages each window over the nights it has', async () => {
  const r = await h.callJson('get_sleep_rollup');
  const w7 = r.windows['7'];
  assert.deepEqual([w7.from, w7.to, w7.nights], [day(6), today, 6]);
  assert.equal(w7.asleepMin, 420);
  assert.equal(w7.inBedMin, 440);
  assert.equal(w7.score, 75);
  assert.equal(w7.deepMin, 60);
  assert.equal(w7.deepPct, 14.3);
  assert.equal(w7.remPct, 21.4);
  assert.equal(w7.lightPct, 64.3);
  assert.equal(w7.nightsBelowNeed, 6); // 7 h against a 7.39 h need
  assert.deepEqual(w7.overnightHrvMs, { mean: 71, nights: 3 });
  assert.deepEqual(w7.hrvMs, { mean: 60, days: 7 });
  assert.deepEqual(w7.restingHrBpm, { mean: null, days: 0 });
  assert.ok(!('spo2AvgPct' in w7), 'a figure no night has is left out');

  const w28 = r.windows['28'];
  assert.equal(w28.nights, 27);
  assert.equal(w28.asleepMin, Math.round((6 * 420 + 21 * 480) / 27));
  assert.equal(r.windows['84'].nights, 28);
  assert.equal(r.windows['84'].shortestAsleepMin, 360);
  assert.equal(r.windows['84'].longestAsleepMin, 480);
});

test('usual bed and wake times are medians that cross midnight', async () => {
  const w7 = (await h.callJson('get_sleep_rollup')).windows['7'];
  // 23:30 23:40 23:50 | 00:10 00:20 00:40: the middle falls at midnight.
  assert.equal(w7.usualBedtime, '00:00');
  assert.equal(w7.usualWake, '07:30');
  assert.equal(w7.usualMidpoint, '03:45');
  assert.equal(w7.wakeSpreadMin, 0);
  assert.ok(w7.bedtimeSpreadMin > 0);
});

test('a change is given only when the longer window holds twice the nights', async () => {
  const { change } = await h.callJson('get_sleep_rollup');
  assert.equal(change['7vs28'].asleepMin, Math.round(420 - (6 * 420 + 21 * 480) / 27));
  assert.equal(change['7vs28'].usualWakeMin, 0);
  assert.equal(change['7vs28'].hrvMs, -7.5);
  // Overnight HRV began three nights ago: both windows hold the same nights.
  assert.equal(change['7vs28'].overnightHrvMs, null);
  // 28 nights against 27 is mostly the same nights.
  assert.equal(change['28vs84'].asleepMin, null);
  // Daily HRV: 60 days against 28.
  assert.equal(change['28vs84'].hrvMs, round1(67.5 - (7 * 60 + 53 * 70) / 60));
  assert.ok(!('nightsBelowNeed' in change['7vs28']));
});
const round1 = (n) => Number(n.toFixed(1));

test('sleep need, debt and chronotype are SparkyFitness\'s own', async () => {
  const r = await h.callJson('get_sleep_rollup');
  assert.deepEqual(r.need, {
    baselineHours: 7.39, todayHours: 7.31, debtAdditionHours: -0.08, strainAdditionHours: 0, napSubtractionHours: 0,
    method: 'mctq_corrected', confidence: 'medium', calculatedAt: '2026-10-31T19:56:50+00:00', basedOnNights: 68,
    workdaySleepHours: 7.17, freedaySleepHours: 6.63, socialJetlagHours: 0.27, workdayMidSleep: '03:30', freedayMidSleep: '03:46',
  });
  assert.deepEqual(r.debt, { hours: -0.34, category: 'low', trend: 'stable', change7dHours: -0.13, paybackNights: 0 });
  assert.deepEqual(r.chronotype, {
    type: 'intermediate', usualSleep: '00:34', usualWake: '07:53', circadianLow: '05:53', circadianHigh: '17:53',
    melatoninWindow: { from: '22:34', to: '00:34' }, nights: 31, confidence: 'high',
  });
});

test('the rollup reads each source once, with no request per day', async () => {
  await h.callJson('get_sleep_rollup');
  const sleepPaths = [...h.hits.keys()].filter((p) => p.startsWith('/sparky/sleep'));
  assert.deepEqual(sleepPaths.sort(), ['/sparky/sleep', '/sparky/sleep/analytics', ...Object.keys(SCIENCE)].sort());
});
