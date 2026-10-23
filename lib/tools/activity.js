import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { getExerciseEntriesByDate, getWorkoutHrZones } from '../sparkyfitness-client.js';
import { daysAgoIsoDate, localTimestamp } from '../date-utils.js';
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

// openGym writes each logged workout to Apple Health itself, timed to its
// own start and end, with no energy or heart rate (seen October 2026, also
// from its watch app). Not a separate session: openGym's durationMin covers it.
const OPENGYM_BUNDLE_ID = 'ch.opengym.app';
const isOpenGymCopy = (e) => e.activity_details?.[0]?.detail_data?.sourceBundleId === OPENGYM_BUNDLE_ID;

// startTime/endTime live inside activity_details' raw HealthKit payload, not
// on the entry itself — pull just those two out rather than exposing the
// rest (provider UUIDs, numeric activityType codes, nested unit/quantity
// objects), which carry no signal for a coach reasoning about training.
function summarizeHrZones(zones) {
  return zones
    .slice()
    .sort((a, b) => a.zone_index - b.zone_index)
    .map((z) => ({
      zone: z.zone_index,
      lowerBpm: z.zone_lower_bpm,
      upperBpm: z.zone_upper_bpm,
      minutes: Math.round((z.seconds_in_zone / 60) * 10) / 10,
    }));
}

function summarizeActivitySession(e, zones) {
  const detail = e.activity_details?.[0]?.detail_data;
  return {
    date: e.entry_date,
    name: e.name,
    category: e.exercise_snapshot?.category,
    ...(detail?.startTime ? { startTime: localTimestamp(detail.startTime) } : {}),
    ...(detail?.endTime ? { endTime: localTimestamp(detail.endTime) } : {}),
    durationMin: Math.round(e.duration_minutes),
    caloriesBurned: Math.round(e.calories_burned),
    // exercise_entries.distance is already kilometres — SparkyFitness's own
    // integrations convert to km before insert (see its
    // 20260818020000_fix_hevy_exercise_entry_distance_units migration). Not
    // to be confused with the "distance" custom-measurement category used by
    // get_vitals_trend, which is metres.
    ...(e.distance > 0 ? { distanceKm: Number(Number(e.distance).toFixed(2)) } : {}),
    ...(e.avg_heart_rate != null ? { avgHeartRateBpm: e.avg_heart_rate } : {}),
    ...(e.max_heart_rate != null ? { maxHeartRateBpm: e.max_heart_rate } : {}),
    ...(e.heart_rate_recovery_1min != null ? { heartRateRecovery1MinBpm: e.heart_rate_recovery_1min } : {}),
    ...(zones?.length ? { heartRateZones: summarizeHrZones(zones) } : {}),
    ...(isOpenGymCopy(e) ? { openGymCopy: true } : {}),
  };
}

export async function fetchActivitySessions(days, state) {
  const dates = Array.from({ length: days }, (_, i) => daysAgoIsoDate(i));
  const results = await mapWithConcurrency(dates, DEFAULT_FETCH_CONCURRENCY, getExerciseEntriesByDate);
  const entries = results.flat().filter(isRealActivitySession);
  // Zones only exist for an entry synced with a heart-rate series, which is
  // exactly when it has an average heart rate — the same gate SparkyFitness's
  // own mobile app uses, so sessions without HR cost no extra requests.
  const zonesById = new Map();
  const withHr = entries.filter((e) => e.avg_heart_rate > 0);
  const zoneResults = await mapWithConcurrency(withHr, DEFAULT_FETCH_CONCURRENCY, (e) => getWorkoutHrZones(e.id));
  withHr.forEach((e, i) => zonesById.set(e.id, zoneResults[i]));
  const sessions = entries
    .map((e) => summarizeActivitySession(e, zonesById.get(e.id)))
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
// openGym's own copy is left out, and a date with no other strength session
// is left out of the map (no data, not 0 minutes).
export async function fetchWatchStrengthMinutes(dates) {
  const results = await mapWithConcurrency(dates, DEFAULT_FETCH_CONCURRENCY, getExerciseEntriesByDate);
  const byDate = new Map();
  dates.forEach((date, i) => {
    const strength = results[i]
      .filter(isRealActivitySession)
      .filter((e) => isStrengthCategory(e.exercise_snapshot?.category) && !isOpenGymCopy(e));
    if (strength.length) byDate.set(date, Math.round(strength.reduce((sum, e) => sum + e.duration_minutes, 0)));
  });
  return byDate;
}

export function registerActivityTools(server) {
  server.registerTool(
    'get_activity_sessions',
    {
      title: 'Get Apple Watch activity sessions',
      description:
        "Apple Health workouts via SparkyFitness, with times, calories and, when synced, heart rate and zones; a gym visit is often several. matchedWorkoutId: the openGym workout on that date, by date alone. openGymCopy: true is openGym's own copy of its workout (no heart rate or calories): don't add it to the others.",
      inputSchema: { days: z.number().int().min(1).max(90).optional().describe('Days back (default 7).') },
    },
    async ({ days }) => {
      const window = days ?? 7;
      const state = await getState();
      const entries = await fetchActivitySessions(window, state);
      return asJson({ windowDays: window, entryCount: entries.length, entries });
    }
  );
}
