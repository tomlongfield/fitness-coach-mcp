import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { localIsoDate } from '../date-utils.js';
import { asJson } from './shared.js';
import { normalizeState, exerciseOf, fillTemplate, policyName } from '../opengym-logic.js';
import { queueOf, queueView, queueNext, pinState, weekTally } from '../vendor/opengym/queue.js';
import { scheduleModeOf } from '../vendor/opengym/rotation.js';
import { effectiveRoutineIds, effectiveRoutine, lastEntryFor, modeOf, setLabel, exLine } from '../vendor/opengym/history.js';
import { isWarmupRow } from '../vendor/opengym/workout-model.js';
import { buildSessionEntries, startsFromLast } from '../vendor/opengym/session-start.js';

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// Always Monday-first in this tool's output, regardless of the account's own
// weekStart display preference (Sunday or Monday) — that's a UI ordering
// choice, not something worth making this tool's shape depend on.
const MONDAY_FIRST_ORDER = [1, 2, 3, 4, 5, 6, 0];

const isIsoDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T12:00:00Z`)) &&
  new Date(`${v}T12:00:00Z`).toISOString().slice(0, 10) === v;

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

function routineRef(state, id) {
  const r = state.routines.find((x) => x.id === id);
  return { id, name: r?.name ?? null, ...(r?.emoji ? { emoji: r.emoji } : {}) };
}

// state.week is keyed by JS Date.getDay() convention (0=Sunday..6=Saturday),
// each value an array of routine ids for that day (older states: one id).
// A day with no routines assigned has its key deleted entirely — a rest day.
function summarizeFixedWeek(state) {
  return MONDAY_FIRST_ORDER.map((d) => {
    const routines = [].concat(state.week[d] || [])
      .filter((id) => state.routines.some((r) => r.id === id))
      .map((id) => routineRef(state, id));
    return { day: WEEKDAY_NAMES[d], routines };
  });
}

// How a date's plan was decided — the same precedence as upstream's
// effectiveRoutineIds, named (mirrors openGym's own MCP get_week_plan).
function plannedBy(state, iso, ids, today) {
  const ov = state.dayPlan[iso];
  if (ov === 'rest') return 'rest_override';
  const pin = pinState(state, ov);
  if (pin === 'open') return 'pinned';
  if (!pin && ov && state.routines.some((r) => r.id === ov)) return 'override';
  if (ids.length && queueNext(state, iso, today) === ids[0]) return 'rotation';
  return ids.length ? 'weekday' : 'rest';
}

function summarizeRotation(state, today) {
  const view = queueView(state, today);
  if (!view) return null;
  const q = queueOf(state);
  // Ownership, as Plan.jsx decides it: a pass the app's own Rotation
  // feature made carries the saved rotation's id. Anything else was written
  // by an external planner through the API ("Externally managed" in the
  // app) and does not refill itself when complete — it waits for its writer.
  const appManaged = !!state.rotation && q.rotationId === state.rotation.id;
  const tally = weekTally(state, today);
  return {
    label: view.label || null,
    managedBy: appManaged ? 'app' : 'external',
    startsOn: view.startsOn,
    // The pass is set to begin on a future startsOn (e.g. next week's plan
    // already written) — sessions below are that pass, not the current one.
    waiting: view.waiting,
    complete: view.complete,
    // state: done | next (today's session, or the first undone one) |
    // pinned (moved to a specific date, see pinnedTo) | later
    sessions: view.items.map((i) => ({
      routineId: i.id,
      routineName: i.name,
      state: i.state,
      ...(i.on ? { pinnedTo: i.on } : {}),
    })),
    // The Home streak card's figure: this pass's sessions plus any weekday
    // routines planned alongside it, against what's been done.
    weekTally: tally,
  };
}

// Where a number on the session screen actually came from — ported from
// openGym's own MCP (mcp/src/tools.js sourceOf). A routine's own weight is
// the LAST fallback: the session takes this routine's last logged weight for
// the exercise (any routine's, if this one never trained it), then the
// confirmed working weight, and the progression policy then overrides that.
function sourceOf(state, cfg, plan, field, routine) {
  if (!plan || plan.kind === 'off') return 'routine_plan';
  const decided = plan.kind !== 'first' && plan[field] != null;
  if (decided) return field !== 'weight' && plan[field] === cfg[field] ? 'routine_plan' : 'progression';
  const last = lastEntryFor(state, cfg.id, routine?.id);
  if (field === 'reps') return startsFromLast(state) && last ? 'last_session' : 'routine_plan';
  if (last) return 'last_session';
  const conf = state.exWeights[cfg.id];
  return conf && conf.w > 0 ? 'confirmed_weight' : 'routine_plan';
}

function previewRoutine(state, routine) {
  const unit = state.unit || 'kg';
  // The same builder the app starts a session with, so prescription,
  // deloads, warm-up ramps and pyramid rows all come out as on screen.
  const built = buildSessionEntries(state, routine);
  const exercises = (routine.ex || []).map((cfg, i) => {
    const ex = exerciseOf(cfg.id, state);
    const mode = modeOf({ ...cfg, id: cfg.id });
    const plan = built[i].plan || {};
    const rows = built[i].sets || [];
    const firstWork = rows.find((s) => !isWarmupRow(s)) || {};
    const changed = [
      ...(mode === 'reps' && cfg.weight != null && (firstWork.w || 0) !== cfg.weight ? ['weight'] : []),
      ...(mode === 'reps' && (cfg.reps || 0) > 0 && (firstWork.r || 0) !== cfg.reps ? ['reps'] : []),
      ...(mode === 'time' && (cfg.sec || 0) > 0 && (firstWork.sec || 0) !== cfg.sec ? ['sec'] : []),
      ...(mode === 'cardio' && (cfg.min || 0) > 0 && (firstWork.min || 0) !== cfg.min ? ['min'] : []),
    ];
    const weightSource = sourceOf(state, cfg, plan, 'weight', routine);
    return {
      exerciseId: cfg.id,
      exerciseName: ex.n,
      mode,
      policy: plan.policy ?? null,
      policyName: plan.policy ? policyName(plan.policy) : null,
      planned: exLine(cfg, unit),
      prescription: {
        kind: plan.kind ?? null,
        ...(plan.weight != null ? { weight: plan.weight } : {}),
        ...(plan.reps != null ? { reps: plan.reps } : {}),
        ...(plan.sets != null ? { sets: plan.sets } : {}),
        ...(plan.sec != null ? { sec: plan.sec } : {}),
        why: Array.isArray(plan.why) ? fillTemplate(plan.why[0], plan.why.slice(1)) : null,
      },
      openingSets: rows.map((s) => ({
        ...(isWarmupRow(s) ? { warmup: true } : {}),
        ...(s.type && s.type !== 'straight' ? { type: s.type } : {}),
        label: setLabel(cfg.id, { ...s, done: undefined }, { ...cfg, id: cfg.id }),
      })),
      weightSource,
      ...(mode === 'reps' ? { repsSource: sourceOf(state, cfg, plan, 'reps', routine) } : {}),
      changedFromPlan: changed,
      ...(cfg.sg ? { supersetGroup: cfg.sg } : {}),
    };
  });
  return {
    routineId: routine.id,
    routineName: routine.name,
    unit,
    excludedFromProgression: routine.excludeFromProgression === true,
    // The profile's "Planned sessions start from" setting.
    startsFrom: startsFromLast(state) ? 'last_session' : 'plan',
    overriddenCount: exercises.filter((e) => e.changedFromPlan.length).length,
    exercises,
  };
}

export function registerPlanTools(server) {
  server.registerTool(
    'get_weekly_schedule',
    {
      title: 'Get weekly schedule',
      description:
        "Returns openGym's training plan, resolved the way the app itself resolves it. scheduleMode is 'week' (fixed weekdays) or 'rotation' (a loop of sessions done in order on whatever days you train — A, B, C, A… — so a missed day doesn't shift the plan). next7Days is the authoritative answer to \"what's planned when\": each date from today with its routine(s) and plannedBy — rotation (the next undone rotation session), pinned (a rotation session moved to that date), override (a one-off routine for that date), rest_override, weekday (the fixed-week plan) or rest. rotation, when one is live, lists every session in the current pass with state done/next/pinned/later, whether the pass is complete or waiting on a future startsOn, managedBy 'app' (the user's own rotation, refills itself) or 'external' (written by a planner through the API, waits for its writer), and weekTally {done, planned}. fixedWeek is the Monday-first weekday plan; in rotation mode it holds only routines planned beside the rotation. This is the plan, not logged history — cross-reference get_recent_workouts for what actually happened.",
      inputSchema: {},
    },
    async () => {
      const state = normalizeState(await getState());
      const today = localIsoDate();
      const next7Days = Array.from({ length: 7 }, (_, i) => {
        const iso = addDays(today, i);
        const ids = effectiveRoutineIds(state, iso, today);
        return {
          date: iso,
          day: WEEKDAY_NAMES[new Date(`${iso}T12:00:00Z`).getUTCDay()],
          routines: ids.map((id) => routineRef(state, id)),
          plannedBy: plannedBy(state, iso, ids, today),
        };
      });
      return asJson({
        today,
        scheduleMode: scheduleModeOf(state),
        next7Days,
        rotation: summarizeRotation(state, today),
        fixedWeek: summarizeFixedWeek(state),
      });
    }
  );

  server.registerTool(
    'preview_next_session',
    {
      title: 'Preview next session',
      description:
        "Previews what openGym will actually put on screen when a routine is started — after its progression policy and the training history have overridden the routine's stored targets — using openGym's own session builder, so it matches the app. A routine storing \"squat 3×8 @ 60kg\" can open at 65kg because linear progression added weight, or lower after a deload; get_current_routines only shows the stored target. Use this before suggesting a weight, or to judge whether progression is moving. Per exercise: planned (the routine's own target), prescription (the policy's decision and its reason, in why), openingSets (warm-ups flagged), weightSource/repsSource (progression | last_session | confirmed_weight | routine_plan) and changedFromPlan. Defaults to the routine scheduled for today (rotation-aware); pass routineId for a specific routine, or date to preview what's scheduled on another day. Returns restDay: true when nothing is scheduled.",
      inputSchema: {
        routineId: z.string().min(1).optional().describe('Routine id (from get_current_routines or get_weekly_schedule). Defaults to the routine scheduled for `date`.'),
        date: z.string().refine(isIsoDate, 'must be a real YYYY-MM-DD date').optional()
          .describe('Date the session would be started, YYYY-MM-DD. Only used to pick the scheduled routine when routineId is omitted. Defaults to today.'),
      },
    },
    async ({ routineId, date }) => {
      const state = normalizeState(await getState());
      const iso = date || localIsoDate();
      let routine;
      if (routineId) {
        routine = state.routines.find((r) => r.id === routineId);
        if (!routine) throw new Error(`No routine with id ${JSON.stringify(routineId)} — see get_current_routines.`);
      } else {
        routine = effectiveRoutine(state, iso);
        if (!routine) return asJson({ date: iso, restDay: true, note: 'No routine is scheduled for this date.' });
      }
      return asJson({ date: iso, ...previewRoutine(state, routine) });
    }
  );
}
