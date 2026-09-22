import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { daysAgoIsoDate } from '../date-utils.js';
import { asJson } from './shared.js';
import { buildExerciseIndex, getExerciseOccurrences } from './workouts.js';

// Every exercise id logged in at least one workout on or after `sinceDate`
// — "tracked" just means "actually logged in the window". There's no
// separate registry of tracked exercises anywhere in openGym's data model
// to consult instead.
function collectExerciseIds(state, sinceDate) {
  const ids = new Set();
  for (const w of state.workouts || []) {
    if (w.d < sinceDate) continue;
    for (const entry of w.entries || []) {
      if (entry.id) ids.add(entry.id);
    }
  }
  return ids;
}

export function registerLiftProgressionTools(server) {
  server.registerTool(
    'get_lift_progression_summary',
    {
      title: 'Get lift progression summary',
      description:
        'Returns every exercise trained within the window, each with its full occurrence time series (date, top set weight/reps, topSetRpe where logged, estimated 1RM, volume) — the same per-occurrence shape get_exercise_history returns for one exercise, but across every exercise at once. Use this instead of pulling get_recent_workouts for a wide window and parsing it by hand when reviewing progress across a whole program rather than one lift. Deliberately raw numbers only, no stalled/progressing/regressing classification — that judgment needs context (program phase, fatigue, intent) this connector doesn\'t have, so it\'s left to whoever\'s reading this. "RPE at similar load" isn\'t pre-computed either: filter one exercise\'s occurrences to a comparable topWeight and read topSetRpe across them yourself. RPE logging only began partway through this account\'s history, so expect topSetRpe nulls on older occurrences even for exercises trained throughout.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 90).') },
    },
    async ({ days }) => {
      const window = days ?? 90;
      const sinceDate = daysAgoIsoDate(window);
      const state = await getState();
      const exIndex = buildExerciseIndex(state);
      const exerciseIds = collectExerciseIds(state, sinceDate);
      const exercises = [...exerciseIds]
        .map((exerciseId) => ({
          exerciseId,
          ...(exIndex.get(exerciseId) ? { exerciseName: exIndex.get(exerciseId) } : {}),
          occurrences: getExerciseOccurrences(state, exerciseId).filter((o) => o.date >= sinceDate),
        }))
        .sort((a, b) => (a.exerciseName || a.exerciseId).localeCompare(b.exerciseName || b.exerciseId));
      return asJson({ windowDays: window, exerciseCount: exercises.length, exercises });
    }
  );
}
