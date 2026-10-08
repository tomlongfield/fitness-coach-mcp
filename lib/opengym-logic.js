// Thin glue between openGym's state blob and the training logic vendored
// verbatim from openGym itself under ./vendor/opengym/ (see
// scripts/update-opengym-vendor.mjs). Tools that answer "what does the app
// think" — the schedule, the next session, muscle volume, structural
// balance — call upstream's own functions through here instead of
// re-deriving its rules, so the answers match what the app shows.
import { exOr } from './vendor/opengym/exercises.js';
import { POLICY_NAME } from './vendor/opengym/progression.js';
import { MUSCLE_NAME } from './vendor/opengym/muscles.js';

// Upstream's modules assume a fully-hydrated store (they read S.workouts,
// S.routines etc. without a fallback, e.g. queue.js's isDone). The synced
// blob can omit an empty array, so default the ones they touch.
export function normalizeState(state) {
  return {
    ...state,
    workouts: Array.isArray(state?.workouts) ? state.workouts : [],
    routines: Array.isArray(state?.routines) ? state.routines : [],
    customEx: Array.isArray(state?.customEx) ? state.customEx : [],
    bodyweight: Array.isArray(state?.bodyweight) ? state.bodyweight : [],
    week: state?.week && typeof state.week === 'object' ? state.week : {},
    dayPlan: state?.dayPlan && typeof state.dayPlan === 'object' ? state.dayPlan : {},
    exWeights: state?.exWeights && typeof state.exWeights === 'object' ? state.exWeights : {},
  };
}

// A custom exercise from this account, else upstream's catalogue entry.
// Deliberately not upstream's registerCustom(), which mutates a module-
// global index — fine in the single-user browser, but a stale custom could
// then outlive the state it came from across this server's cache refreshes.
export function customOf(id, state) {
  return (state.customEx || []).find((ex) => ex?.id === id) || null;
}
export function exerciseOf(id, state) {
  return customOf(id, state) || exOr(id);
}

// Upstream's progression helpers return {0}/{1} i18n templates (English
// source strings) plus their arguments, for the UI's t() to fill in.
export function fillTemplate(template, args) {
  let v = String(template);
  (args || []).forEach((a, i) => {
    v = v.replaceAll(`{${i}}`, String(a));
  });
  return v;
}

export const policyName = (policy) => POLICY_NAME[policy] || policy;
export const muscleName = (slug) => MUSCLE_NAME[slug] || slug;

// One-decimal rounding for effective-set counts, which are fractional
// (a secondary muscle gets partial credit per set).
export const round1 = (n) => Math.round((n || 0) * 10) / 10;
