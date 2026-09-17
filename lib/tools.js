import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getState } from './opengym-client.js';
import { getDailySummary, getCheckInRange, getSleepAnalytics } from './sparkyfitness-client.js';
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
    'get_bodyweight_trend',
    {
      title: 'Get bodyweight trend',
      description:
        'Returns body-measurement check-ins from SparkyFitness (weight, body fat %, steps, BMR, and any other logged measurements) over a recent window, plus the net weight change across that window. SparkyFitness syncs from Apple Health (smart scale, watch), so it is treated as the authoritative source here — openGym does log a bodyweight figure per workout too, but it is manually re-typed rather than synced from a scale.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 30).') },
    },
    async ({ days }) => {
      const window = days ?? 30;
      const entries = (await getCheckInRange(window))
        .slice()
        .sort((a, b) => Date.parse(a.entry_date) - Date.parse(b.entry_date));

      const weighed = entries.filter((e) => e.weight != null);
      const first = weighed[0];
      const last = weighed[weighed.length - 1];

      const summary = {
        unit: 'kg',
        windowDays: window,
        entryCount: entries.length,
        change: first && last && first !== last ? Number((last.weight - first.weight).toFixed(2)) : null,
        entries: entries.map(summarizeCheckIn),
      };
      return asJson(summary);
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
