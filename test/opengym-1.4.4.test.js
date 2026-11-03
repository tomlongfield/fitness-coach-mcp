// What openGym 1.4.4 adds to the tools: set notes, tick times and the
// comparison with last time on each set, time per exercise, merged exercises,
// programmes (a deload week above all) and weekly sets against a target range.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, fixtureState } from './helpers.js';
import { weekKey, MONDAY } from '../lib/vendor/opengym/format.js';

const DAY = 86400e3;
const isoDaysFromNow = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
const curlSets = (w, reps) => reps.map((r) => ({ w, r, done: true }));

function state() {
  const s = fixtureState();
  const today = s.workouts[0];
  const t0 = today.start;
  const [curl, deadBug] = today.entries;
  curl.sets[0].at = t0 + 300e3;
  curl.sets[1].at = t0 + 480e3;
  curl.sets[1].note = '  grip slipped ';
  curl.sets[2].at = t0 + 660e3;
  deadBug.sets[0].at = t0 + 900e3;
  // One side at a time: each side keeps its own tick, and the set as a whole may have none.
  const side = (at) => ({ w: 5, r: 10, done: true, ...(at ? { at } : {}) });
  today.entries.push({ id: '0334', sets: [
    { sides: { L: side(t0 + 1000e3), R: side(t0 + 1060e3) }, w: 5, r: 20, done: true },
    { sides: { L: side(), R: side() }, w: 5, r: 20, done: true, at: t0 + 1200e3 },
    { sides: { L: side(t0 + 1300e3), R: { w: 5, r: 10, done: false, at: t0 + 1400e3 } }, w: 5, r: 10, done: false },
  ] });
  // Eight days ago under an exercise since merged into 0577, seven days ago as 0577 itself.
  s.workouts.unshift(
    { id: 'w-8', d: isoDaysFromNow(-8), name: 'Upper A', routineId: 'r1', start: t0 - 8 * DAY, end: t0 - 8 * DAY + 1800e3,
      entries: [{ id: '0294', sets: curlSets(25, [12, 12, 12]) }] },
    { id: 'w-7', d: isoDaysFromNow(-7), name: 'Upper A', routineId: 'r1', start: t0 - 7 * DAY, end: t0 - 7 * DAY + 1800e3,
      entries: [{ id: '0577', sets: curlSets(30, [12, 12, 12]) }] },
  );
  s.exMerged = { '0294': { into: '0577', _ts: 1 } };
  // A two-week programme started today: an ordinary week, then a deload.
  const weekday = new Date().getUTCDay();
  s.week = { [weekday]: ['r1'] };
  s.programmes = { P: { id: 'P', name: 'Block', at: 1, days: { [weekday]: ['r1'] }, weeks: [{}, { deload: true }] } };
  s.programme = { id: 'P', startedOn: isoDaysFromNow(0), cycle: 1, bump: 0, saved: { week: {}, scheduleMode: null, rotation: null, pass: false } };
  s.muscleTargets = { chest: [12, 22] };
  return s;
}

let h;
before(async () => { h = await startHarness({ state: state() }); });
after(async () => { await h.close(); });

const todaysWorkout = async () => (await h.callJson('get_recent_workouts', { limit: 1 }))[0];

test("a set's own note is passed through, trimmed", async () => {
  const [curl] = (await todaysWorkout()).exercises;
  assert.equal(curl.sets[1].note, 'grip slipped');
  assert.equal(curl.sets[0].note, undefined);
});

test('a set says when it was ticked', async () => {
  const w = await todaysWorkout();
  const [curl] = w.exercises;
  // The harness runs in UTC, so the local timestamp is the UTC one with +00:00.
  assert.equal(curl.sets[0].tickedAt, `${new Date(Date.parse(w.startTime) + 300e3).toISOString().slice(0, 19)}+00:00`);
  assert.equal(w.exercises[0].sets.filter((s) => s.tickedAt).length, 3);
});

test('a set done one side at a time is ticked when its later side was, as openGym times it', async () => {
  const w = await todaysWorkout();
  const raise = w.exercises.find((e) => e.exerciseId === '0334');
  const local = (ms) => `${new Date(Date.parse(w.startTime) + ms).toISOString().slice(0, 19)}+00:00`;
  assert.equal(raise.sets[0].tickedAt, local(1060e3));
  // Sides without their own tick fall back to the set's.
  assert.equal(raise.sets[1].tickedAt, local(1200e3));
  // An undone side's tick doesn't count.
  assert.equal(raise.sets[2].tickedAt, local(1300e3));
});

test('each exercise says how long it took, from its tick times', async () => {
  const [curl, deadBug] = (await todaysWorkout()).exercises;
  assert.equal(curl.timeMin, 11);
  assert.equal(deadBug.timeMin, 4);
});

test("each work set is compared with the same set last time, openGym's way", async () => {
  const [curl] = (await todaysWorkout()).exercises;
  assert.deepEqual(curl.sets[0].vsLast, { dir: 'same', by: 'weight', delta: 0 });
  assert.deepEqual(curl.sets[2].vsLast, { dir: 'down', by: 'reps', delta: -1 });
});

test('an exercise merged into another reads as the one it went into', async () => {
  const history = await h.callJson('get_exercise_history', { exerciseId: '0577' });
  assert.equal(history.occurrenceCount, 3);
});

test("the schedule says which week of a programme it is, and marks a deload week's days", async () => {
  const schedule = await h.callJson('get_weekly_schedule');
  assert.deepEqual(schedule.programme, { name: 'Block', week: 1, weeks: 2, deload: false, paused: false });
  // Week 2, the deload, starts with the profile's next week (Monday by default).
  const thisWeek = weekKey(schedule.today, MONDAY);
  for (const day of schedule.next7Days) {
    assert.equal(day.deload, weekKey(day.date, MONDAY) !== thisWeek ? true : undefined, day.date);
  }
});

test('a deload week opens lighter and says the programme set the weight', async () => {
  const normal = await h.callJson('preview_next_session', { routineId: 'r1' });
  const deload = await h.callJson('preview_next_session', { routineId: 'r1', date: isoDaysFromNow(7) });
  assert.equal(normal.programme, undefined, 'week 1 asks nothing of these exercises');
  assert.deepEqual(deload.programme, { name: 'Block', week: 2, weeks: 2, deload: true });
  const [curl] = deload.exercises;
  assert.ok(curl.prescription.weight < normal.exercises[0].prescription.weight);
  assert.equal(curl.weightSource, 'programme');
  assert.deepEqual(curl.programme, { week: 2, weeks: 2, deload: true });
});

test("this week's sets per muscle come with the profile's target range", async () => {
  const volume = await h.callJson('get_muscle_volume');
  const chest = volume.muscles.find((m) => m.slug === 'chest');
  assert.deepEqual(chest.weeklyTarget, { min: 12, max: 22 });
  assert.equal(chest.targetStatus, chest.completedSets < 12 ? 'below' : chest.completedSets > 22 ? 'above' : 'in');
  const calves = volume.muscles.find((m) => m.slug === 'calves');
  assert.deepEqual(calves.weeklyTarget, { min: 8, max: 16 }, 'a muscle with no sets still has its range');
  const rolling = await h.callJson('get_muscle_volume', { days: 7 });
  assert.equal(rolling.muscles[0].weeklyTarget, undefined, 'a rolling window has no weekly range');
});

test("the week's plan is held against the same range, so midweek isn't all 'below'", async () => {
  const volume = await h.callJson('get_muscle_volume');
  const status = (n, lo, hi) => (n < lo ? 'below' : n > hi ? 'above' : 'in');
  const chest = volume.muscles.find((m) => m.slug === 'chest');
  assert.ok(chest.plannedSets > 0, 'the fixture plans some chest work');
  assert.equal(chest.plannedStatus, status(chest.plannedSets, 12, 22));
  const rolling = await h.callJson('get_muscle_volume', { days: 7 });
  assert.equal(rolling.muscles[0].plannedStatus, undefined);
});
