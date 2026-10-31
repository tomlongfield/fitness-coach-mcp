// A SparkyFitness without the sleep-science endpoints (before 2026's sleep
// science, or with them failing): the rollup still answers. In its own file
// because the server and its cache are shared within a test process.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness } from './helpers.js';

const SCIENCE = ['sleep-debt', 'daily-need', 'mctq-stats', 'chronotype'];

let h;
before(async () => {
  h = await startHarness({ routes: Object.fromEntries(SCIENCE.map((name) => [`/sparky/sleep-science/${name}`, null])) });
});
after(async () => { await h.close(); });

test('the rollup still answers on a SparkyFitness without sleep science', async () => {
  const r = await h.callJson('get_sleep_rollup');
  assert.equal(r.need, null);
  assert.equal(r.debt, null);
  assert.equal(r.chronotype, null);
  assert.equal(r.windows['7'].nights, 0);
  assert.equal(r.windows['7'].nightsBelowNeed, null);
  assert.equal(r.windows['7'].usualBedtime, null);
  assert.deepEqual(r.windows['7'].overnightHrvMs, { mean: null, nights: 0 });
});
