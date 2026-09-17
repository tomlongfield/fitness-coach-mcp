import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getState } from './opengym-client.js';
import { getDailySummary, getCheckInRange, getSleepAnalytics, getCustomMeasurementRange, getExerciseEntriesByDate } from './sparkyfitness-client.js';
import { EXERCISE_LIBRARY } from './exercise-library.js';

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

function summarizeWorkout(w, exIndex) {
  return {
    date: w.d,
    name: w.name,
    routineId: w.routineId,
    bodyweight: w.bw,
    totalVolume: w.vol,
    personalRecords: w.prs || [],
    // Real clock time, not just the date — lets a caller compare against
    // get_activity_sessions (SparkyFitness/Apple Watch) to spot when the two
    // are describing the same real-world gym visit vs. genuinely separate
    // sessions on the same day, without either tool needing to compute that
    // itself.
    ...(w.start ? { startTime: new Date(w.start).toISOString() } : {}),
    ...(w.end ? { endTime: new Date(w.end).toISOString() } : {}),
    durationMin: w.start && w.end ? Math.round((w.end - w.start) / 60000) : undefined,
    ...(w.note ? { sessionNote: w.note } : {}),
    exercises: (w.entries || []).map((e) => ({
      exerciseId: e.id,
      ...(exIndex.get(e.id) ? { exerciseName: exIndex.get(e.id) } : {}),
      topWeight: e.topW,
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
  return {
    mealType: e.meal_type,
    name: e.food_name,
    ...(e.brand_name ? { brand: e.brand_name } : {}),
    quantity: e.quantity,
    unit: e.unit,
    ...(e.entry_time ? { time: e.entry_time } : {}),
    calories: e.calories,
    protein: e.protein,
    carbs: e.carbs,
    fat: e.fat,
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
    ...(e.bmr != null ? { bmr: e.bmr } : {}),
    ...(e.muscle_mass_kg != null ? { muscleMassKg: e.muscle_mass_kg } : {}),
    ...(e.bone_mass_kg != null ? { boneMassKg: e.bone_mass_kg } : {}),
    ...(e.body_water_percentage != null ? { bodyWaterPercentage: e.body_water_percentage } : {}),
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

async function fetchActivitySessions(days) {
  const dates = Array.from({ length: days }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    return d.toISOString().slice(0, 10);
  });
  const results = await Promise.all(dates.map((date) => getExerciseEntriesByDate(date)));
  return results
    .flat()
    .filter(isRealActivitySession)
    .map(summarizeActivitySession)
    .sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
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
        'Returns the most recently logged openGym workouts (newest first), including exercises, sets, weights, reps, volume, any PRs hit, and any session/exercise notes logged during the workout.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional().describe('How many workouts to return (default 5).') },
    },
    async ({ limit }) => {
      const state = await getState();
      const exIndex = buildExerciseIndex(state);
      const workouts = [...(state.workouts || [])]
        .sort((a, b) => workoutTimestamp(b) - workoutTimestamp(a))
        .slice(0, limit ?? 5)
        .map((w) => summarizeWorkout(w, exIndex));
      return asJson(workouts);
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
        'Returns body-composition check-ins from SparkyFitness (weight, body fat %, lean body mass, steps, BMR, and any other logged measurements) over a recent window, plus the net weight change across that window. SparkyFitness syncs from Apple Health (smart scale, watch), so it is treated as the authoritative source here — openGym does log a bodyweight figure per workout too, but it is manually re-typed rather than synced from a scale. Lean body mass comes from a separate custom-measurement category (SparkyFitness has no dedicated column for it) and is merged in by date.',
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
        'Returns discrete activity sessions logged via Apple Watch/HealthKit into SparkyFitness (e.g. "Cycling", "Traditional Strength Training") over a recent window, each with real start/end clock times — separate from openGym, which has no visibility into non-gym-logged activity at all. A single gym visit can appear here as several adjacent entries (e.g. a cardio warm-up, then strength, then a cardio cool-down) rather than one combined session, since that is how the watch actually segments it. Compare startTime/endTime against get_recent_workouts\' startTime/endTime on the same date to tell whether entries here represent the same real-world visit as an openGym-logged workout (timestamps close together) versus a genuinely separate session later the same day (timestamps far apart) — this is not computed for you.',
      inputSchema: { days: z.number().int().min(1).max(90).optional().describe('Lookback window in days (default 7).') },
    },
    async ({ days }) => {
      const window = days ?? 7;
      const entries = await fetchActivitySessions(window);
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
      const day = date ?? new Date().toISOString().slice(0, 10);
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
        calorieBalance: summary.calorieBalance,
        stepCalories: summary.stepCalories,
      };
      return asJson(result);
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
