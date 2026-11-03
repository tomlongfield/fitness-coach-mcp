// Structural balance on a plan that does none of the template's lifts: a
// short answer, not a row per role saying no-data. It comes back in full as
// soon as one of them is logged.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, fixtureState } from './helpers.js';

const state = fixtureState();
let h;
before(async () => { h = await startHarness({ state }); });
after(async () => { await h.close(); });

test('with none of the lifts logged, the answer says so and names them', async () => {
  const balance = await h.callJson('get_structural_balance');
  assert.equal(balance.template, 'Poliquin');
  assert.equal(balance.noData, true);
  assert.equal(balance.roles, undefined);
  assert.ok(balance.lifts.includes('barbell close-grip bench press'));
  assert.equal(new Set(balance.lifts).size, balance.lifts.length, 'each lift once');
});

test('one logged lift brings the full check back', async (t) => {
  state.workouts.push({
    id: 'w-bench', d: new Date().toISOString().slice(0, 10), name: 'Upper A', routineId: 'r1', start: Date.now() - 600e3, end: Date.now(),
    entries: [{ id: '0030', sets: [{ w: 60, r: 5, done: true }] }],
  });
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 61e3 });   // past the state cache
  const balance = await h.callJson('get_structural_balance');
  assert.equal(balance.noData, undefined);
  const anchor = balance.roles.find((r) => r.exerciseId === '0030');
  assert.equal(anchor.basedOn.weight, 60);
});
