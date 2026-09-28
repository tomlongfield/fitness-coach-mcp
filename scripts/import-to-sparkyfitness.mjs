// One-off migration: imports the current openGym routines + weekly schedule
// into SparkyFitness's new workout-plan system (v1.7.2/1.7.3) as a trial.
// Not a permanent tool — run manually, once, and re-run only if you want a
// second attempt (it does not check for or skip anything already imported).
//
// Order matters and mirrors SparkyFitness's own referential requirements:
// exercises must exist before a preset can reference them, and presets must
// exist before a plan template's assignments can reference them.
//
//   1. POST /exercises      — one per distinct openGym exercise used in any
//                              routine, deduplicated by openGym's own id.
//   2. POST /workout-presets — one per openGym routine, referencing the UUIDs
//                              from step 1.
//   3. POST /workout-plan-templates — one weekly template, created INACTIVE,
//                              with day_of_week assignments referencing the
//                              preset ids from step 2.
//
// Field mapping (see classifyExercise/buildPresetExercise below for the
// exact rules): openGym's mode/weight/reps/sets/restSec map directly onto
// SparkyFitness's per-set reps/weight/rest_time, repeated across `sets`
// count entries (openGym has no per-set variation to preserve — every set
// of an exercise shares one target). Cardio (min+speed) maps to
// duration_distance sets (duration in seconds, distance derived as
// speed_kmh * hours). Things with no SparkyFitness equivalent (repsMin
// range, side/per-side, per-exercise note) are folded into the first set's
// `notes` text rather than silently dropped.

import { getState } from '../lib/opengym-client.js';
import { buildExerciseIndex } from '../lib/tools/workouts.js';
import { config } from '../lib/config.js';

const sparkyFetch = async (path, options = {}) => {
  const res = await fetch(`${config.sparkyFitnessBaseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${config.sparkyFitnessApiKey}`, ...(options.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SparkyFitness ${options.method || 'GET'} ${path} returned ${res.status}: ${body}`);
  }
  return res.json();
};

const createExercise = ({ name, category, modality }) => {
  const form = new FormData();
  // source is NOT NULL with no default — 'manual' matches what the
  // frontend's own "add exercise" form sends for a user-created library
  // entry (confirmed live: omitting it 500s with a not-null violation).
  form.append(
    'exerciseData',
    JSON.stringify({ name, category, modality, is_public: false, is_custom: true, source: 'manual' })
  );
  return sparkyFetch('/exercises', { method: 'POST', body: form });
};

const createWorkoutPreset = (payload) =>
  sparkyFetch('/workout-presets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

const createWorkoutPlanTemplate = (payload) =>
  sparkyFetch('/workout-plan-templates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

// Cardio (min+speed) -> duration_distance. Explicit time-under-tension
// (mode:'time') -> duration. Bodyweight with no added-weight target ->
// reps_only. Everything else -> weight_reps. Category is coarse (Cardio vs
// Strength) since openGym gives us no muscle-group metadata to import.
function classifyExercise(ex) {
  if (ex.min != null || ex.speed != null) return { category: 'Cardio', modality: 'duration_distance' };
  if (ex.mode === 'time') return { category: 'Strength', modality: 'duration' };
  if (ex.bodyweight && !(ex.weight > 0)) return { category: 'Strength', modality: 'reps_only' };
  return { category: 'Strength', modality: 'weight_reps' };
}

function buildPresetExercise(ex, exerciseUuid, sortOrder) {
  const { modality } = classifyExercise(ex);
  const setCount = ex.sets ?? 1;

  const noteParts = [];
  if (ex.repsMin != null && ex.reps != null && ex.repsMin !== ex.reps) {
    noteParts.push(`target ${ex.repsMin}-${ex.reps} reps`);
  }
  if (ex.side) noteParts.push('per side');
  if (ex.note) noteParts.push(ex.note);
  const firstSetNotes = noteParts.length ? noteParts.join('; ') : null;

  const sets = [];
  for (let i = 1; i <= setCount; i++) {
    const set = { set_number: i, set_type: 'Working Set' };
    if (modality === 'duration_distance') {
      set.duration = ex.min != null ? Math.round(ex.min * 60) : null;
      set.distance = ex.min != null && ex.speed != null ? Number(((ex.speed * ex.min) / 60).toFixed(2)) : null;
    } else if (modality === 'duration') {
      set.duration = ex.sec ?? null;
    } else {
      set.reps = ex.reps ?? null;
      set.weight = modality === 'reps_only' ? null : ex.weight ?? null;
    }
    if (ex.restSec != null) set.rest_time = ex.restSec;
    if (i === 1 && firstSetNotes) set.notes = firstSetNotes;
    sets.push(set);
  }

  // Default to 'manual' (no automatic progression) rather than leaving this
  // unset — confirmed live that an unset/null progression_mode gets the
  // server's own default of 'rep_goal' plus a fabricated 5kg increment,
  // neither of which openGym's routine data asked for. 'manual' is the one
  // mode where increment_type/increment_value are inert (SparkyFitness
  // still stores a default increment_value even when explicitly sent as
  // null — a real API quirk, harmless only because manual mode never acts
  // on it — see the import summary printed at the end).
  const presetExercise = {
    exercise_id: exerciseUuid,
    sort_order: sortOrder,
    progression_mode: 'manual',
    sets,
  };
  if (ex.prog !== 'off' && typeof ex.inc === 'number' && ex.inc > 0) {
    presetExercise.increment_type = 'weight';
    presetExercise.increment_value = ex.inc;
  }
  return presetExercise;
}

async function run() {
  const state = await getState();
  const exIndex = buildExerciseIndex(state);
  const routines = state.routines || [];

  // --- Step 1: exercises, deduplicated by openGym exercise id ---
  const uniqueExerciseIds = new Map(); // openGym id -> sample routine-exercise object
  for (const r of routines) {
    for (const ex of r.ex || []) {
      if (!uniqueExerciseIds.has(ex.id)) uniqueExerciseIds.set(ex.id, ex);
    }
  }

  console.log(`Creating ${uniqueExerciseIds.size} exercises in SparkyFitness...`);
  const exerciseUuidByOpenGymId = new Map();
  for (const [id, ex] of uniqueExerciseIds) {
    const name = exIndex.get(id) || id;
    const { category, modality } = classifyExercise(ex);
    const created = await createExercise({ name, category, modality });
    exerciseUuidByOpenGymId.set(id, created.id);
    console.log(`  ${name} (${category}/${modality}) -> ${created.id}`);
  }

  // --- Step 2: one preset per routine ---
  console.log(`\nCreating ${routines.length} workout presets...`);
  const presetIdByRoutineId = new Map();
  for (const r of routines) {
    const exercises = (r.ex || []).map((ex, i) =>
      buildPresetExercise(ex, exerciseUuidByOpenGymId.get(ex.id), i)
    );
    const created = await createWorkoutPreset({ name: r.name, workout_format: 'standard', exercises });
    presetIdByRoutineId.set(r.id, created.id);
    console.log(`  ${r.name} -> preset ${created.id} (${exercises.length} exercises)`);
  }

  // --- Step 3: weekly plan template, inactive, from state.week ---
  // state.week is keyed by JS Date.getDay() (0=Sunday..6=Saturday) with an
  // array of routine ids per day — the same convention SparkyFitness's own
  // day_of_week uses (both follow the standard JS/SQL weekday numbering).
  const assignments = [];
  for (const [dayStr, routineIds] of Object.entries(state.week || {})) {
    const day = Number(dayStr);
    for (const routineId of routineIds) {
      const presetId = presetIdByRoutineId.get(routineId);
      if (presetId) assignments.push({ day_of_week: day, workout_preset_id: presetId });
    }
  }

  console.log(`\nCreating weekly plan template (${assignments.length} day assignments, inactive)...`);
  const plan = await createWorkoutPlanTemplate({
    plan_name: 'Imported from openGym',
    schedule_type: 'weekly',
    entry_mode: 'prompt',
    is_active: false,
    assignments,
  });
  console.log(`  -> plan template ${plan.id}`);

  console.log('\nDone. Review in SparkyFitness\'s UI (Workouts -> Plans) before activating.');
}

run().catch((err) => {
  console.error('Import failed:', err.message);
  process.exit(1);
});
