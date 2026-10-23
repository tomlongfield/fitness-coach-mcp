import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { getCheckInRange, getAdaptiveTdee } from '../sparkyfitness-client.js';
import { localIsoDate } from '../date-utils.js';
import { asJson, mapWithConcurrency, DEFAULT_FETCH_CONCURRENCY } from './shared.js';
import { fetchNutritionDayWithGoals } from './nutrition.js';
import { summarizeWorkoutRpe } from './daily-summary.js';
import { buildExerciseIndex, buildExerciseBpIndex, topSetOf } from './workouts.js';
import { entryExcluded, isPerSide } from '../vendor/opengym/history.js';
import { normalizeRepRange } from '../vendor/opengym/rep-range.js';

const SCHEMA_VERSION = 1;
const DEFAULT_BIG_DAY_RATIO = 1.35;
const DEFAULT_LOW_DAY_RATIO = 0.7;
const DEFAULT_RPE_TRIGGER = 9.5;
const SLOPE_WINDOW_DAYS = 28;
const SLOPE_MIN_N = 7;

const round = (n, dp) => (n == null ? null : Number(n.toFixed(dp)));
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

// Calendar arithmetic on YYYY-MM-DD strings (local dates already), in UTC so
// the host's own timezone never shifts a day.
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
const dayNumber = (iso) => Date.parse(`${iso}T00:00:00Z`) / 86400000;
function mondayOf(iso) {
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(iso, -((dow + 6) % 7));
}

// Ordinary least squares of weight against day number. kg/day × 7.
function weightSlope(readings) {
  const n = readings.length;
  if (n < SLOPE_MIN_N) return null;
  const xs = readings.map((r) => dayNumber(r.date));
  const ys = readings.map((r) => r.weight);
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
  }
  if (!sxx) return null;
  return { kgPerWeek: round((sxy / sxx) * 7, 3), n, from: readings[0].date, to: readings[n - 1].date };
}

function summarizeWeight(readings, from, to, prevMean) {
  const inWeek = readings.filter((r) => r.date >= from && r.date <= to);
  const weights = inWeek.map((r) => r.weight);
  const m = mean(weights);
  // The 28 days ending at the latest weigh-in on or before the week's end
  // (today's counts: a morning weight is complete once taken).
  const upTo = readings.filter((r) => r.date <= to);
  const last = upTo[upTo.length - 1];
  const slopeReadings = last ? upTo.filter((r) => r.date >= addDays(last.date, -SLOPE_WINDOW_DAYS)) : [];
  return {
    n: inWeek.length,
    mean: round(m, 2),
    min: weights.length ? Math.min(...weights) : null,
    max: weights.length ? Math.max(...weights) : null,
    deltaVsPrevWeekMean: m != null && prevMean != null ? round(m - prevMean, 2) : null,
    slope28d: weightSlope(slopeReadings),
    _mean: m,
  };
}

function summarizeNutrition(days, { bigDayKcal, lowDayKcal }) {
  const logged = days.filter((d) => d.calories != null);
  const goals = days.filter((d) => d.goalKcal != null);
  const threshold = (d, fixed, ratio) => fixed ?? (d.goalKcal != null ? d.goalKcal * ratio : null);
  return {
    daysLogged: logged.length,
    unloggedDates: days.filter((d) => d.calories == null).map((d) => d.date),
    mean: {
      kcal: round(mean(logged.map((d) => d.calories)), 0),
      protein: round(mean(logged.map((d) => d.protein).filter((v) => v != null)), 1),
    },
    goal: {
      kcal: round(mean(goals.map((d) => d.goalKcal)), 0),
      protein: round(mean(goals.map((d) => d.goalProtein).filter((v) => v != null)), 1),
    },
    bigDayDates: logged
      .filter((d) => { const t = threshold(d, bigDayKcal, DEFAULT_BIG_DAY_RATIO); return t != null && d.calories > t; })
      .map((d) => d.date),
    lowDayDates: logged
      .filter((d) => { const t = threshold(d, lowDayKcal, DEFAULT_LOW_DAY_RATIO); return t != null && d.calories < t; })
      .map((d) => d.date),
  };
}

const routineNameOf = (state, w, entry) =>
  state.routines.find((r) => r.id === (entry?.rid || w.routineId))?.name ?? w.name ?? null;

// Each weighted exercise occurrence, oldest first, grouped by
// routine + exercise: the same exercise in two routines is two lifts.
// "Don't count for progression" occurrences and cardio are left out; an
// entry with no completed weighted work set (bodyweight, timed) is skipped.
function liftHistory(state) {
  const bp = buildExerciseBpIndex(state);
  const byKey = new Map();
  const workouts = [...(state.workouts || [])].sort((a, b) => (a.start || 0) - (b.start || 0));
  for (const w of workouts) {
    for (const entry of w.entries || []) {
      if (!entry.id || bp.get(entry.id) === 'cardio' || entryExcluded(w, entry)) continue;
      const top = topSetOf(entry.sets);
      if (!top || !(top.w > 0)) continue;
      const routine = routineNameOf(state, w, entry);
      const key = `${routine}\u0000${entry.id}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push({ date: w.d, routine, w, entry, top });
    }
  }
  return byKey;
}

function changeOf(cur, prev) {
  if (!prev) return 'first';
  if (cur.w > prev.w) return 'weight_up';
  if (cur.w < prev.w) return 'weight_down';
  if (cur.r > prev.r) return 'reps_up';
  if (cur.r < prev.r) return 'reps_down';
  return 'same';
}

// The routine's rep range as it stood for that session: entry.planned is
// the routine's own prescription saved with the session (entry.target is
// only that session's goal inside the range), falling back to the
// routine's current settings for older sessions saved without it. Per side
// for unilateral work: openGym stores both bounds as the two sides' total.
function repRangeOf(state, w, entry) {
  const routine = state.routines.find((r) => r.id === (entry.rid || w.routineId));
  const current = routine?.ex?.find((e) => e.id === entry.id);
  const cfg = entry.planned?.repsMin != null ? entry.planned : current;
  if (!cfg || cfg.repsMin == null || !(cfg.reps > 0)) return null;
  const perSide = isPerSide(entry.target) || isPerSide(current);
  const r = normalizeRepRange(cfg.reps, cfg.repsMin, perSide ? 2 : 1);
  return perSide ? { min: r.repsMin / 2, max: r.reps / 2 } : { min: r.repsMin, max: r.reps };
}

const fmtTop = (s) => (s ? `${s.w}x${s.r}` : null);

function summarizeLifts(state, from, to) {
  const names = buildExerciseIndex(state);
  const out = [];
  for (const occ of liftHistory(state).values()) {
    occ.forEach((o, i) => {
      if (o.date < from || o.date > to) return;
      const prev = occ[i - 1];
      let run = 1;
      for (let j = i; j > 0; j--) {
        const a = occ[j].top;
        const b = occ[j - 1].top;
        if (a.w === b.w && a.r <= b.r) run++;
        else break;
      }
      const range = repRangeOf(state, o.w, o.entry);
      out.push({
        date: o.date,
        exercise: names.get(o.entry.id) ?? o.entry.id,
        routine: o.routine,
        top: fmtTop(o.top),
        topRpe: o.top.rpe ?? null,
        prev: fmtTop(prev?.top),
        prevDate: prev?.date ?? null,
        change: changeOf(o.top, prev?.top),
        consecutiveSameTopSet: run,
        repRange: range,
        atTopOfRange: range ? o.top.r >= range.max : null,
      });
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || String(a.routine).localeCompare(String(b.routine)));
}

function summarizeTdee(t) {
  if (!t) return { kcal: null, confidence: null, isFallback: null };
  return {
    kcal: t.tdee != null ? Math.round(t.tdee) : null,
    confidence: t.confidence ?? null,
    isFallback: t.isFallback ?? null,
    ...(t.fallbackReason ? { fallbackReason: t.fallbackReason } : {}),
    ...(t.daysOfData != null ? { daysOfData: t.daysOfData } : {}),
  };
}

export function registerWeeklyRollupTools(server) {
  server.registerTool(
    'get_weekly_rollup',
    {
      title: 'Get weekly rollup',
      description:
        "Weekly numbers, Monday–Sunday, newest first; the current week is partial. slope28d: least-squares kg/week over 28 days (null under 7 readings). nutrition leaves out today. sessions use the routine's current name. lifts sits on the newest complete week only, covering it and the current week: top and prev are \"weightxreps\" of the heaviest work set, the hardest if tied, with topRpe its RPE (per-side: weaker side, reps per side; prev is the last time in that routine). tdee isFallback: a formula estimate.",
      inputSchema: {
        weeks: z.number().int().min(1).max(12).optional().describe('Default 4.'),
        bigDayKcal: z.number().positive().optional().describe('Default 1.35 × the day\'s goal.'),
        lowDayKcal: z.number().positive().optional().describe('Default 0.7 × the day\'s goal.'),
        rpeTrigger: z.number().min(1).max(10).optional().describe('Default 9.5.'),
      },
    },
    async ({ weeks = 4, bigDayKcal, lowDayKcal, rpeTrigger = DEFAULT_RPE_TRIGGER }) => {
      const today = localIsoDate();
      const currentMonday = mondayOf(today);
      const weekList = Array.from({ length: weeks }, (_, i) => {
        const from = addDays(currentMonday, -7 * i);
        return { from, to: addDays(from, 6), partial: i === 0 };
      });
      const oldestFrom = weekList[weeks - 1].from;
      // Weight back far enough for the oldest week's previous-week mean and
      // its 28-day slope.
      const weightDays = Math.round(dayNumber(today) - dayNumber(oldestFrom)) + 7 + SLOPE_WINDOW_DAYS;
      const nutritionDates = [];
      for (let d = oldestFrom; d < today; d = addDays(d, 1)) nutritionDates.push(d);

      const [checkIns, nutritionDays, state, tdees] = await Promise.all([
        getCheckInRange(weightDays),
        mapWithConcurrency(nutritionDates, DEFAULT_FETCH_CONCURRENCY, fetchNutritionDayWithGoals),
        getState(),
        mapWithConcurrency(weekList, DEFAULT_FETCH_CONCURRENCY, (w) =>
          getAdaptiveTdee(w.partial ? today : w.to).catch(() => null)
        ),
      ]);

      const readings = checkIns
        .filter((e) => e.weight != null)
        .map((e) => ({ date: e.entry_date, weight: Number(e.weight) }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const liftsHost = weeks > 1 ? 1 : 0;
      const result = weekList.map((wk, i) => {
        const prevFrom = addDays(wk.from, -7);
        const prevWeek = readings.filter((r) => r.date >= prevFrom && r.date < wk.from).map((r) => r.weight);
        const { _mean, ...weight } = summarizeWeight(readings, wk.from, wk.to, mean(prevWeek));
        const sessions = (state.workouts || [])
          .filter((w) => w.d >= wk.from && w.d <= wk.to)
          .sort((a, b) => (a.start || 0) - (b.start || 0))
          .map((w) => {
            const rpe = summarizeWorkoutRpe(w);
            return { date: w.d, routine: routineNameOf(state, w), firstSetRpe: rpe?.firstSetRpe ?? null, maxRpe: rpe?.maxRpe ?? null };
          });
        return {
          week: { from: wk.from, to: wk.to, partial: wk.partial },
          weight,
          nutrition: summarizeNutrition(
            nutritionDays.filter((d) => d.date >= wk.from && d.date <= wk.to),
            { bigDayKcal, lowDayKcal }
          ),
          sessions,
          sessionsOpeningAtOrAboveRpeTrigger: sessions.filter((s) => s.firstSetRpe != null && s.firstSetRpe >= rpeTrigger).length,
          ...(i === liftsHost ? { lifts: summarizeLifts(state, wk.from, weekList[0].to) } : {}),
          tdee: summarizeTdee(tdees[i]),
        };
      });

      return asJson({
        schemaVersion: SCHEMA_VERSION,
        today,
        thresholds: { bigDayKcal: bigDayKcal ?? `${DEFAULT_BIG_DAY_RATIO} x daily goal`, lowDayKcal: lowDayKcal ?? `${DEFAULT_LOW_DAY_RATIO} x daily goal`, rpeTrigger },
        weeks: result,
      });
    }
  );
}
