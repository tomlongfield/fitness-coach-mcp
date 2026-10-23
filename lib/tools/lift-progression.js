import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { daysAgoIsoDate } from '../date-utils.js';
import { asJson } from './shared.js';
import { buildExerciseIndex, buildExerciseBpIndex, getExerciseOccurrences } from './workouts.js';

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

// Excludes by body part ('bp' === 'cardio'), not by name — a custom cardio
// exercise (e.g. one created to keep a machine's mileage off the muscle
// map) still carries bp: 'cardio', so this survives a rename that a
// name-matching regex wouldn't. Bodyweight/timed movements (farmers walk,
// plyometrics, etc.) are left alone — they're a separate, lower-priority
// gap (see the tool description) and this tool should keep surfacing them,
// nulls and all, until that's addressed.
function isCardioMachine(exerciseId, exBpIndex) {
  return exBpIndex.get(exerciseId) === 'cardio';
}

export function registerLiftProgressionTools(server) {
  server.registerTool(
    'get_lift_progression_summary',
    {
      title: 'Get lift progression summary',
      description:
        "get_exercise_history for every exercise trained in the window at once: each with its sessions over time (date, top set weight and reps, topSetRpe, estimated 1RM, volume). Raw numbers, no progressing or stalled verdicts. Work sets only (warm-ups out, drop-set drops in); a per-side top set is its weaker side, with reps per side. Estimated 1RM is a derived index: compare its direction, not its absolute value. RPE logging began partway through the history, so older sessions have none. Sessions flagged don't-count are left out and counted in excludedOccurrenceCount. Cardio machines are left out; other non-lift movements (carries, plyometrics) appear with null fields.",
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 90).') },
    },
    async ({ days }) => {
      const window = days ?? 90;
      const sinceDate = daysAgoIsoDate(window);
      const state = await getState();
      const exIndex = buildExerciseIndex(state);
      const exBpIndex = buildExerciseBpIndex(state);
      const exerciseIds = collectExerciseIds(state, sinceDate);
      const exercises = [...exerciseIds]
        .filter((exerciseId) => !isCardioMachine(exerciseId, exBpIndex))
        .map((exerciseId) => {
          const inWindow = getExerciseOccurrences(state, exerciseId).filter((o) => o.date >= sinceDate);
          // Sessions marked "Don't count for progression" (injury/rehab
          // days) are left out, the same as openGym's own progression does
          // — counted rather than silently dropped, so a gap in the series
          // reads as deliberate.
          const occurrences = inWindow.filter((o) => !o.excludedFromProgression);
          const excludedOccurrenceCount = inWindow.length - occurrences.length;
          return {
            exerciseId,
            ...(exIndex.get(exerciseId) ? { exerciseName: exIndex.get(exerciseId) } : {}),
            occurrences,
            ...(excludedOccurrenceCount ? { excludedOccurrenceCount } : {}),
          };
        })
        .filter((e) => e.occurrences.length || e.excludedOccurrenceCount)
        .sort((a, b) => (a.exerciseName || a.exerciseId).localeCompare(b.exerciseName || b.exerciseId));
      return asJson({ windowDays: window, exerciseCount: exercises.length, exercises });
    }
  );
}
