import { z } from 'zod';
import { getCheckInRange, getCustomMeasurementRange } from '../sparkyfitness-client.js';
import { asJson } from './shared.js';

// Only non-null fields per entry — SparkyFitness's check-in rows carry every
// possible measurement whether or not it was actually synced that day (a
// steps-only day still returns null weight/bodyFat/etc.), and passing those
// nulls through would just be noise. Exported for get_daily_summary
// (daily-summary.js), which needs weight/steps joined alongside every
// other domain's data.
export function summarizeCheckIn(e) {
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
  // HRV deliberately isn't here — see get_hrv_samples (hrv.js). Every field
  // above is genuinely one-value-per-day; HRV_SDNN's category is configured
  // for multiple raw readings per day (frequency "All", not "Daily" — see
  // ../health-relay.js), which this Map-per-date merge has no way to
  // represent without silently keeping only the last reading and dropping
  // the rest.
];

// Deliberately no plausibility filtering/flagging here. An earlier version
// of this code flagged out-of-range values (e.g. heart rate outside
// 30-220bpm) as likely sensor artifacts — removed after it flagged real
// physiology as suspect: a 186bpm max on a nominal "rest day" turned out to
// be a genuine unplanned run recorded in the account's own diary that week.
// Plausibility needs context (schedule, diary, history) that this connector
// doesn't have and shouldn't guess at — that judgment belongs in the
// coaching layer, not baked into the data layer as a hardcoded range.
// Exported for get_daily_summary (daily-summary.js), which needs
// restingHeartRateBpm joined alongside every other domain's data.
export async function fetchVitalsEntries(days) {
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

export function registerVitalsTools(server) {
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
        'Returns daily heart rate (resting, min/max/avg), respiratory rate, blood oxygen saturation, VO2 max, and Apple Watch activity metrics (distance, exercise/stand minutes, floors climbed) from SparkyFitness over a recent window. All sourced from Apple Health via SparkyFitness custom-measurement categories, not its fixed check-in schema — see get_bodyweight_trend for weight/body-composition instead, and get_hrv_samples for heart rate variability (not here — HRV is logged multiple times a day, not once, which this tool\'s one-value-per-day shape can\'t represent).',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14).') },
    },
    async ({ days }) => {
      const window = days ?? 14;
      const entries = await fetchVitalsEntries(window);
      return asJson({ windowDays: window, entryCount: entries.length, entries });
    }
  );
}
