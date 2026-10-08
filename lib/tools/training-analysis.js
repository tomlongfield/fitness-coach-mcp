import { z } from 'zod';
import { getState } from '../opengym-client.js';
import { localIsoDate, daysAgoIsoDate } from '../date-utils.js';
import { asJson } from './shared.js';
import { normalizeState, customOf, exerciseOf, muscleName, round1 } from '../opengym-logic.js';
import { MUSCLES, loadOfWorkouts, loadOfWeeklyPlan, musclesOf } from '../vendor/opengym/muscles.js';
import { EXIDX } from '../vendor/opengym/exercises.js';
import { fatigueOf, strengthOf, LB_TO_KG } from '../vendor/opengym/recovery.js';
import { fatigueStateOf } from '../vendor/opengym/recovery-view.js';
import { isWarmupRow } from '../vendor/opengym/workout-model.js';
import { weekStartOf, weekKey } from '../vendor/opengym/format.js';
import { workoutDay } from '../vendor/opengym/history.js';
import { computeBalance } from '../vendor/opengym/structuralBalance.js';
import { TEMPLATES, DEFAULT_TEMPLATE_ID } from '../vendor/opengym/structuralBalanceTemplates.js';

// Upstream's loadOf() resolves an entry's muscles through its built-in
// catalogue index, which never holds this account's custom exercises — so
// their sets would score zero. Attaching the custom exercise to the entry
// lets loadOf's own "historical exercise" branch resolve it (the same fix
// openGym's own MCP applies in muscle_balance). A deleted custom keeps the
// muscle snapshot openGym froze onto the entry at log time, so only a
// *found* custom is attached.
function withCustomExercises(workouts, state) {
  return workouts.map((w) => ({
    ...w,
    entries: (w.entries || []).map((e) => {
      const c = e.exercise ? null : customOf(e.id, state);
      return c ? { ...e, exercise: c } : e;
    }),
  }));
}

function muscleRows(completed, planned) {
  return MUSCLES
    .filter((m) => (completed[m] || 0) > 0 || (planned?.[m] || 0) > 0)
    .map((m) => {
      const done = round1(completed[m]);
      const row = { muscle: muscleName(m), slug: m, completedSets: done };
      if (planned) {
        const target = round1(planned[m]);
        row.plannedSets = target;
        row.percentOfPlan = target > 0 ? Math.round((done / target) * 100) : null;
      }
      return row;
    })
    .sort((a, b) => b.completedSets - a.completedSets || (b.plannedSets || 0) - (a.plannedSets || 0));
}

// The Stats screen's bodyweight input to fatigueOf/strengthOf: the latest
// weigh-in logged in openGym, in kg (Stats.jsx's MuscleBalance).
function latestBodyweightKg(state) {
  const last = state.bodyweight.slice().sort((a, b) => String(a.d).localeCompare(String(b.d))).at(-1);
  if (!last || !(last.w > 0)) return null;
  return state.unit === 'lb' ? last.w * LB_TO_KG : last.w;
}

// When each muscle last got a completed work set — Stats.jsx's
// latestMuscleTraining, which isn't exported from a lib module upstream.
function lastTrainedByMuscle(workouts) {
  const latest = {};
  for (const w of workouts) {
    const ts = Number(w?.start || new Date(w?.d).getTime());
    if (!Number.isFinite(ts)) continue;
    for (const entry of w.entries || []) {
      if (!(entry.sets || []).some((s) => s?.done === true && !isWarmupRow(s))) continue;
      for (const slug of Object.keys(musclesOf(EXIDX[entry.id] || entry.exercise || entry))) {
        if (latest[slug] == null || ts > latest[slug]) latest[slug] = ts;
      }
    }
  }
  return latest;
}

const round2 = (n) => Math.round(n * 100) / 100;

export function registerTrainingAnalysisTools(server) {
  server.registerTool(
    'get_muscle_recovery',
    {
      title: 'Get muscle recovery',
      description:
        "Returns openGym's per-muscle fatigue/recovery map (the Stats screen's Recovery view), computed with openGym's own model so it matches the app. fatigue (0–1) is recent training stress: each completed work set adds stimulus scaled by its load relative to that muscle's own recent sessions, decaying with a 36-hour half-life; state is ready (< 0.25), recovering (0.25–0.5) or fatigued (> 0.5) — the app's own buckets. retainedStrength (0.5–1) is detraining: 1.0 for 14 days after a muscle was last trained, then halving its distance to the 0.5 floor every 28 days; a never-trained muscle sits at 0.5. lastTrained/daysSinceTrained come from the latest completed work set touching the muscle. Use this to judge what's ready to train today, or what's been neglected long enough to start losing strength — not as a measurement of soreness or injury. Muscles are sorted most fatigued first; fatigued/recovering/detrained list muscle names for a quick read.",
      inputSchema: {},
    },
    async () => {
      const state = normalizeState(await getState());
      const now = Date.now();
      const bodyweightKg = latestBodyweightKg(state);
      const opts = { bodyweightKg, unit: state.unit };
      const fatigue = fatigueOf(state.workouts, now, opts);
      const strength = strengthOf(state.workouts, now, opts);
      const lastTrained = lastTrainedByMuscle(state.workouts);
      const muscles = MUSCLES
        .map((m) => ({
          muscle: muscleName(m),
          slug: m,
          fatigue: round2(fatigue[m]),
          state: fatigueStateOf(fatigue[m]),
          retainedStrength: round2(strength[m]),
          lastTrained: lastTrained[m] != null ? localIsoDate(new Date(lastTrained[m])) : null,
          daysSinceTrained: lastTrained[m] != null ? Math.floor((now - lastTrained[m]) / 86400000) : null,
        }))
        .sort((a, b) => b.fatigue - a.fatigue || a.retainedStrength - b.retainedStrength);
      const named = (pred) => muscles.filter(pred).map((r) => r.muscle);
      return asJson({
        asOf: new Date(now).toISOString(),
        bodyweightKgUsed: bodyweightKg != null ? round1(bodyweightKg) : null,
        fatigued: named((r) => r.state === 'fatigued'),
        recovering: named((r) => r.state === 'recovering'),
        detrained: named((r) => r.retainedStrength < 1),
        muscles,
      });
    }
  );


  server.registerTool(
    'get_muscle_volume',
    {
      title: 'Get muscle volume',
      description:
        "Returns training volume per muscle in \"effective sets\", computed with openGym's own muscle mapping (the Stats screen's Muscle balance). A set credits its primary muscles fully and secondary muscles partially, so counts are fractional; only completed work sets count (warm-ups excluded). Weight lifted is deliberately not used — 100kg of leg press vs 12kg of lateral raises says nothing about which muscle worked harder. With no days given: this calendar week (the account's own week start), with plannedSets per muscle from the live plan (fixed-week routines plus each rotation session once) and percentOfPlan — the app's \"planned vs completed\" view. With days: a rolling window ending today, completed only (a plan is weekly, so there's nothing to compare a rolling window against). untrainedMuscles lists muscles with zero completed sets in the window.",
      inputSchema: {
        days: z.number().int().min(1).max(365).optional()
          .describe('Rolling window in days ending today. Omit for this calendar week with planned-vs-completed.'),
      },
    },
    async ({ days }) => {
      const state = normalizeState(await getState());
      const today = localIsoDate();
      let window;
      let inWindow;
      if (days == null) {
        const ws = weekStartOf(state);
        const thisWeek = weekKey(today, ws);
        inWindow = state.workouts.filter((w) => workoutDay(w) && weekKey(workoutDay(w), ws) === thisWeek);
        window = { kind: 'calendar_week', weekStarting: thisWeek, through: today };
      } else {
        // Inclusive of today, so days=7 is the 7 dates ending today.
        const since = daysAgoIsoDate(days - 1);
        inWindow = state.workouts.filter((w) => (workoutDay(w) || '') >= since && (workoutDay(w) || '') <= today);
        window = { kind: 'rolling', days, from: since, through: today };
      }
      const completed = loadOfWorkouts(withCustomExercises(inWindow, state));
      const planned = days == null ? loadOfWeeklyPlan(state) : null;
      return asJson({
        window,
        workoutCount: inWindow.length,
        muscles: muscleRows(completed, planned),
        untrainedMuscles: MUSCLES.filter((m) => !(completed[m] > 0)).map(muscleName),
      });
    }
  );

  server.registerTool(
    'get_structural_balance',
    {
      title: 'Get structural balance',
      description:
        "Compares lifts against each other using openGym's Structural Balance (Stats screen): published strength-ratio tables (Poliquin, Thibaudeau, ATG) that say e.g. an incline bench should be ~91% of a close-grip bench. Each role is a lift with a target: a percentage of an anchor lift's estimated 1RM (load-ratio), a percentage of bodyweight (bodyweight-ratio), or a rep count at bodyweight (rep-count). Per role: the exercise it reads (the user's best-data variant, or their chosen override), the best set it's based on, actualPct vs targetPct, and status balanced | borderline (within 5 points) | weak | no-data. needsAnchor means the lift is logged but its anchor lift isn't; needsBodyweight means the bodyweight log in openGym is empty. Defaults to the template selected in the app. Estimates come from logged sets (Epley), so treat a weak reading as a prompt to look, not a verdict — an untrained variant or a lift simply not tested heavy recently reads weak too.",
      inputSchema: {
        template: z.enum(Object.keys(TEMPLATES)).optional()
          .describe('Ratio table to use. Defaults to the one selected in the app.'),
      },
    },
    async ({ template }) => {
      const state = normalizeState(await getState());
      const templateId = template
        || (Object.prototype.hasOwnProperty.call(TEMPLATES, state.balanceTemplate) ? state.balanceTemplate : DEFAULT_TEMPLATE_ID);
      const tpl = TEMPLATES[templateId];
      const rolesById = new Map(tpl.roles.map((r) => [r.id, r]));
      const results = computeBalance(state, tpl).map((res) => {
        const role = rolesById.get(res.roleId);
        const exId = res.mappedExerciseId || res.configuredExerciseId;
        return {
          role: role.label,
          evaluationMode: role.evaluationMode,
          ...(role.anchorRoleId ? { anchor: rolesById.get(role.anchorRoleId)?.label } : {}),
          exerciseId: exId,
          exerciseName: exId ? exerciseOf(exId, state).n : null,
          ...(res.isOverridden ? { exerciseChosenByUser: true } : {}),
          // For a rep-count role upstream's targetPct is the rep target
          // itself and actualPct is already "% of that target", so its
          // percentage target is 100.
          targetPct: role.evaluationMode === 'rep-count' ? 100 : res.targetPct,
          ...(role.evaluationMode === 'rep-count' ? { targetReps: res.targetPct } : {}),
          actualPct: res.actualPct != null ? round1(res.actualPct) : null,
          status: res.status,
          ...(res.current
            ? {
                basedOn: {
                  date: res.current.d,
                  weight: res.current.w,
                  reps: res.current.r,
                  ...(res.current.estKg != null ? { estimated1RMKg: round1(res.current.estKg) } : {}),
                },
              }
            : {}),
          ...(res.needsAnchor ? { needsAnchor: true } : {}),
          ...(res.needsBodyweight ? { needsBodyweight: true } : {}),
        };
      });
      const weakest = results
        .filter((r) => r.actualPct != null && r.status !== 'balanced')
        .sort((a, b) => a.actualPct / a.targetPct - b.actualPct / b.targetPct)[0];
      return asJson({
        template: tpl.label,
        availableTemplates: Object.keys(TEMPLATES),
        unit: state.unit || 'kg',
        weakestLink: weakest ? weakest.role : null,
        roles: results,
      });
    }
  );
}
