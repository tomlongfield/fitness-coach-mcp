// Exercises logged as a superset carry openGym's group, as planned ones do
// in preview_next_session.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, fixtureState } from './helpers.js';

function state() {
  const s = fixtureState();
  const { entries } = s.workouts[0];
  entries[0].sg = 'sg1';
  entries[1].sg = 'sg1';
  entries.push({ id: '0334', sets: [{ w: 4, r: 12, done: true }] });
  return s;
}

let h;
before(async () => { h = await startHarness({ state: state() }); });
after(async () => { await h.close(); });

test('get_recent_workouts gives a superset its group, and other exercises none', async () => {
  const [w] = await h.callJson('get_recent_workouts', { limit: 1 });
  assert.deepEqual(w.exercises.map((e) => e.supersetGroup), ['sg1', 'sg1', undefined]);
  assert.equal('supersetGroup' in w.exercises[2], false);
});
