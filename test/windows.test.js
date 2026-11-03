// One rule for `days`: the N dates ending today, in every tool. SparkyFitness's
// range endpoints include both ends, so a range fetched for N days starts N-1
// days back.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, fixtureState } from './helpers.js';

const DAY = 86400e3;
const daysAgo = (n) => new Date(Date.now() - n * DAY).toISOString().slice(0, 10);

// Where each range request started, by endpoint.
const starts = {};
const record = (key, pick) => (url) => {
  starts[key] = pick(url);
  return [];
};
const routes = {
  '/sparky/measurements/custom-categories': [{ id: 'c-rhr', name: 'resting_heart_rate' }],
  '/sparky/measurements/check-in-measurements-range/': record('checkIns', (u) => u.pathname.split('/').at(-2)),
  '/sparky/measurements/custom-measurements-range/': record('custom', (u) => u.pathname.split('/').at(-2)),
  '/sparky/sleep/analytics': record('sleepAnalytics', (u) => u.searchParams.get('startDate')),
  '/sparky/sleep': record('sleep', (u) => u.searchParams.get('startDate')),
  // Every day has food logged, so every finished day counts.
  '/sparky/daily-summary': () => ({ foodEntries: [{ calories: 2000 }], waterIntake: 0, goals: {} }),
};

function state() {
  const s = fixtureState();
  const lift = (id, n) => ({ id: `w${n}`, d: daysAgo(n), name: 'Upper A', routineId: 'r1', start: Date.now() - n * DAY, end: Date.now() - n * DAY + 1800e3,
    entries: [{ id, sets: [{ w: 20, r: 10, done: true }] }] });
  s.workouts.push(lift('0294', 7), lift('0334', 6));
  return s;
}

let h;
before(async () => { h = await startHarness({ state: state(), routes }); });
after(async () => { await h.close(); });

test('get_bodyweight_trend days=7 covers the 7 dates ending today', async () => {
  await h.callJson('get_bodyweight_trend', { days: 7 });
  assert.equal(starts.checkIns, daysAgo(6));
});

test('get_vitals_trend days=7 covers the 7 dates ending today', async () => {
  await h.callJson('get_vitals_trend', { days: 7 });
  assert.equal(starts.custom, daysAgo(6));
});

test('get_sleep_trend days=7 covers the 7 nights ending today', async () => {
  await h.callJson('get_sleep_trend', { days: 7 });
  assert.equal(starts.sleepAnalytics, daysAgo(6));
  assert.equal(starts.sleep, daysAgo(6));
});

test('get_lift_progression_summary days=7 leaves out a lift trained 7 days ago', async () => {
  const summary = await h.callJson('get_lift_progression_summary', { days: 7 });
  const ids = JSON.stringify(summary);
  assert.ok(ids.includes('"0334"'), 'six days ago is in');
  assert.ok(!ids.includes('"0294"'), 'seven days ago is out');
});

test('get_sleep_rollup still reaches back 84 nights', async () => {
  await h.callJson('get_sleep_rollup');
  assert.equal(starts.sleepAnalytics, daysAgo(83));
});

test("get_weekly_rollup still fetches weight from five weeks before its oldest week's Monday", async () => {
  await h.callJson('get_weekly_rollup', { weeks: 4 });
  const today = new Date(`${daysAgo(0)}T12:00:00Z`);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY);
  const oldestMonday = new Date(monday.getTime() - 21 * DAY);
  // Its previous week's mean (7 days) and its 28-day slope.
  assert.equal(starts.checkIns, new Date(oldestMonday.getTime() - 35 * DAY).toISOString().slice(0, 10));
});

test('get_nutrition_trend counts the days in its averages: finished and logged', async () => {
  const trend = await h.callJson('get_nutrition_trend', { days: 7 });
  assert.equal(trend.entryCount, 7);
  assert.equal(trend.averagedDayCount, 6, 'today is partial');
  assert.equal(trend.loggedDayCount, undefined);
});
