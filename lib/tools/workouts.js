import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { EXERCISE_LIBRARY } from '../exercise-library.js';
import { asJson } from './shared.js';
import { fetchWatchStrengthMinutes } from './activity.js';
import {
  isWarmupRow,
  isSideSet,
  completedVolumeOf,
  setType,
  dropsOf,
  clustersOf,
} from '../vendor/opengym/workout-model.js';
import { entryExcluded, workoutVolume } from '../vendor/opengym/history.js';

function workoutTimestamp(w) {
  // Prefer the numeric ms timestamp; fall back to the ISO day string.
  if (typeof w.start === 'number') return w.start;
  if (typeof w.d === 'string') return Date.parse(w.d);
  return 0;
}

// state.customEx covers exercises you've created yourself; EXERCISE_LIBRARY
// (a bundled snapshot of openGym's own built-in library, see
// ../exercise-library.js) covers the rest — the API itself never exposes
// the built-in library, so without this, most exerciseIds would come back
// unresolved. customEx is seeded first and wins on any id collision, since
// it reflects your actual account rather than a point-in-time snapshot.
export function buildExerciseIndex(state) {
  const map = new Map(Object.entries(EXERCISE_LIBRARY).map(([id, info]) => [id, info.n]));
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
  const map = new Map(Object.entries(EXERCISE_LIBRARY).map(([id, info]) => [id, info.bp]));
  for (const ex of state.customEx || []) {
    if (ex && ex.id) map.set(ex.id, ex.bp);
  }
  return map;
}

// A row's completed work sets as plain {w, r, rpe} — warm-ups dropped
// (openGym marks them `phase: 'warmup'`, or the legacy `warmup: true`), and
// a per-side row (unilateral work, `sides: {L, R}`) split into its two
// limbs. Splitting matters: the row's own scalar `r` is L.r + R.r and its
// `w` the heavier side, so reading it whole would hand topSetOf a "set"
// nobody performed (8 reps per side read as 16) and inflate estimated1RM.
// A limb counts once its own side is ticked, even if its partner isn't.
function completedWorkSets(sets) {
  return (sets || [])
    .filter((s) => s && !isWarmupRow(s))
    .flatMap((s) => (isSideSet(s) ? [s.sides.L, s.sides.R] : [s]))
    .filter((s) => s.done && s.w != null && s.r != null);
}

// Heaviest completed work set, ties broken by higher reps. Shared by
// get_recent_workouts' per-exercise topWeight and get_exercise_history's
// occurrence topWeight so both derive it the same way, rather than one
// trusting openGym's own entry.topW — confirmed against openGym's frontend
// source (sheets.jsx's TopWeight sheet) that this is a semi-manual
// "confirmed weight" a user types into a post-set dialog (pre-filled from
// either today's actual max or their all-time best), not a pure derivation
// from the logged sets, and can silently diverge from them. Warm-ups are
// skipped: a heavy ramp single isn't the session's top set.
export function topSetOf(sets) {
  const weighted = completedWorkSets(sets);
  return weighted.length
    ? weighted.reduce((best, s) => (s.w > best.w || (s.w === best.w && s.r > best.r) ? s : best))
    : null;
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
export function summarizeExerciseOccurrence(w, entry) {
  const topSet = topSetOf(entry.sets);
  return {
    date: w.d,
    workoutId: w.id,
    topWeight: topSet?.w ?? null,
    topReps: topSet?.r ?? null,
    // RPE logged against that same top set specifically, not the session's
    // max/average RPE — null on any occurrence logged before RPE tracking
    // started for this account, not a real "no effort" reading.
    topSetRpe: topSet?.rpe ?? null,
    // Epley formula, off the heaviest completed set only. Unrounded — this
    // exists purely for cross-occurrence comparison, and rounding to an
    // integer injects up to ~1kg of artificial noise into that comparison
    // for no benefit; round for display, not here.
    estimated1RM: topSet ? Number((topSet.w * (1 + topSet.r / 30)).toFixed(2)) : null,
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
      if (entry.id === exerciseId) occurrences.push(summarizeExerciseOccurrence(w, entry));
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
// summed across both sides, the heavier side's weight).
function summarizeSet(s) {
  const type = setType(s);
  return {
    weight: s.w,
    reps: s.r,
    done: s.done,
    ...(isWarmupRow(s) ? { warmup: true } : {}),
    ...(s.rir != null ? { rir: s.rir } : {}),
    ...(s.rpe != null ? { rpe: s.rpe } : {}),
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
    ...(w.start ? { startTime: new Date(w.start).toISOString() } : {}),
    ...(w.end ? { endTime: new Date(w.end).toISOString() } : {}),
    durationMin: w.start && w.end ? Math.round((w.end - w.start) / 60000) : undefined,
    // From get_activity_sessions' watch data, summed across that day's
    // Strength-category sessions — more accurate than durationMin above,
    // which spans openGym's own start/end and inflates whenever the
    // workout is closed out late (cardio bookends, chatting, etc.).
    ...(watchStrengthDurationMin != null ? { watchStrengthDurationMin } : {}),
    ...(w.note ? { sessionNote: w.note } : {}),
    exercises: (w.entries || []).map((e) => ({
      exerciseId: e.id,
      ...(exIndex.get(e.id) ? { exerciseName: exIndex.get(e.id) } : {}),
      // Derived from this session's own completed sets, not openGym's
      // entry.topW — see topSetOf's note for why that field isn't reliable.
      topWeight: topSetOf(e.sets)?.w ?? null,
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
        'Returns the most recently logged openGym workouts (newest first), including exercises, sets, weights, reps, volume, any PRs hit (with type — weight/reps/volume/first — and the previous value each beat), and any session/exercise notes logged during the workout. Each PR is reconstructed from this exercise\'s own history, not just openGym\'s bare pass/fail flag — entries where nothing actually changed on any axis are dropped (openGym\'s own flag can fire against a stale internal cache with no real change behind it). Sets carry warmup: true for warm-up rows, type (dropset with its drops, restpause with its clusters) for intensifier sets, and sides {L, R} for unilateral sets logged per side; topWeight and volume count work sets only (warm-ups excluded, drops included, per-side sets read limb by limb), matching openGym\'s own Stats. totalVolume is recomputed the same way rather than read from openGym\'s stored figure, which is frozen at save time and over-counts on older workouts. excludedFromProgression marks a workout or exercise the user flagged "Don\'t count for progression" (injury/rehab day). Note a PR\'s "new"/"previous" volume figures are session totals, not tied to the top set that drove weight/reps — a genuine weight PR can still show lower total volume than the prior session if fewer total reps were completed at the heavier load, that\'s correct, not a bug. exercises[].topWeight is derived from that session\'s own completed sets, not openGym\'s own stored value, which can be a user-typed confirmation rather than what was actually logged. watchStrengthDurationMin, when present, is Apple Watch-measured lifting time for that day (more accurate than durationMin, which spans openGym\'s own start/end and includes cardio bookends). id is this workout\'s own identifier — cross-reference get_activity_sessions\' matchedWorkoutId or get_exercise_history\'s workoutId against it.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('How many workouts to return (default 5).') },
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
        'Returns one exercise\'s progression across sessions, oldest first — per-occurrence top set (with topSetRpe, when logged), estimated 1-rep max (Epley formula), and total volume for that exercise that day, all from work sets only (warm-ups excluded, drop-set drops included). An occurrence with excludedFromProgression: true was flagged "Don\'t count for progression" by the user (injury/rehab day) — read it as context, not as a regression. Use this instead of get_recent_workouts when tracking a single lift over time: get_recent_workouts returns every exercise in every session, which means hauling a very large payload to use a fraction of it for this. estimated1RM is a derived index, not a measurement — trust its direction of change across occurrences, not its absolute value (Epley loses accuracy above ~6 reps and ignores RPE entirely, so identical estimates can hide very different actual effort — that\'s exactly what topSetRpe is there to catch).',
      inputSchema: {
        exerciseId: z.string().describe('The exercise ID, from get_recent_workouts, get_current_routines, or the exercise library.'),
        limit: z.number().int().min(1).max(100).optional().describe('Max number of most recent occurrences to return (default 20).'),
      },
    },
    async ({ exerciseId, limit }) => {
      const state = await getState();
      const exIndex = buildExerciseIndex(state);
      const occurrences = getExerciseOccurrences(state, exerciseId);
      const trimmed = occurrences.slice(-(limit ?? 20));
      return asJson({
        exerciseId,
        ...(exIndex.get(exerciseId) ? { exerciseName: exIndex.get(exerciseId) } : {}),
        estimated1RMNote:
          'Epley-formula estimate from logged weight × reps, not a measured 1RM — a derived index for tracking direction across occurrences, not an absolute figure to act on alone.',
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
        'Returns the workout routines/templates currently set up in openGym — the program structure, not logged history. Each exercise is openGym\'s raw config: sets, reps (repsMin–reps is a double-progression range), weight, pyramid (one rep target per set, "max" meaning as many as possible; pyramidRest is each set\'s own rest in seconds, 0 = the exercise\'s rest), intensifier (planned drop sets / rest-pause), restSec, sg (superset group) and prog (a per-exercise progression policy). These are stored targets — the weight the app will actually open with after progression can differ; use preview_next_session for that.',
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
          // since v1.3.10) isn't program structure — dropped.
          ...Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('_'))),
          ...(exIndex.get(e.id) ? { exerciseName: exIndex.get(e.id) } : {}),
        })),
      }));
      return asJson(routines);
    }
  );
}
