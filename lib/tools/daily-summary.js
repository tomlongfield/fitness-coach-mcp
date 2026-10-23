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
import { dayNoteOf, DAY_NOTE_LABEL } from '../vendor/opengym/day-notes.js';

// "First-set RPE" is the first RPE actually recorded that session, not the
// literal first set of the workout — a session that opens with an
// RPE-less warm-up would otherwise always read as null here regardless of
// what came later. Skipping to the first RPE-bearing set instead answers
// "how did the session open" regardless of what warm-up preceded it.
export function summarizeWorkoutRpe(workout) {
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

// openGym 1.4's note on a day you didn't train ("Sick", "Travelling",
// "Injured", "Rest day", and/or your own words) — the app treats a noted day
// as excused rather than missed.
function summarizeDayNote(state, date) {
  const note = dayNoteOf(state, date);
  if (!note) return null;
  return {
    ...(note.tag ? { tag: note.tag, label: DAY_NOTE_LABEL[note.tag] } : {}),
    ...(note.text ? { text: note.text } : {}),
  };
}

export function registerDailySummaryTools(server) {
  server.registerTool(
    'get_daily_summary',
    {
      title: 'Get daily summary',
      description:
        "One row per day joining weight, sleep, HRV, resting HR, steps, nutrition and the openGym workout with its work-set RPE. null, never 0, means no data; workoutRpe is null on a rest day and on a workout without RPE (see workoutName). dayNote is the user's openGym note (sick, travel, rest...): an excused gap. Today's nutrition is partial.",
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Days back (default 14).') },
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
          dayNote: summarizeDayNote(state, date),
        };
      });

      return asJson({ windowDays: window, entries });
    }
  );
}
