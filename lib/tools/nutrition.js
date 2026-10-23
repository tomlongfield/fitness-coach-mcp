import { z } from 'zod';
import { getDailySummary, getLatestCheckInOnOrBefore, getUserPreferences } from '../sparkyfitness-client.js';
import { localIsoDate, daysAgoIsoDate } from '../date-utils.js';
import { asJson, mapWithConcurrency, DEFAULT_FETCH_CONCURRENCY } from './shared.js';

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
// through mostly as-is; only BMR needs reshaping.
//
// BMR: SparkyFitness's own calorieBalance.bmr is its formula figure (the
// account's bmr_algorithm) unless "Use external BMR" is on, in which case a
// synced reading for the day replaces it and is labelled bmrSource
// "measured". On this account that reading is Apple Health's resting-energy
// estimate, about 900 kcal/day above the formula, and nothing about it is
// measured. So the two are returned side by side under names that say what
// they are, and nothing is labelled "measured". No BMR is calculated here:
// the formula figure exists only when SparkyFitness reports bmrSource
// "formula", i.e. with "Use external BMR" turned off.
function summarizeCalorieBalance(cb, { checkIn, preferences } = {}) {
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
    bmrFormulaKcal: cb.bmrSource === 'formula' ? cb.bmr : null,
    bmrFormula: preferences?.bmr_algorithm || null,
    appleRestingKcal: checkIn?.bmr != null ? Math.round(Number(checkIn.bmr)) : null,
    ...(cb.bmrSource === 'formula'
      ? {}
      : {
          bmrNote:
            'SparkyFitness has "Use external BMR" turned on, so wherever its own figures include BMR they use appleRestingKcal in place of the formula and bmrFormulaKcal is unavailable. Turn that setting off in SparkyFitness to get the formula figure.',
        }),
    exerciseSource: cb.exerciseSource,
    // SparkyFitness's same-day projection of total burn from the device's
    // calories so far, only produced in its TDEE/smart goal-adjustment
    // modes. Not the adaptive TDEE (weight trend against intake): that is
    // get_weekly_rollup's tdee.
    tdeeProjection: cb.tdeeProjection ?? null,
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

// Exported for get_daily_summary (daily-summary.js), which needs the same
// per-day totals joined alongside every other domain's data.
export async function fetchNutritionDay(date) {
  return nutritionDayFrom(date, await getDailySummary(date));
}

// The same per-day totals plus that day's calorie and protein goals, for
// get_weekly_rollup (the goal can change day to day, e.g. in a deload).
export async function fetchNutritionDayWithGoals(date) {
  const summary = await getDailySummary(date);
  return {
    ...nutritionDayFrom(date, summary),
    goalKcal: summary.goals?.calories ?? null,
    goalProtein: summary.goals?.protein ?? null,
  };
}

function nutritionDayFrom(date, summary) {
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

export function registerNutritionTools(server) {
  server.registerTool(
    'get_nutrition_day',
    {
      title: 'Get nutrition for a day',
      description:
        "One day's SparkyFitness log: foods, water, calorie balance. bmrFormulaKcal is the formula BMR for energy balance (null, with bmrNote, under \"Use external BMR\"); appleRestingKcal is Apple's higher estimate, not measured. Adaptive TDEE: get_weekly_rollup.",
      inputSchema: {
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe('YYYY-MM-DD (default today).'),
      },
    },
    async ({ date }) => {
      const day = date ?? localIsoDate();
      // The check-in and preferences only add the BMR context; a failure
      // there leaves those fields null rather than losing the whole day.
      const [summary, checkIn, preferences] = await Promise.all([
        getDailySummary(day),
        getLatestCheckInOnOrBefore(day).catch(() => null),
        getUserPreferences().catch(() => null),
      ]);
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
        calorieBalance: summarizeCalorieBalance(summary.calorieBalance, { checkIn, preferences }),
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
        "Daily calorie, macro and water totals from SparkyFitness, with averages and goal adherence. Today is partial: true and left out of the averages.",
      inputSchema: { days: z.number().int().min(1).max(90).optional().describe('Days back (default 7).') },
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
}
