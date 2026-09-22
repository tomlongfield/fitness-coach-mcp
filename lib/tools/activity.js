import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { getExerciseEntriesByDate } from '../sparkyfitness-client.js';
import { daysAgoIsoDate } from '../date-utils.js';
import { asJson, mapWithConcurrency, DEFAULT_FETCH_CONCURRENCY } from './shared.js';
import { buildWorkoutsByDate } from './workouts.js';

// "Active Calories" (exercise_snapshot.category === null) is Apple Health's
// passive background daily-active-energy estimate, not a session you did —
// confirmed against live data (duration_minutes: 0, sets: [], every
// exercise_snapshot field null except source). Real logged activities
// (Cycling, Strength Training, etc.) always have a category. Filtering on
// that is a source-grounded distinction, not a guessed heuristic.
export function isRealActivitySession(e) {
  return e.exercise_snapshot?.category != null;
}

// "Strength" as a substring match, not an exact set — HealthKit's own
// category strings vary ("Traditional Strength Training", "Functional
// Strength Training") and this only needs to catch the family, not
// enumerate every variant.
export function isStrengthCategory(category) {
  return typeof category === 'string' && /strength/i.test(category);
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

export async function fetchActivitySessions(days, state) {
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
export async function fetchWatchStrengthMinutes(dates) {
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

export function registerActivityTools(server) {
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
}
