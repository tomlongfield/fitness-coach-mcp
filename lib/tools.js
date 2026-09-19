import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getState } from './opengym-client.js';
import { getDailySummary, getCheckInRange, getSleepAnalytics, getCustomMeasurementRange, getExerciseEntriesByDate } from './sparkyfitness-client.js';
import { EXERCISE_LIBRARY } from './exercise-library.js';
import { localIsoDate, daysAgoIsoDate } from './date-utils.js';

function asJson(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function workoutTimestamp(w) {
  // Prefer the numeric ms timestamp; fall back to the ISO day string.
  if (typeof w.start === 'number') return w.start;
  if (typeof w.d === 'string') return Date.parse(w.d);
  return 0;
}

// state.customEx covers exercises you've created yourself; EXERCISE_LIBRARY
// (a bundled snapshot of openGym's own built-in library, see
// lib/exercise-library.js) covers the rest — the API itself never exposes
// the built-in library, so without this, most exerciseIds would come back
// unresolved. customEx is seeded first and wins on any id collision, since
// it reflects your actual account rather than a point-in-time snapshot.
function buildExerciseIndex(state) {
  const map = new Map(Object.entries(EXERCISE_LIBRARY));
  for (const ex of state.customEx || []) {
    if (ex && ex.id) map.set(ex.id, ex.n);
  }
  return map;
}

// Heaviest completed set (done, has weight+reps), ties broken by higher
// reps. Shared by get_recent_workouts' per-exercise topWeight and
// get_exercise_history's occurrence topWeight so both derive it the same
// way, rather than one trusting openGym's own entry.topW — confirmed
// against openGym's frontend source (sheets.jsx's TopWeight sheet) that
// this is a semi-manual "confirmed weight" a user types into a post-set
// dialog (pre-filled from either today's actual max or their all-time
// best), not a pure derivation from the logged sets, and can silently
// diverge from them.
function topSetOf(sets) {
  const weighted = (sets || []).filter((s) => s.done && s.w != null && s.r != null);
  return weighted.length
    ? weighted.reduce((best, s) => (s.w > best.w || (s.w === best.w && s.r > best.r) ? s : best))
    : null;
}

// One exercise's occurrence within a single workout — shared by
// get_exercise_history and the PR-object enrichment below, since both need
// the same top-set/1RM/volume reconstruction from raw sets.
function summarizeExerciseOccurrence(w, entry) {
  const weightedSets = (entry.sets || []).filter((s) => s.done && s.w != null && s.r != null);
  const topSet = topSetOf(entry.sets);
  const volume = weightedSets.reduce((sum, s) => sum + s.w * s.r, 0);
  return {
    date: w.d,
    workoutId: w.id,
    topWeight: topSet?.w ?? null,
    topReps: topSet?.r ?? null,
    // Epley formula, off the heaviest completed set only. Unrounded — this
    // exists purely for cross-occurrence comparison, and rounding to an
    // integer injects up to ~1kg of artificial noise into that comparison
    // for no benefit; round for display, not here.
    estimated1RM: topSet ? Number((topSet.w * (1 + topSet.r / 30)).toFixed(2)) : null,
    volume,
    ...(entry.note ? { note: entry.note } : {}),
  };
}

// Every occurrence of one exercise across the account's full workout
// history, oldest first — openGym's whole-state model means this is a scan
// of state.workouts, not a separate query.
function getExerciseOccurrences(state, exerciseId) {
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

function summarizeWorkout(w, exIndex, { state, watchStrengthDurationMin } = {}) {
  return {
    id: w.id,
    date: w.d,
    name: w.name,
    routineId: w.routineId,
    bodyweight: w.bw,
    totalVolume: w.vol,
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
      sets: (e.sets || []).map((s) => ({
        weight: s.w,
        reps: s.r,
        done: s.done,
        ...(s.rir != null ? { rir: s.rir } : {}),
        ...(s.rpe != null ? { rpe: s.rpe } : {}),
      })),
    })),
  };
}

function summarizeFoodEntry(e) {
  // SparkyFitness's daily-summary endpoint returns calories/protein/carbs/fat
  // at the food's catalog serving_size rate, not scaled to the logged
  // quantity (e.g. quantity:400g, serving_size:100g still reports the 100g
  // figures). Scale it ourselves; entries where quantity == serving_size are
  // unaffected because the multiplier is 1. Only scale when quantity's unit
  // actually matches serving_size's unit — if a food is ever logged in a
  // different unit than its catalog serving (e.g. oz vs g), quantity/
  // serving_size isn't a valid ratio, so fall back to the unscaled figure
  // rather than silently computing nonsense.
  const unitsMatch = !e.serving_unit || e.unit === e.serving_unit;
  const multiplier = e.serving_size && unitsMatch ? e.quantity / e.serving_size : 1;
  const scale = (n) => (n == null ? n : Number((n * multiplier).toFixed(2)));
  return {
    mealType: e.meal_type,
    name: e.food_name,
    ...(e.brand_name ? { brand: e.brand_name } : {}),
    quantity: e.quantity,
    unit: e.unit,
    ...(e.entry_time ? { time: e.entry_time } : {}),
    calories: scale(e.calories),
    protein: scale(e.protein),
    carbs: scale(e.carbs),
    fat: scale(e.fat),
  };
}

// SparkyFitness's own calorieBalance.eaten total is already correctly
// scaled (verified against live data: it matches the sum of this
// connector's scaled foodEntries to within rounding, e.g. 2859 vs. 2858.8
// summed independently) — the scaling bug above is specific to the
// foodEntries array's display, not SparkyFitness's own aggregation. Passed
// through mostly as-is; only tdeeProjection needs reshaping.
function summarizeCalorieBalance(cb) {
  if (!cb) return null;
  return {
    eaten: cb.eaten,
    burned: cb.burned,
    remaining: cb.remaining,
    goal: cb.goal,
    net: cb.net,
    // Renamed from SparkyFitness's own "progress" — this is the one field
    // in this reshape that isn't a straight pass-through, worth calling out
    // since a silent rename is exactly the kind of thing that trips up a
    // consumer built against the raw upstream field name.
    progressPct: cb.progress,
    bmr: cb.bmr,
    bmrSource: cb.bmrSource,
    exerciseSource: cb.exerciseSource,
    // Confirmed live: this is bare null on every day sampled, indistinguishable
    // from a field that didn't survive some future rewrite. Say why instead.
    tdeeProjection: cb.tdeeProjection ?? {
      status: 'insufficient_data',
      note: 'A back-calculated TDEE needs several weeks of consistent nutrition logging against observed weight change — see get_nutrition_trend for the daily totals that feed it.',
    },
  };
}

// null, not a zeroed-out totals object, when nothing was logged — a day
// with no foodEntries isn't a fasting day, it's an absent one, and a bare
// 0 here is indistinguishable from "ate nothing" to anything charting it.
function sumFoodEntryMacros(foodEntries) {
  if (!foodEntries || !foodEntries.length) return null;
  const scaled = foodEntries.map(summarizeFoodEntry);
  const sum = (key) => Number(scaled.reduce((total, e) => total + (e[key] ?? 0), 0).toFixed(2));
  return { calories: sum('calories'), protein: sum('protein'), carbs: sum('carbs'), fat: sum('fat') };
}

async function fetchNutritionDay(date) {
  const summary = await getDailySummary(date);
  const totals = sumFoodEntryMacros(summary.foodEntries);
  return {
    date,
    calories: totals?.calories ?? null,
    protein: totals?.protein ?? null,
    carbs: totals?.carbs ?? null,
    fat: totals?.fat ?? null,
    waterMl: summary.waterIntake,
    ...(totals && summary.goals?.calories
      ? { adherencePct: Math.round((totals.calories / summary.goals.calories) * 100) }
      : {}),
  };
}

// Only non-null fields per entry — SparkyFitness's check-in rows carry every
// possible measurement whether or not it was actually synced that day (a
// steps-only day still returns null weight/bodyFat/etc.), and passing those
// nulls through would just be noise.
function summarizeCheckIn(e) {
  return {
    date: e.entry_date,
    ...(e.weight != null ? { weight: e.weight } : {}),
    ...(e.body_fat_percentage != null ? { bodyFatPercentage: e.body_fat_percentage } : {}),
    ...(e.steps != null ? { steps: e.steps } : {}),
    // NOT basal metabolic rate, despite the source field's name. This is
    // Apple Health's HKQuantityTypeIdentifierBasalEnergyBurned figure — a
    // static formula over age/sex/height/weight, not a sensor reading, and
    // normally near-identical day to day (confirmed against Apple's own
    // docs and multiple Apple Community reports). Its daily swing is a
    // documented, unresolved Apple bug: Health is supposed to backfill this
    // figure uniformly for hours the Watch isn't worn, and on affected days
    // that backfill silently fails for part of the day. It loosely
    // correlates with low-wear periods (that's when the backfill gap opens
    // up) but is NOT a reliable derived wear-time signal — a prior version
    // of this code computed one anyway (watchWearCompletenessPct) and it
    // was wrong: an account's single highest-step day in a 30-day window
    // scored only 89% "completeness" from this bug, not a real gap in
    // watch wear. Real BMR is get_nutrition_day's calorieBalance.bmr
    // (bmrSource: "formula", computed from body composition and stable day
    // to day) — do not conflate the two. SparkyFitness itself doesn't
    // compute this field either way: /api/measurements/check-in accepts
    // bmr as an arbitrary client-supplied number validated only against a
    // 300-10000kcal range, so this value is Apple's HealthKit figure (bug
    // included) synced straight through with nothing checking it.
    ...(e.bmr != null ? { appleBasalEnergyKcal: e.bmr } : {}),
  };
}

// SparkyFitness custom-measurement category name -> [output field, optional
// value transform]. Deliberately a curated subset, not all ~30 categories
// that can show up here (walking-gait and running-form metrics are synced
// but intentionally left out) — extend this list to track more of what's
// already syncing, see get_bodyweight_trend's lean_body_mass for the same
// pattern applied to a single metric.
const VITALS_CATEGORIES = [
  ['resting_heart_rate', 'restingHeartRateBpm'],
  ['heart_rate_min', 'heartRateMinBpm'],
  ['heart_rate_max', 'heartRateMaxBpm'],
  ['heart_rate_avg', 'heartRateAvgBpm'],
  ['respiratory_rate_min', 'respiratoryRateMinBrpm'],
  ['respiratory_rate_max', 'respiratoryRateMaxBrpm'],
  ['respiratory_rate_avg', 'respiratoryRateAvgBrpm'],
  ['blood_oxygen_saturation_min', 'bloodOxygenMinPct'],
  ['blood_oxygen_saturation_max', 'bloodOxygenMaxPct'],
  ['blood_oxygen_saturation_avg', 'bloodOxygenAvgPct'],
  ['vo2_max', 'vo2Max'],
  ['distance', 'distanceKm', (v) => Number((v / 1000).toFixed(2))],
  // Despite SparkyFitness's own category metadata labeling these
  // "seconds" (measurement_type on GET /measurements/custom-categories),
  // live data confirms they're already minutes — e.g. a raw value of 28 on
  // a day with a 45-minute gym session, not a plausible seconds count.
  // Matches Apple's own HealthKit convention: AppleExerciseTime and
  // AppleStandTime are natively minute-granularity metrics at the source.
  // A prior version of this code divided by 60 here, which silently
  // collapsed every real value to 0 or 1.
  ['apple_exercise_time', 'exerciseTimeMin'],
  ['apple_stand_time', 'standTimeMin'],
  ['floors_climbed', 'floorsClimbed'],
];

// Deliberately no plausibility filtering/flagging here. An earlier version
// of this code flagged out-of-range values (e.g. heart rate outside
// 30-220bpm) as likely sensor artifacts — removed after it flagged real
// physiology as suspect: a 186bpm max on a nominal "rest day" turned out to
// be a genuine unplanned run recorded in the account's own diary that week.
// Plausibility needs context (schedule, diary, history) that this connector
// doesn't have and shouldn't guess at — that judgment belongs in the
// coaching layer, not baked into the data layer as a hardcoded range.
async function fetchVitalsEntries(days) {
  const results = await Promise.all(
    VITALS_CATEGORIES.map(([name]) => getCustomMeasurementRange(name, days))
  );
  const byDate = new Map();
  VITALS_CATEGORIES.forEach(([, field, transform], i) => {
    for (const e of results[i]) {
      const raw = Number(e.value);
      if (Number.isNaN(raw)) continue;
      const value = transform ? transform(raw) : raw;
      // Custom-measurement-range entries use "date", not "entry_date" —
      // confirmed against live data; SparkyFitness's own swagger docs say
      // entry_date here, but that's wrong for this endpoint specifically.
      const entry = byDate.get(e.date) || { date: e.date };
      entry[field] = value;
      byDate.set(e.date, entry);
    }
  });
  return [...byDate.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

// "Active Calories" (exercise_snapshot.category === null) is Apple Health's
// passive background daily-active-energy estimate, not a session you did —
// confirmed against live data (duration_minutes: 0, sets: [], every
// exercise_snapshot field null except source). Real logged activities
// (Cycling, Strength Training, etc.) always have a category. Filtering on
// that is a source-grounded distinction, not a guessed heuristic.
function isRealActivitySession(e) {
  return e.exercise_snapshot?.category != null;
}

// startTime/endTime live inside activity_details' raw HealthKit payload, not
// on the entry itself — pull just those two out rather than exposing the
// rest (provider UUIDs, numeric activityType codes, nested unit/quantity
// objects), which carry no signal for a coach reasoning about training.
function summarizeActivitySession(e) {
  const detail = e.activity_details?.[0]?.detail_data;
  return {
    date: e.entry_date,
    name: e.name,
    category: e.exercise_snapshot?.category,
    ...(detail?.startTime ? { startTime: detail.startTime } : {}),
    ...(detail?.endTime ? { endTime: detail.endTime } : {}),
    durationMin: Math.round(e.duration_minutes),
    caloriesBurned: Math.round(e.calories_burned),
    // distance is in meters — not documented in SparkyFitness's own schema,
    // confirmed instead via its seed test data, the "distance" custom-
    // measurement category's explicit "m" unit, and the mobile app's own
    // km display formatter, all consistent with meters as the base unit.
    ...(e.distance > 0 ? { distanceKm: Number((e.distance / 1000).toFixed(2)) } : {}),
    ...(e.avg_heart_rate != null ? { avgHeartRateBpm: e.avg_heart_rate } : {}),
  };
}

// SparkyFitness has no date-range endpoint for exercise entries, so a
// multi-day window means one request per day (see getExerciseEntriesByDate).
// Capped rather than fully parallel — the 90-day max window would otherwise
// fire 90 concurrent requests at once. Shared across every tool that fans
// out one SparkyFitness call per day in a window.
const DEFAULT_FETCH_CONCURRENCY = 10;

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// "Strength" as a substring match, not an exact set — HealthKit's own
// category strings vary ("Traditional Strength Training", "Functional
// Strength Training") and this only needs to catch the family, not
// enumerate every variant.
function isStrengthCategory(category) {
  return typeof category === 'string' && /strength/i.test(category);
}

// First openGym workout per calendar date — same-day double sessions are
// rare enough that "first" is an acceptable simplification rather than
// something worth a more elaborate join.
function buildWorkoutsByDate(state) {
  const map = new Map();
  for (const w of state.workouts || []) {
    if (!map.has(w.d)) map.set(w.d, w);
  }
  return map;
}

async function fetchActivitySessions(days, state) {
  const dates = Array.from({ length: days }, (_, i) => daysAgoIsoDate(i));
  const results = await mapWithConcurrency(dates, DEFAULT_FETCH_CONCURRENCY, getExerciseEntriesByDate);
  const sessions = results
    .flat()
    .filter(isRealActivitySession)
    .map(summarizeActivitySession)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

  // Server-side join replacing the caller-side date/timestamp inference the
  // tool description used to push onto the consumer — settled rule: match
  // by calendar date.
  const workoutsByDate = buildWorkoutsByDate(state);
  for (const s of sessions) {
    const workout = workoutsByDate.get(s.date);
    if (workout) s.matchedWorkoutId = workout.id;
  }
  return sessions;
}

// Same-day sum of watch Strength-category session durations, used instead
// of openGym's own start/end span for get_recent_workouts' PR/duration
// enrichment — that span includes the cardio bookends and inflates whenever
// the workout is closed out late (settled rule, same join as above).
async function fetchWatchStrengthMinutes(dates) {
  const results = await mapWithConcurrency(dates, DEFAULT_FETCH_CONCURRENCY, getExerciseEntriesByDate);
  const byDate = new Map();
  dates.forEach((date, i) => {
    const minutes = results[i]
      .filter(isRealActivitySession)
      .filter((e) => isStrengthCategory(e.exercise_snapshot?.category))
      .reduce((sum, e) => sum + e.duration_minutes, 0);
    byDate.set(date, Math.round(minutes));
  });
  return byDate;
}

// stagePercentages is always {unspecified: 100} when the sync source doesn't
// report a deep/REM/light breakdown — only include it when some other stage
// actually has a nonzero share, otherwise it's pure noise.
function summarizeSleepDay(e) {
  const hasStageData = e.stagePercentages
    && Object.entries(e.stagePercentages).some(([stage, pct]) => stage !== 'unspecified' && pct > 0);
  return {
    date: e.date,
    asleepMin: Math.round(e.timeAsleep / 60),
    sessionDurationMin: Math.round(e.totalSleepDuration / 60),
    sleepScore: e.sleepScore,
    bedtime: e.earliestBedtime,
    wakeTime: e.latestWakeTime,
    sleepEfficiencyPct: Number(e.sleepEfficiency.toFixed(1)),
    sleepDebtHours: Number(e.sleepDebt.toFixed(2)),
    awakePeriods: e.awakePeriods,
    awakeMin: Math.round(e.totalAwakeDuration / 60),
    ...(hasStageData ? { stagePercentages: e.stagePercentages } : {}),
  };
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Always Monday-first in this tool's output, regardless of the account's own
// weekStart display preference (Sunday or Monday) — that's a UI ordering
// choice, not something worth making this tool's shape depend on.
const MONDAY_FIRST_ORDER = [1, 2, 3, 4, 5, 6, 0];

// state.week is keyed by JS Date.getDay() convention (0=Sunday..6=Saturday),
// each value an array of routine ids for that day. A day with no routines
// assigned has its key deleted entirely (openGym never stores an empty
// array there) — that's a rest day.
function summarizeWeeklySchedule(state) {
  const routinesById = new Map((state.routines || []).map((r) => [r.id, r]));
  return MONDAY_FIRST_ORDER.map((d) => {
    const routineIds = state.week?.[d] || [];
    const routines = routineIds
      .map((id) => routinesById.get(id))
      .filter(Boolean)
      .map((r) => ({ id: r.id, name: r.name, emoji: r.emoji }));
    return { day: WEEKDAY_NAMES[d], routines };
  });
}

/**
 * Builds a fresh McpServer with every tool registered. Called once per
 * incoming request (see server.js) rather than reused across requests —
 * reusing a single server/transport across clients is exactly the pattern
 * behind CVE-2026-25536 in the MCP SDK's stateless HTTP mode.
 */
export function buildServer() {
  const server = new McpServer({ name: 'fitness-coach', version: '1.0.0' });

  server.registerTool(
    'get_recent_workouts',
    {
      title: 'Get recent workouts',
      description:
        'Returns the most recently logged openGym workouts (newest first), including exercises, sets, weights, reps, volume, any PRs hit (with type — weight/reps/volume/first — and the previous value each beat), and any session/exercise notes logged during the workout. Each PR is reconstructed from this exercise\'s own history, not just openGym\'s bare pass/fail flag — entries where nothing actually changed on any axis are dropped (openGym\'s own flag can fire against a stale internal cache with no real change behind it). Note a PR\'s "new"/"previous" volume figures are session totals, not tied to the top set that drove weight/reps — a genuine weight PR can still show lower total volume than the prior session if fewer total reps were completed at the heavier load, that\'s correct, not a bug. exercises[].topWeight is derived from that session\'s own completed sets, not openGym\'s own stored value, which can be a user-typed confirmation rather than what was actually logged. watchStrengthDurationMin, when present, is Apple Watch-measured lifting time for that day (more accurate than durationMin, which spans openGym\'s own start/end and includes cardio bookends). id is this workout\'s own identifier — cross-reference get_activity_sessions\' matchedWorkoutId or get_exercise_history\'s workoutId against it.',
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
        'Returns one exercise\'s progression across sessions, oldest first — per-occurrence top set, estimated 1-rep max (Epley formula), and total volume for that exercise that day. Use this instead of get_recent_workouts when tracking a single lift over time: get_recent_workouts returns every exercise in every session, which means hauling a very large payload to use a fraction of it for this. estimated1RM is a derived index, not a measurement — trust its direction of change across occurrences, not its absolute value (Epley loses accuracy above ~6 reps and ignores RPE entirely, so identical estimates can hide very different actual effort).',
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
        'Returns the workout routines/templates currently set up in openGym — the program structure, not logged history.',
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
          ...e,
          ...(exIndex.get(e.id) ? { exerciseName: exIndex.get(e.id) } : {}),
        })),
      }));
      return asJson(routines);
    }
  );

  server.registerTool(
    'get_weekly_schedule',
    {
      title: 'Get weekly schedule',
      description:
        "Returns openGym's fixed weekly plan — which routine(s), if any, are assigned to each day of the week (Monday first). A day with no routines listed is a rest day. This is the planned structure, not logged history — cross-reference against get_recent_workouts to see what actually happened on a given day.",
      inputSchema: {},
    },
    async () => {
      const state = await getState();
      return asJson(summarizeWeeklySchedule(state));
    }
  );

  server.registerTool(
    'get_bodyweight_trend',
    {
      title: 'Get bodyweight trend',
      description:
        'Returns body-composition check-ins from SparkyFitness (weight, body fat %, lean body mass, steps, appleBasalEnergyKcal, and any other logged measurements) over a recent window, plus the net weight change across that window. SparkyFitness syncs from Apple Health (smart scale, watch), so it is treated as the authoritative source here — openGym does log a bodyweight figure per workout too, but it is manually re-typed rather than synced from a scale. Lean body mass comes from a separate custom-measurement category (SparkyFitness has no dedicated column for it) and is merged in by date. appleBasalEnergyKcal is NOT metabolic rate — see its own note.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 30).') },
    },
    async ({ days }) => {
      const window = days ?? 30;
      const [checkIns, leanBodyMass] = await Promise.all([
        getCheckInRange(window),
        getCustomMeasurementRange('lean_body_mass', window),
      ]);

      const byDate = new Map();
      for (const e of checkIns) {
        byDate.set(e.entry_date, summarizeCheckIn(e));
      }
      for (const e of leanBodyMass) {
        const value = Number(e.value);
        if (Number.isNaN(value)) continue;
        // Custom-measurement-range entries use "date", not "entry_date" —
        // see the same note in fetchVitalsEntries. checkIns above is a
        // different endpoint (check-in-measurements-range) that genuinely
        // does use entry_date; don't "fix" that one to match.
        const entry = byDate.get(e.date) || { date: e.date };
        entry.leanBodyMassKg = value;
        byDate.set(e.date, entry);
      }

      const entries = [...byDate.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

      const weighed = entries.filter((e) => e.weight != null);
      const first = weighed[0];
      const last = weighed[weighed.length - 1];

      const summary = {
        unit: 'kg',
        windowDays: window,
        entryCount: entries.length,
        change: first && last && first !== last ? Number((last.weight - first.weight).toFixed(2)) : null,
        entries,
      };
      return asJson(summary);
    }
  );

  server.registerTool(
    'get_vitals_trend',
    {
      title: 'Get vitals and activity trend',
      description:
        'Returns daily heart rate (resting, min/max/avg), respiratory rate, blood oxygen saturation, VO2 max, and Apple Watch activity metrics (distance, exercise/stand minutes, floors climbed) from SparkyFitness over a recent window. All sourced from Apple Health via SparkyFitness custom-measurement categories, not its fixed check-in schema — see get_bodyweight_trend for weight/body-composition instead.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14).') },
    },
    async ({ days }) => {
      const window = days ?? 14;
      const entries = await fetchVitalsEntries(window);
      return asJson({ windowDays: window, entryCount: entries.length, entries });
    }
  );

  server.registerTool(
    'get_activity_sessions',
    {
      title: 'Get Apple Watch activity sessions',
      description:
        'Returns discrete activity sessions logged via Apple Watch/HealthKit into SparkyFitness (e.g. "Cycling", "Traditional Strength Training") over a recent window, each with real start/end clock times — separate from openGym, which has no visibility into non-gym-logged activity at all. A single gym visit can appear here as several adjacent entries (e.g. a cardio warm-up, then strength, then a cardio cool-down) rather than one combined session, since that is how the watch actually segments it. matchedWorkoutId, when present, is the openGym workout logged the same calendar date (server-side join, not something you need to infer from timestamps) — cross-reference get_recent_workouts for that workout\'s own detail.',
      inputSchema: { days: z.number().int().min(1).max(90).optional().describe('Lookback window in days (default 7).') },
    },
    async ({ days }) => {
      const window = days ?? 7;
      const state = await getState();
      const entries = await fetchActivitySessions(window, state);
      return asJson({ windowDays: window, entryCount: entries.length, entries });
    }
  );

  server.registerTool(
    'get_nutrition_day',
    {
      title: 'Get nutrition for a day',
      description:
        'Returns everything logged in SparkyFitness for a single day: food entries with calories/macros, water intake, calorie balance (eaten vs. burned vs. goal), and step-based calorie burn.',
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('Date in YYYY-MM-DD format (default: today).'),
      },
    },
    async ({ date }) => {
      const day = date ?? localIsoDate();
      const summary = await getDailySummary(day);
      const result = {
        date: day,
        goals: {
          calories: summary.goals?.calories,
          protein: summary.goals?.protein,
          carbs: summary.goals?.carbs,
          fat: summary.goals?.fat,
          waterMl: summary.goals?.water_goal_ml,
        },
        foodEntries: (summary.foodEntries || []).map(summarizeFoodEntry),
        waterIntakeMl: summary.waterIntake,
        calorieBalance: summarizeCalorieBalance(summary.calorieBalance),
        stepCalories: summary.stepCalories,
      };
      return asJson(result);
    }
  );

  server.registerTool(
    'get_nutrition_trend',
    {
      title: 'Get nutrition trend',
      description:
        'Returns per-day calorie/macro/water totals from SparkyFitness over a recent window, plus averages and adherence against goal. Use this instead of calling get_nutrition_day once per day when you need a multi-day trend rather than full per-food detail — get_nutrition_day returns every food entry for one day, which is far more detail than a trend needs repeated across a window. Unlogged days return null macros, not 0 — an absent day is not a fasting day. Today (partial: true) is excluded from averages/loggedDayCount since the day is still in progress, but its entry is still returned with whatever has been logged so far.',
      inputSchema: { days: z.number().int().min(1).max(90).optional().describe('Lookback window in days (default 7).') },
    },
    async ({ days }) => {
      const window = days ?? 7;
      const today = localIsoDate();
      const dates = Array.from({ length: window }, (_, i) => daysAgoIsoDate(i)).reverse();
      const entries = await mapWithConcurrency(dates, DEFAULT_FETCH_CONCURRENCY, fetchNutritionDay);
      for (const e of entries) {
        if (e.date === today) e.partial = true;
      }
      // Excludes both unlogged days (calories: null) and today (partial:
      // true, still in progress) — averaging today in alongside finished
      // days skews every macro low and can invert whether adherence looks
      // over or under goal, purely as an artifact of what time of day this
      // gets called.
      const logged = entries.filter((e) => e.calories != null && !e.partial);
      const avg = (key) =>
        logged.length ? Number((logged.reduce((sum, e) => sum + e[key], 0) / logged.length).toFixed(1)) : null;
      return asJson({
        windowDays: window,
        entryCount: entries.length,
        loggedDayCount: logged.length,
        averages: { calories: avg('calories'), protein: avg('protein'), carbs: avg('carbs'), fat: avg('fat') },
        entries,
      });
    }
  );

  server.registerTool(
    'get_sleep_trend',
    {
      title: 'Get sleep trend',
      description:
        'Returns nightly sleep analytics from SparkyFitness (time asleep, session duration, sleep score, efficiency, sleep debt, bedtime/wake time, awakenings) over a recent window, plus averages across it.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14).') },
    },
    async ({ days }) => {
      const window = days ?? 14;
      const entries = (await getSleepAnalytics(window))
        .slice()
        .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));

      const summary = {
        windowDays: window,
        entryCount: entries.length,
        avgAsleepMin: entries.length
          ? Math.round(entries.reduce((sum, e) => sum + e.timeAsleep, 0) / entries.length / 60)
          : null,
        avgSleepScore: entries.length
          ? Number((entries.reduce((sum, e) => sum + e.sleepScore, 0) / entries.length).toFixed(1))
          : null,
        entries: entries.map(summarizeSleepDay),
      };
      return asJson(summary);
    }
  );

  return server;
}
