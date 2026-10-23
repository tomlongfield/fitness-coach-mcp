import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';
import { asJson, MAX_RESULT_CHARS } from '../lib/tools/shared.js';

let h;
before(async () => { h = await startHarness(); });
after(async () => { await h.close(); });

// Every tool takes these inputs and must answer without an error.
const SMOKE = {
  get_recent_workouts: {},
  get_exercise_history: { exerciseId: '0577' },
  get_current_routines: {},
  get_activity_sessions: {},
  get_bodyweight_trend: {},
  get_vitals_trend: {},
  get_nutrition_day: {},
  get_nutrition_trend: {},
  get_sleep_trend: {},
  get_daily_summary: {},
  get_lift_progression_summary: {},
  get_weekly_rollup: {},
  get_weekly_schedule: {},
  preview_next_session: { routineId: 'r1' },
  get_muscle_recovery: {},
  get_muscle_volume: {},
  get_structural_balance: {},
  get_workout_photos: {},
};

test('the server advertises exactly the tools the smoke test covers', async () => {
  const { tools } = await h.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(SMOKE).sort());
});

test('every tool is marked read-only and has a title', async () => {
  const { tools } = await h.client.listTools();
  for (const t of tools) {
    assert.ok(t.title, `${t.name} has no title`);
    assert.deepEqual(t.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }, t.name);
  }
});

test('the server sends instructions', () => {
  assert.match(h.client.getInstructions() ?? '', /work sets only/);
});

// Tool definitions ride along in every conversation with the connector on.
// Measured as what the model is given: name, description and input schema
// (titles and annotations are for the client). The budget, 10,000
// characters, is the user's, set in October 2026, with the shared rules
// kept in each description because claude.ai skips server instructions.
// Going over means trimming elsewhere, or the user agreeing to a bigger
// budget: never raise it in the change that needs it.
test('tool definitions stay within their context budget', async () => {
  const { tools } = await h.client.listTools();
  const chars = JSON.stringify(tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))).length;
  assert.ok(chars < 10_000, `tool definitions are ${chars} characters`);
});

for (const [name, args] of Object.entries(SMOKE)) {
  test(`${name} answers`, async () => {
    const r = await h.call(name, args);
    assert.ok(!r.isError, r.content?.[0]?.text);
  });
}

test('results are compact JSON', async () => {
  const r = await h.call('get_current_routines');
  assert.ok(!r.content[0].text.includes('\n'));
});

test('a result over the size limit is refused with a way forward', () => {
  assert.throws(() => asJson({ x: 'a'.repeat(MAX_RESULT_CHARS) }), /Ask for less/);
  assert.equal(asJson({ x: 1 }).content[0].text, '{"x":1}');
});

test('watch heart rate is passed through per set, and only when it is a reading', async () => {
  const [w] = await h.callJson('get_recent_workouts', { limit: 1 });
  const [curl, deadBug] = w.exercises;
  assert.deepEqual(curl.sets[0].heartRateBpm, { avg: 118, max: 131 });
  assert.deepEqual(curl.sets[0].restHeartRateBpm, { avg: 102, max: 120 });
  assert.equal(curl.sets[1].heartRateBpm, undefined, 'a phone tick has no heart rate');
  assert.equal(curl.sets[2].heartRateBpm, undefined, 'max below avg is not a reading');
  assert.deepEqual(deadBug.sets[0].heartRateBpm, { avg: 96, max: 104 });
});

test('routine backups come back named, without duplicates or the exercise itself', async () => {
  const expected = [
    { exerciseId: '0596', exerciseName: 'lever seated fly' },
    { exerciseId: '0294', exerciseName: 'dumbbell biceps curl' },
    { exerciseId: 'nope-unknown' },
  ];
  const [routine] = await h.callJson('get_current_routines');
  assert.deepEqual(routine.exercises[0].backups, expected);
  assert.equal(routine.exercises[0].subs, undefined);
  assert.equal(routine.exercises[0]._ts, undefined);
  assert.equal(routine.exercises[1].backups, undefined);
  const preview = await h.callJson('preview_next_session', { routineId: 'r1' });
  assert.deepEqual(preview.exercises[0].backups, expected);
});

test('photos filed under a day join the timeline, but not a workout\'s own photos', async () => {
  const timeline = JSON.parse((await h.call('get_workout_photos', { limit: 10 })).content[0].text);
  assert.equal(timeline.count, 2);
  assert.deepEqual(timeline.photos.map((p) => [p.date, p.workoutId ?? null]), [['2026-10-20', null], [timeline.photos[1].date, 'watch-ABC']]);
  const one = JSON.parse((await h.call('get_workout_photos', { workoutId: 'watch-ABC' })).content[0].text);
  assert.equal(one.count, 1);
});

test('an unknown exercise id is an error that says where ids come from', async () => {
  const r = await h.call('get_exercise_history', { exerciseId: 'no-such-exercise' });
  assert.ok(r.isError);
  assert.match(r.content[0].text, /get_current_routines/);
  const known = await h.callJson('get_exercise_history', { exerciseId: '0596' });
  assert.equal(known.occurrenceCount, 0, 'a catalogue exercise never logged is simply empty');
});

test('openGym\'s own copy of a workout in Apple Health is marked, and not counted as watch strength time', async () => {
  const { entries } = await h.callJson('get_activity_sessions', { days: 1 });
  assert.deepEqual(entries.map((e) => [e.durationMin, e.openGymCopy ?? false]), [[25, false], [30, true]]);
  const [w] = await h.callJson('get_recent_workouts', { limit: 1 });
  assert.equal(w.watchStrengthDurationMin, 25);
});

test('SparkyFitness reads within a minute are shared, not repeated', async () => {
  const path = '/sparky/exercise-entries/by-date';
  await h.call('get_activity_sessions', { days: 3 });
  const first = h.hits.get(path);
  await h.call('get_activity_sessions', { days: 3 });
  assert.equal(h.hits.get(path), first);
});

test('a SparkyFitness 500 is retried, so a brief overload does not fail the call', async () => {
  const path = '/sparky/sleep/analytics';
  const before = h.hits.get(path) || 0;
  h.failNext.set(path, 2);
  const r = await h.call('get_sleep_trend', { days: 9 });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(h.hits.get(path) - before, 3);
});

test('a SparkyFitness 500 that persists is still an error, after two retries', async () => {
  const path = '/sparky/sleep/analytics';
  const before = h.hits.get(path) || 0;
  h.failNext.set(path, 10);
  const r = await h.call('get_sleep_trend', { days: 11 });
  h.failNext.delete(path);
  assert.ok(r.isError);
  assert.match(r.content[0].text, /500/);
  assert.equal(h.hits.get(path) - before, 3);
});
