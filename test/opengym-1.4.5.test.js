// What openGym 1.4.5 changes in the tools: the shoulder as three heads and the
// lats apart from the upper back, statistics that leave out what was kept out
// of progression (a deload routine's work still counts), sport loading the
// recovery map, deload weeks without a programme, session targets, and the
// new set shapes (distance, resistance level, bands, cluster sets).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, fixtureState } from './helpers.js';
import { weekKey, weekStartOf } from '../lib/vendor/opengym/format.js';

const DAY = 86400e3;
const isoDaysFromNow = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const sets = (n, w, r) => Array.from({ length: n }, () => ({ w, r, done: true }));

function state() {
  const s = fixtureState();
  const today = s.workouts[0];
  const t0 = today.start;
  const yesterday = isoDaysFromNow(-1);
  // New set shapes in today's workout.
  today.entries[0].sets.push({ type: 'restpause', cluster: true, w: 30, r: 9, done: true,
    clusters: [{ r: 3, restSec: 20 }, { r: 3, restSec: 20 }, { r: 3 }] });
  today.entries.push(
    { id: '2133', sets: [{ m: 40, w: 32, done: true }] },                        // a carry, by distance
    { id: '0798', sets: [{ min: 20, km: 6, speed: 18, level: 8, done: true }] },  // a bike, by distance
    { id: '0294', sets: [{ w: 0, r: 15, bands: ['b-red', 'b-yellow'], done: true }] },
  );
  s.bands = [
    { id: 'b-yellow', name: 'Yellow', color: '#f2c94c', kg: 5 },
    { id: 'b-red', name: 'Red', color: '#eb5757', kg: 10 },
  ];
  s.routines.push({ id: 'r-deload', name: 'Deload legs', excludeFromProgression: true,
    ex: [{ id: '0586', sets: 3, mode: 'reps', reps: 10, weight: 40 }] });
  s.customEx = [{ id: 'c-press', n: 'Odd press', custom: true, bp: 'shoulders', tg: 'shoulders' }];
  s.workouts.unshift(
    // Squats kept out of progression: out of the statistics too.
    { id: 'w-out', d: yesterday, name: 'Legs', start: t0 - DAY, end: t0 - DAY + 1800e3,
      entries: [{ id: '0043', noProg: true, sets: sets(3, 100, 5) }] },
    // A deload routine stamps noProg on every exercise, and its work still counts.
    { id: 'w-deload', d: yesterday, name: 'Deload legs', routineId: 'r-deload', start: t0 - DAY + 3600e3, end: t0 - DAY + 5400e3,
      entries: [{ id: '0586', rid: 'r-deload', noProg: true, sets: sets(3, 40, 10) }] },
    // A custom exercise tagged plain "shoulders" from before the split.
    { id: 'w-press', d: isoDaysFromNow(-2), name: 'Odd', start: t0 - 2 * DAY, end: t0 - 2 * DAY + 1800e3,
      entries: [{ id: 'c-press', sets: sets(2, 20, 10) }] },
  );
  s.activities = { a1: { d: yesterday, sport: 'run', min: 60, src: 'manual', _ts: 1 } };
  // This week made a deload by hand, no programme running.
  s.deloadCycle = { extra: [weekKey(isoDaysFromNow(0), weekStartOf(s))] };
  s.week = { [new Date().getUTCDay()]: ['r1'] };
  s.sessionTargets = { t1: { rid: 'r2', d: isoDaysFromNow(0), unit: 'kg', by: 'Coach Ana', _ts: 1,
    ex: [{ id: '0577', rows: [{ w: 20, r: 10, warmup: true }, { w: 32.5, r: 8 }, { w: 32.5, r: 8 }] }] } };
  return s;
}

let h;
before(async () => { h = await startHarness({ state: state() }); });
after(async () => { await h.close(); });

const bySlug = (rows) => Object.fromEntries(rows.map((r) => [r.slug, r]));

test('the shoulder is three heads and the lats their own muscle', async () => {
  const { muscles } = await h.callJson('get_muscle_recovery');
  const slugs = muscles.map((m) => m.slug);
  for (const m of ['front-delts', 'side-delts', 'rear-delts', 'lats', 'upper-back']) assert.ok(slugs.includes(m), m);
  assert.ok(!slugs.includes('deltoids'));
  assert.equal(bySlug(muscles)['side-delts'].muscle, 'Side delts');
});

test('a plain "shoulders" exercise counts for all three heads, the front most', async () => {
  const m = bySlug((await h.callJson('get_muscle_volume', { days: 3 })).muscles);
  const [front, side, rear] = ['front-delts', 'side-delts', 'rear-delts'].map((k) => m[k]?.completedSets);
  assert.ok(rear > 0 && side > rear && front > side, JSON.stringify({ front, side, rear }));
});

test("work kept out of progression is out of the volume, a deload routine's is in", async () => {
  const m = bySlug((await h.callJson('get_muscle_volume', { days: 3 })).muscles);
  // Only the kept-out squats train the adductors here.
  assert.equal(m.adductors, undefined);
  // The deload routine's leg curls (3 sets) on top of the bike's 0.4.
  assert.ok(m.hamstring.completedSets >= 3);
});

test('sport loads the recovery map, and says which', async () => {
  const r = await h.callJson('get_muscle_recovery');
  assert.deepEqual(r.sportThisWeek, [{ date: isoDaysFromNow(-1), sport: 'Run', minutes: 60 }]);
  // The squats were kept out, so the run is all that tired the quads.
  assert.ok(bySlug(r.muscles).quadriceps.fatigue > 0);
});

test('a deload week of your own shows on the schedule', async () => {
  const s = await h.callJson('get_weekly_schedule');
  assert.equal(s.next7Days[0].deload, true);
  assert.equal(s.programme, null);
  assert.equal(s.deloadWeeks.kind, 'added');
});

test('the preview opens a deload week with fewer sets at the same weight', async () => {
  const p = await h.callJson('preview_next_session', { routineId: 'r1' });
  assert.equal(p.deloadWeek, true);
  const [curl] = p.exercises;
  assert.equal(curl.deloadWeek, true);
  assert.equal(curl.programme, undefined);
  assert.equal(curl.prescription.sets, 2);
  assert.equal(curl.weightSource, 'deload_week');
  assert.equal(curl.openingSets.filter((s) => !s.warmup).length, 2);
});

test("a session target sets that day's rows", async () => {
  const [curl] = (await h.callJson('preview_next_session', { routineId: 'r2' })).exercises;
  assert.deepEqual(curl.sessionTarget, { by: 'Coach Ana' });
  assert.equal(curl.weightSource, 'session_target');
  assert.equal(curl.repsSource, 'session_target');
  assert.deepEqual(curl.openingSets.map((s) => !!s.warmup), [true, false, false]);
});

test('distance, resistance level, bands and cluster sets come through', async () => {
  const [w] = await h.callJson('get_recent_workouts', { limit: 1 });
  const ex = Object.fromEntries(w.exercises.map((e) => [e.exerciseId, e]));
  assert.equal(ex['0577'].sets.at(-1).type, 'cluster');
  assert.equal(ex['2133'].sets[0].metres, 40);
  assert.equal(ex['2133'].sets[0].weight, 32);
  assert.equal(ex['0798'].sets[0].distanceKm, 6);
  assert.equal(ex['0798'].sets[0].resistanceLevel, 8);
  assert.equal(ex['0294'].sets[0].bands, 'Red + Yellow');
});
