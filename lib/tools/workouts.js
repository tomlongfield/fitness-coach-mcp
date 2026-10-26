import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { EXIDX } from '../vendor/opengym/exercises.js';
import { asJson } from './shared.js';
import { localTimestamp } from '../date-utils.js';
import { fetchWatchStrengthMinutes } from './activity.js';
import {
  isWarmupRow,
  isSideSet,
  completedVolumeOf,
  setType,
  dropsOf,
  clustersOf,
  isFailureSet,
} from '../vendor/opengym/workout-model.js';
import { entryExcluded, workoutVolume } from '../vendor/opengym/history.js';
import { bestSetOf, formulaOf, FORMULA_NAMES } from '../vendor/opengym/onerm.js';
import { entryDbLoad } from '../vendor/opengym/dumbbells.js';
import { hasIncline } from '../vendor/opengym/incline.js';
import { sanitizeHr } from '../vendor/opengym/heart-rate.js';
import { cleanBackups } from '../vendor/opengym/routine-backups.js';
import { exerciseOf } from '../opengym-logic.js';

function workoutTimestamp(w) {
  // Prefer the numeric ms timestamp; fall back to the ISO day string.
  if (typeof w.start === 'number') return w.start;
  if (typeof w.d === 'string') return Date.parse(w.d);
  return 0;
}

// state.customEx covers exercises you've created yourself; openGym's own
// catalogue (vendored, ../vendor/opengym/exercises-data.js) covers the rest
// — the API never exposes the built-in library, so without it most
// exerciseIds would come back unresolved. customEx wins on an id collision,
// since it reflects the actual account.
export function buildExerciseIndex(state) {
  const map = new Map(Object.entries(EXIDX).map(([id, info]) => [id, info.n]));
  for (const ex of state.customEx || []) {
    if (ex && ex.id) map.set(ex.id, ex.n);
  }
  return map;
}

// Same id -> value lookup as buildExerciseIndex, but for body part ('bp')
// instead of name — lets a caller classify an exercise (e.g. cardio vs.
// lift) structurally instead of matching against a name that a custom
// exercise can rename out from under it.
export function buildExerciseBpIndex(state) {
  const map = new Map(Object.entries(EXIDX).map(([id, info]) => [id, info.bp]));
  for (const ex of state.customEx || []) {
    if (ex && ex.id) map.set(ex.id, ex.bp);
  }
  return map;
}

// A row's completed work sets as plain {w, r, rpe}, warm-ups dropped
// (openGym marks them `phase: 'warmup'`, or the legacy `warmup: true`). A
// per-side row (unilateral work, `sides: {L, R}`) counts as its weaker side:
// the lighter limb, or at the same weight the one with fewer reps, and only
// once both sides are ticked, with the row's RPE (logged on the row, not
// per side). Reading the row whole would be wrong anyway:
// its scalar `r` is L.r + R.r and its `w` the heavier side, a "set" nobody
// performed (8 reps per side read as 16).
const isBetterSet = (a, b) => a.w > b.w || (a.w === b.w && a.r > b.r);
function completedWorkSets(sets) {
  return (sets || [])
    .filter((s) => s && !isWarmupRow(s))
    .map((s) => {
      if (!isSideSet(s)) return s.done ? s : null;
      const { L, R } = s.sides;
      if (!L.done || !R.done) return null;
      const weaker = isBetterSet(L, R) ? R : L;
      return { ...weaker, rpe: weaker.rpe ?? s.rpe };
    })
    .filter((s) => s && s.w != null && s.r != null);
}

// Heaviest completed work set, ties broken by higher reps, then by the
// higher RPE: of several identical top sets (3 × 45 × 10 at 8.5, 9, 9.5)
// it's the hardest that says whether the weight is ready to go up. A
// unilateral set is read as its weaker side, above. Shared by get_recent_workouts'
// per-exercise topWeight, get_exercise_history's and
// get_lift_progression_summary's occurrence top set, and get_weekly_rollup's
// lifts, so all derive it the same way, rather than one trusting openGym's
// own entry.topW — confirmed against openGym's frontend source (sheets.jsx's
// TopWeight sheet) that this is a semi-manual "confirmed weight" a user
// types into a post-set dialog (pre-filled from either today's actual max or
// their all-time best), not a pure derivation from the logged sets, and can
// silently diverge from them. Warm-ups are skipped: a heavy ramp single
// isn't the session's top set.
export function topSetOf(sets) {
  const weighted = completedWorkSets(sets);
  const harder = (a, b) => !isBetterSet(b, a) && (a.rpe ?? -1) > (b.rpe ?? -1);
  return weighted.length ? weighted.reduce((best, s) => (isBetterSet(s, best) || harder(s, best) ? s : best)) : null;
}

// Work-set volume via openGym's own completedVolumeOf, so it matches the
// app's Stats screen: warm-ups excluded, a drop set's drops added on top of
// its main set, a rest-pause row's clusters NOT added (its `r` already is
// their total), and a per-side row summed limb by limb.
function workVolumeOf(sets) {
  return (sets || []).filter((s) => s && !isWarmupRow(s)).reduce((sum, s) => sum + completedVolumeOf(s), 0);
}

// One exercise's occurrence within a single workout — shared by
// get_exercise_history and the PR-object enrichment below, since both need
// the same top-set/1RM/volume reconstruction from raw sets.
export function summarizeExerciseOccurrence(w, entry, formula = 'epley') {
  const topSet = topSetOf(entry.sets);
  const e1rm = bestSetOf(entry, formula)?.est ?? null;
  return {
    date: w.d,
    workoutId: w.id,
    topWeight: topSet?.w ?? null,
    topReps: topSet?.r ?? null,
    // RPE logged against that same top set specifically, not the session's
    // max/average RPE — null on any occurrence logged before RPE tracking
    // started for this account, not a real "no effort" reading.
    topSetRpe: topSet?.rpe ?? null,
    // openGym's own per-session estimate (bestSetOf: the best estimate across
    // the session's completed work sets, with the formula picked in its
    // settings — Epley unless changed), so it matches the app's 1RM chart.
    // null where the app gives none: no set within its rep cap (12; 15 for
    // the weighted blend), or an assisted machine.
    estimated1RM: e1rm != null ? Number(e1rm.toFixed(2)) : null,
    volume: workVolumeOf(entry.sets),
    // openGym's "Don't count for progression" (an injury or rehab day),
    // set per exercise or for a whole workout. The app itself leaves these
    // out of progression and its next-session numbers.
    ...(entryExcluded(w, entry) ? { excludedFromProgression: true } : {}),
    ...(entry.note ? { note: entry.note } : {}),
  };
}

// Every occurrence of one exercise across the account's full workout
// history, oldest first — openGym's whole-state model means this is a scan
// of state.workouts, not a separate query.
export function getExerciseOccurrences(state, exerciseId) {
  const occurrences = [];
  for (const w of state.workouts || []) {
    for (const entry of w.entries || []) {
      if (entry.id === exerciseId) occurrences.push(summarizeExerciseOccurrence(w, entry, formulaOf(state)));
    }
  }
  return occurrences.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

// openGym flags PRs itself but only ever exposes bare exercise-ID strings —
// no type, no previous value (confirmed against live data: the raw `prs`
// array on a real workout is just ["0577", "0596", "0241"]). Reconstruct
// what changed by comparing this occurrence against the immediately
// preceding one for the same exercise.
function classifyPr(current, previous) {
  if (!previous) return 'first';
  if (current.topWeight != null && previous.topWeight != null) {
    if (current.topWeight > previous.topWeight) return 'weight';
    if (current.topWeight === previous.topWeight && current.topReps > previous.topReps) return 'reps';
  }
  if (current.volume > previous.volume) return 'volume';
  return 'unknown';
}

// openGym's own PR flag fires when a session's max weight beats
// state.exWeights[exerciseId] — a persistent best-ever cache updated only
// inside its own finish-workout flow, not by comparing against the
// previous occurrence. That cache goes stale for any exercise whose
// history was ever written outside that flow (e.g. a bulk historical
// import via the API) — the account's first natively-logged session for
// such an exercise reads as a "PR" against an empty cache even when
// nothing changed, confirmed live: two exercises' 2026-09-01 PR flags had
// identical weight/reps/volume to three prior sessions each. Silently
// dropped rather than surfaced under another key — this is a known
// artifact of that specific import, not a signal worth preserving.
function summarizePersonalRecords(w, state, exIndex) {
  return (w.prs || [])
    .map((exerciseId) => {
      const occurrences = getExerciseOccurrences(state, exerciseId);
      const idx = occurrences.findIndex((o) => o.workoutId === w.id);
      return {
        exerciseId,
        current: idx >= 0 ? occurrences[idx] : null,
        previous: idx > 0 ? occurrences[idx - 1] : null,
      };
    })
    .filter(({ current, previous }) => {
      if (!current || !previous) return true;
      return !(
        current.topWeight === previous.topWeight &&
        current.topReps === previous.topReps &&
        current.volume === previous.volume
      );
    })
    .map(({ exerciseId, current, previous }) => ({
      exerciseId,
      ...(exIndex.get(exerciseId) ? { exerciseName: exIndex.get(exerciseId) } : {}),
      type: current ? classifyPr(current, previous) : 'unknown',
      ...(previous ? { previous: { weight: previous.topWeight, reps: previous.topReps, volume: previous.volume } } : {}),
      ...(current ? { new: { weight: current.topWeight, reps: current.topReps, volume: current.volume } } : {}),
    }));
}

// One logged set as returned to the caller. Only carries the set-shape
// fields when they say something: `warmup` for a warm-up row, `type` plus
// its drops/clusters for a drop set or rest-pause row (see summarizeExercise
// Occurrence's volume note for how the two differ), and per-limb `sides`
// for unilateral work, whose own weight/reps are only a summary (reps
// summed across both sides, the heavier side's weight). Timed and cardio
// sets carry their own fields instead of weight × reps: seconds held, or
// minutes at a speed (plus a treadmill/stair incline since openGym 1.4).
function summarizeSet(s) {
  const type = setType(s);
  return {
    weight: s.w,
    reps: s.r,
    ...(s.sec > 0 ? { seconds: s.sec } : {}),
    ...(s.min > 0 ? { minutes: s.min } : {}),
    ...(s.speed > 0 ? { speed: s.speed } : {}),
    ...(hasIncline(s) ? { inclinePct: Number(s.incline) } : {}),
    done: s.done,
    ...(isWarmupRow(s) ? { warmup: true } : {}),
    // Marked "taken to failure" in openGym (1.4+): it reads as RIR 0 in the
    // app's effort stats and fatigue map unless an effort was logged too.
    ...(isFailureSet(s) ? { toFailure: true } : {}),
    ...(s.rir != null ? { rir: s.rir } : {}),
    ...(s.rpe != null ? { rpe: s.rpe } : {}),
    // Over the set itself and over the rest after it: measured by openGym's
    // Apple Watch app (1.4.2+), or since 1.4.3 worked out from Apple Health's
    // samples for a set without one (heart-rate.js hrFromSamples). Absent
    // when neither had it; sanitizeHr drops implausible readings the way
    // openGym's own display does.
    ...(sanitizeHr(s.hr) ? { heartRateBpm: sanitizeHr(s.hr) } : {}),
    ...(sanitizeHr(s.restHr) ? { restHeartRateBpm: sanitizeHr(s.restHr) } : {}),
    ...(type === 'dropset' ? { type, drops: dropsOf(s).map((d) => ({ weight: d.w, reps: d.r })) } : {}),
    ...(type === 'restpause' ? { type, clusters: clustersOf(s).map((c) => ({ reps: c.r, restSec: c.restSec })) } : {}),
    ...(isSideSet(s)
      ? {
          sides: Object.fromEntries(
            ['L', 'R'].map((k) => [k, { weight: s.sides[k].w, reps: s.sides[k].r, done: s.sides[k].done }])
          ),
        }
      : {}),
  };
}

// The whole session's heart rate (openGym 1.4.3+), measured by its Apple
// Watch app or read back from Apple Health / Health Connect once "Heart rate
// from your watch" is on, for any watch that saves there. Omitted when
// there's no plausible reading.
const HR_SOURCES = { watch: 'opengym_watch', ah: 'apple_health', hc: 'health_connect' };
function sessionHeartRate(w) {
  const hr = sanitizeHr(w.hr);
  if (!hr) return {};
  return { heartRateBpm: hr, ...(HR_SOURCES[w.hr.src] ? { heartRateSource: HR_SOURCES[w.hr.src] } : {}) };
}

function summarizeWorkout(w, exIndex, { state, watchStrengthDurationMin } = {}) {
  return {
    id: w.id,
    date: w.d,
    name: w.name,
    routineId: w.routineId,
    ...(w.excludeFromProgression ? { excludedFromProgression: true } : {}),
    bodyweight: w.bw,
    // Recomputed with openGym's own workoutVolume rather than read from the
    // stored w.vol: that figure is frozen at save time, and workouts saved
    // before openGym stopped counting warm-ups (and before it counted drop
    // sets and per-side rows limb by limb) keep the inflated number forever.
    totalVolume: workoutVolume(w),
    personalRecords: state ? summarizePersonalRecords(w, state, exIndex) : w.prs || [],
    // Real clock time, not just the date — lets a caller compare against
    // get_activity_sessions (SparkyFitness/Apple Watch) to spot when the two
    // are describing the same real-world gym visit vs. genuinely separate
    // sessions on the same day, without either tool needing to compute that
    // itself.
    ...(w.start ? { startTime: localTimestamp(w.start) } : {}),
    ...(w.end ? { endTime: localTimestamp(w.end) } : {}),
    durationMin: w.start && w.end ? Math.round((w.end - w.start) / 60000) : undefined,
    // From get_activity_sessions' watch data, summed across that day's
    // Strength-category sessions — more accurate than durationMin above,
    // which spans openGym's own start/end and inflates whenever the
    // workout is closed out late (cardio bookends, chatting, etc.).
    ...(watchStrengthDurationMin != null ? { watchStrengthDurationMin } : {}),
    ...sessionHeartRate(w),
    ...(w.note ? { sessionNote: w.note } : {}),
    exercises: (w.entries || []).map((e) => ({
      exerciseId: e.id,
      ...(exIndex.get(e.id) ? { exerciseName: exIndex.get(e.id) } : {}),
      // Derived from this session's own completed sets, not openGym's
      // entry.topW — see topSetOf's note for why that field isn't reliable.
      topWeight: topSetOf(e.sets)?.w ?? null,
      // What a dumbbell/kettlebell weight meant when logged (openGym 1.4+):
      // 'each' = per bell, 'total' = both together. Absent means as typed.
      ...(entryDbLoad(e) !== 'as' ? { dumbbellLoad: entryDbLoad(e) } : {}),
      ...(e.note ? { note: e.note, notePinned: !!e.notePin } : {}),
      ...(entryExcluded(w, e) ? { excludedFromProgression: true } : {}),
      sets: (e.sets || []).map(summarizeSet),
    })),
  };
}

// First openGym workout per calendar date — same-day double sessions are
// rare enough that "first" is an acceptable simplification rather than
// something worth a more elaborate join. Exported for get_activity_sessions'
// (activity.js) server-side join and get_daily_summary's workout lookup.
// What kind of exercise this is, from openGym's catalogue (or the account's
// custom exercise): category (strength, stretching, mobility, cardio, …,
// new in openGym 1.4), equipment and body part. Omitted for an id neither
// knows, rather than the catalogue's "Unknown exercise" placeholder.
function catalogueDetails(id, state) {
  const ex = exerciseOf(id, state);
  if (!ex || ex.missing) return {};
  return {
    ...(ex.cat ? { category: ex.cat } : {}),
    ...(ex.eq ? { equipment: ex.eq } : {}),
    ...(ex.bp ? { bodyPart: ex.bp } : {}),
  };
}

// A routine exercise's planned substitutes (openGym 1.4.2's "backups": up
// to five exercises to do instead when the machine is taken), cleaned the
// way the app stores them and named. Omitted when there are none.
export function backupsOf(entry, nameOf) {
  const ids = cleanBackups(entry.subs, entry.id);
  if (!ids.length) return {};
  return { backups: ids.map((id) => ({ exerciseId: id, ...(nameOf(id) ? { exerciseName: nameOf(id) } : {}) })) };
}

export function buildWorkoutsByDate(state) {
  const map = new Map();
  for (const w of state.workouts || []) {
    if (!map.has(w.d)) map.set(w.d, w);
  }
  return map;
}

export function registerWorkoutTools(server) {
  server.registerTool(
    'get_recent_workouts',
    {
      title: 'Get recent workouts',
      description:
        "openGym workouts, newest first (a PR's volume figures are session totals). topWeight and totalVolume count work sets only (warm-ups out, drop-set drops in). Per-side reps are both sides added (13 a side reads 26); topWeight takes the weaker side once both are ticked. heartRateBpm (workout and set) and restHeartRateBpm: from openGym's watch app or Apple Health; absent is not low. excludedFromProgression: flagged don't-count (injury or rehab). watchStrengthDurationMin: strength time from other watch apps, better than durationMin.",
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('Default 5.') },
    },
    async ({ limit }) => {
      const state = await getState();
      const exIndex = buildExerciseIndex(state);
      const workouts = [...(state.workouts || [])]
        .sort((a, b) => workoutTimestamp(b) - workoutTimestamp(a))
        .slice(0, limit ?? 5);
      const dates = [...new Set(workouts.map((w) => w.d))];
      const watchMinutesByDate = await fetchWatchStrengthMinutes(dates);
      const summarized = workouts.map((w) =>
        summarizeWorkout(w, exIndex, { state, watchStrengthDurationMin: watchMinutesByDate.get(w.d) })
      );
      return asJson(summarized);
    }
  );

  server.registerTool(
    'get_exercise_history',
    {
      title: 'Get exercise history',
      description:
        "One exercise's sessions, oldest first: top set (the hardest if tied), estimated1RM (openGym's; null above 12 reps) and volume, from work sets only. A per-side top set is its weaker side, reps per side. estimated1RM is an index: read its direction, not its value. excludedFromProgression: flagged don't-count (injury or rehab).",
      inputSchema: {
        exerciseId: z.string().describe('From get_recent_workouts or get_current_routines.'),
        limit: z.number().int().min(1).max(100).optional().describe('Most recent sessions (default 20).'),
      },
    },
    async ({ exerciseId, limit }) => {
      const state = await getState();
      const exIndex = buildExerciseIndex(state);
      const occurrences = getExerciseOccurrences(state, exerciseId);
      if (!occurrences.length && exerciseOf(exerciseId, state).missing) {
        throw new Error(
          `No exercise with id ${JSON.stringify(exerciseId)} in openGym's catalogue or this account's custom exercises. ` +
          'Take the id from get_current_routines or get_recent_workouts.'
        );
      }
      const trimmed = occurrences.slice(-(limit ?? 20));
      return asJson({
        exerciseId,
        ...(exIndex.get(exerciseId) ? { exerciseName: exIndex.get(exerciseId) } : {}),
        estimated1RMNote: `${FORMULA_NAMES[formulaOf(state)] || 'Weighted blend'} estimate from logged weight × reps (the formula selected in openGym's settings), not a measured 1RM — a derived index for tracking direction across occurrences, not an absolute figure to act on alone. null above openGym's rep cap, where it gives no estimate either.`,
        occurrenceCount: trimmed.length,
        occurrences: trimmed,
      });
    }
  );

  server.registerTool(
    'get_current_routines',
    {
      title: 'Get current routines',
      description:
        "openGym routines as configured, not history. repsMin–reps is a double-progression range; pyramid is reps per set (\"max\" = as many as possible); sg is the superset group; side: unilateral, reps both sides added; backups: planned substitutes. Opening weights: preview_next_session.",
      inputSchema: {},
    },
    async () => {
      const state = await getState();
      const exIndex = buildExerciseIndex(state);
      const routines = (state.routines || []).map((r) => ({
        id: r.id,
        name: r.name,
        emoji: r.emoji,
        exercises: (r.ex || []).map((e) => ({
          // openGym's sync bookkeeping (_ts, _f: per-field change stamps
          // since v1.3.10) isn't program structure — dropped. subs is
          // replaced by backups below, with names.
          ...Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_') && k !== 'subs')),
          ...(exIndex.get(e.id) ? { exerciseName: exIndex.get(e.id) } : {}),
          ...catalogueDetails(e.id, state),
          ...backupsOf(e, (id) => exIndex.get(id)),
        })),
      }));
      return asJson(routines);
    }
  );
}
