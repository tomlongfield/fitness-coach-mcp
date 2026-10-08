import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { getCheckInRange } from '../sparkyfitness-client.js';
import { localIsoDate, daysAgoIsoDate } from '../date-utils.js';
import { asJson, mapWithConcurrency, DEFAULT_FETCH_CONCURRENCY } from './shared.js';
import { summarizeCheckIn, fetchVitalsEntries } from './vitals.js';
import { fetchNutritionDay } from './nutrition.js';
import { fetchSleepEntries } from './sleep.js';
import { buildWorkoutsByDate } from './workouts.js';
import { isWarmupRow } from '../vendor/opengym/workout-model.js';

// "First-set RPE" is the first RPE actually recorded that session, not the
// literal first set of the workout — a session that opens with an
// RPE-less warm-up would otherwise always read as null here regardless of
// what came later. Skipping to the first RPE-bearing set instead answers
// "how did the session open" regardless of what warm-up preceded it.
function summarizeWorkoutRpe(workout) {
  if (!workout) return null;
  // Work sets only — openGym marks warm-ups explicitly (isWarmupRow), so a
  // warm-up that did get an RPE typed in no longer becomes firstSetRpe.
  const workSets = (workout.entries || []).flatMap((e) => e.sets || []).filter((s) => s && !isWarmupRow(s));
  const rpeValues = workSets.filter((s) => s.rpe != null).map((s) => s.rpe);
  if (!rpeValues.length) return null;
  return {
    firstSetRpe: rpeValues[0],
    maxRpe: Math.max(...rpeValues),
    avgRpe: Number((rpeValues.reduce((sum, v) => sum + v, 0) / rpeValues.length).toFixed(1)),
  };
}

export function registerDailySummaryTools(server) {
  server.registerTool(
    'get_daily_summary',
    {
      title: 'Get daily summary',
      description:
        'Returns one pre-joined row per day — weight, steps, sleep score, HRV (hrvAvgMs: that day\'s average SDNN in ms, as synced from Apple Health), resting heart rate, nutrition totals, that day\'s openGym workout name (if any), and an RPE summary for that workout (firstSetRpe: the first RPE recorded on a work set that session; maxRpe; avgRpe — all across work sets, warm-up sets excluded). Saves joining get_bodyweight_trend/get_sleep_trend/get_vitals_trend/get_nutrition_trend/get_recent_workouts by date by hand — one implementation to get right, not one to re-derive every time. Every field is null, not zero or interpolated, on a day with no data for it. workoutRpe is null both on a rest day and on a logged workout with no RPE recorded — check workoutName to tell the two apart. Today\'s nutrition carries partial: true, same convention as get_nutrition_trend, since the day is still in progress. sleepScore is read live from SparkyFitness on every call, not cached — a night\'s score can shift if HealthKit sends corrected sleep data in a later sync, which is not a bug in either this tool or get_sleep_trend, just the two agreeing on whatever SparkyFitness currently has stored.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14).') },
    },
    async ({ days }) => {
      const window = days ?? 14;
      const dates = Array.from({ length: window }, (_, i) => daysAgoIsoDate(i)).reverse();

      const [checkIns, vitalsEntries, sleepEntries, nutritionDays, state] = await Promise.all([
        getCheckInRange(window),
        fetchVitalsEntries(window),
        fetchSleepEntries(window),
        mapWithConcurrency(dates, DEFAULT_FETCH_CONCURRENCY, fetchNutritionDay),
        getState(),
      ]);

      // Same convention as get_nutrition_trend: today is still in progress,
      // so its totals are marked partial rather than presented as a
      // finished day's numbers — a caller comparing this against
      // get_nutrition_trend needs the two to agree on which days are done.
      const today = localIsoDate();
      for (const day of nutritionDays) {
        if (day.date === today) day.partial = true;
      }

      const checkInByDate = new Map(checkIns.map((e) => [e.entry_date, summarizeCheckIn(e)]));
      const vitalsByDate = new Map(vitalsEntries.map((e) => [e.date, e]));
      const sleepByDate = new Map(sleepEntries.map((e) => [e.date, e]));
      const nutritionByDate = new Map(nutritionDays.map((e) => [e.date, e]));
      const workoutsByDate = buildWorkoutsByDate(state);

      const entries = dates.map((date) => {
        const checkIn = checkInByDate.get(date);
        const workout = workoutsByDate.get(date);
        return {
          date,
          weight: checkIn?.weight ?? null,
          steps: checkIn?.steps ?? null,
          sleepScore: sleepByDate.get(date)?.sleepScore ?? null,
          hrvAvgMs: vitalsByDate.get(date)?.hrvAvgMs ?? null,
          restingHeartRateBpm: vitalsByDate.get(date)?.restingHeartRateBpm ?? null,
          nutrition: nutritionByDate.get(date) ?? null,
          workoutName: workout?.name ?? null,
          workoutRpe: summarizeWorkoutRpe(workout),
        };
      });

      return asJson({ windowDays: window, entries });
    }
  );
}
