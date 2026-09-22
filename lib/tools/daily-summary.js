import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { getCheckInRange } from '../sparkyfitness-client.js';
import { localIsoDate, daysAgoIsoDate, localHour } from '../date-utils.js';
import { asJson, mapWithConcurrency, DEFAULT_FETCH_CONCURRENCY } from './shared.js';
import { summarizeCheckIn, fetchVitalsEntries } from './vitals.js';
import { fetchHrvSamples } from './hrv.js';
import { fetchNutritionDay } from './nutrition.js';
import { fetchSleepEntries } from './sleep.js';
import { buildWorkoutsByDate } from './workouts.js';

// Fixed, not a parameter — matches the actual current need (the
// readiness-composite work this tool exists for already assumes this
// window). Add a parameter later if a different overnight definition turns
// out to matter, rather than building flexibility nothing's asked for yet.
const OVERNIGHT_END_HOUR = 8;

// Buckets raw HRV samples (get_hrv_samples' own shape — UTC timestamps)
// into one 00:00-08:00-local average per calendar day. This UTC-to-local
// bucketing is exactly the fiddly, easy-to-get-wrong logic this whole tool
// exists to centralize — see the tool description below.
function bucketOvernightHrv(samples) {
  const byDate = new Map();
  for (const sample of samples) {
    const ts = new Date(sample.timestamp);
    if (localHour(ts) >= OVERNIGHT_END_HOUR) continue;
    const date = localIsoDate(ts);
    const bucket = byDate.get(date) || [];
    bucket.push(sample.value);
    byDate.set(date, bucket);
  }
  const avgByDate = new Map();
  for (const [date, values] of byDate) {
    avgByDate.set(date, Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(2)));
  }
  return avgByDate;
}

// "First-set RPE" is literally the very first entry's very first set's own
// rpe — null if that specific set has no RPE logged, even if later sets in
// the same session do. Deliberately not "the first RPE-bearing set
// encountered" — that would answer a different question (whether RPE was
// logged at all that day) rather than how the session actually opened.
function summarizeWorkoutRpe(workout) {
  if (!workout) return null;
  const allSets = (workout.entries || []).flatMap((e) => e.sets || []);
  const rpeValues = allSets.filter((s) => s.rpe != null).map((s) => s.rpe);
  if (!rpeValues.length) return null;
  const firstSet = workout.entries?.[0]?.sets?.[0];
  return {
    firstSetRpe: firstSet?.rpe ?? null,
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
        'Returns one pre-joined row per day — weight, steps, sleep score, overnight HRV (00:00-08:00 local average, ms), resting heart rate, nutrition totals, that day\'s openGym workout name (if any), and an RPE summary for that workout (firstSetRpe, maxRpe, avgRpe across all logged sets). Exists to remove the fiddly, easy-to-get-wrong UTC-to-local overnight bucketing that assembling this by hand from get_bodyweight_trend/get_sleep_trend/get_hrv_samples/get_vitals_trend/get_nutrition_trend/get_recent_workouts separately requires — one implementation to get right, not one to re-derive every time. Every field is null, not zero or interpolated, on a day with no data for it. workoutRpe is null both on a rest day and on a logged workout with no RPE recorded — check workoutName to tell the two apart.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14).') },
    },
    async ({ days }) => {
      const window = days ?? 14;
      const dates = Array.from({ length: window }, (_, i) => daysAgoIsoDate(i)).reverse();

      const [checkIns, vitalsEntries, hrvSamples, sleepEntries, nutritionDays, state] = await Promise.all([
        getCheckInRange(window),
        fetchVitalsEntries(window),
        fetchHrvSamples(window),
        fetchSleepEntries(window),
        mapWithConcurrency(dates, DEFAULT_FETCH_CONCURRENCY, fetchNutritionDay),
        getState(),
      ]);

      const checkInByDate = new Map(checkIns.map((e) => [e.entry_date, summarizeCheckIn(e)]));
      const vitalsByDate = new Map(vitalsEntries.map((e) => [e.date, e]));
      const sleepByDate = new Map(sleepEntries.map((e) => [e.date, e]));
      const nutritionByDate = new Map(nutritionDays.map((e) => [e.date, e]));
      const overnightHrvByDate = bucketOvernightHrv(hrvSamples);
      const workoutsByDate = buildWorkoutsByDate(state);

      const entries = dates.map((date) => {
        const checkIn = checkInByDate.get(date);
        const workout = workoutsByDate.get(date);
        return {
          date,
          weight: checkIn?.weight ?? null,
          steps: checkIn?.steps ?? null,
          sleepScore: sleepByDate.get(date)?.sleepScore ?? null,
          overnightHrvMs: overnightHrvByDate.get(date) ?? null,
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
