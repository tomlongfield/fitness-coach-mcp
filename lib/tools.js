import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { config } from './config.js';
import { registerWorkoutTools } from './tools/workouts.js';
import { registerActivityTools } from './tools/activity.js';
import { registerVitalsTools } from './tools/vitals.js';
import { registerNutritionTools } from './tools/nutrition.js';
import { registerSleepTools } from './tools/sleep.js';
import { registerDailySummaryTools } from './tools/daily-summary.js';
import { registerLiftProgressionTools } from './tools/lift-progression.js';
import { registerWeeklyRollupTools } from './tools/weekly-rollup.js';
import { registerPlanTools } from './tools/plan.js';
import { registerTrainingAnalysisTools } from './tools/training-analysis.js';
import { registerMediaTools } from './tools/media.js';

// Local extensions: anything dropped in ./tools/local/ (gitignored — see
// that directory's own README) that exports a registerXTools(server)
// function is picked up automatically, the same convention every built-in
// domain module already follows. This is how a private data source (a
// journal, a second tracker, whatever) gets wired in without forking this
// repo or touching a single tracked file — `git pull` here never conflicts
// with it. Resolved once at startup (top-level await), not per request:
// buildServer() runs on every MCP call, and re-scanning the filesystem and
// re-importing on each one would be pure waste for something that can only
// change by restarting the process anyway.
const localToolsDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'local');
const localRegistrars = [];
// SKIP_LOCAL_TOOLS=1 leaves them out: the test suite runs without their env.
if (process.env.SKIP_LOCAL_TOOLS !== '1' && existsSync(localToolsDir)) {
  const files = readdirSync(localToolsDir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const mod = await import(`./tools/local/${file}`);
    for (const [name, value] of Object.entries(mod)) {
      if (name.startsWith('register') && typeof value === 'function') localRegistrars.push(value);
    }
  }
}

// Every tool this server registers only reads, from sources that are the
// user's own: declared once here rather than on each tool, so a local
// plugin gets it too. Claude runs a read-only tool without asking each
// time. A tool that one day writes must pass its own annotations, which
// override these.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

// Conventions every tool shares, said once here instead of in each tool's
// description. Lands in Claude's context alongside the tool list.
const INSTRUCTIONS = [
  'Personal training data: openGym is the strength-training log and plan (workouts, sets, routines, schedule); SparkyFitness holds what syncs from Apple Health (weight, sleep, vitals, nutrition, watch activity sessions).',
  `Dates are YYYY-MM-DD in ${config.timezone}; today's figures are partial while the day is in progress.`,
  'Missing data is null or absent, never 0: an absent heart rate or an unlogged day means no data, not a low value.',
  'Volume and top sets count completed work sets only (warm-ups excluded, drop-set drops included), as openGym\'s Stats does.',
  'Unilateral (per-side) exercises: a logged or planned rep count is the total of both sides; a top set is the weaker side, per side, once both sides are ticked; volume counts each limb.',
  'excludedFromProgression marks a workout or exercise the user flagged "Don\'t count for progression" (injury or rehab): context, not a regression.',
  'Estimated 1RM is a derived index: compare its direction across sessions, not its absolute value.',
].join(' ');

/**
 * Builds a fresh McpServer with every tool registered. Called once per
 * incoming request (see server.js) rather than reused across requests —
 * reusing a single server/transport across clients is exactly the pattern
 * behind CVE-2026-25536 in the MCP SDK's stateless HTTP mode.
 *
 * Each domain's tools, and the helpers/reshaping logic behind them, live in
 * their own module under ./tools/ rather than one file — e.g. workouts.js
 * for logged openGym workouts, plan.js for its schedule and next-session
 * preview, nutrition.js for SparkyFitness food/water,
 * vitals.js for the daily check-in/custom-measurement fields (HRV
 * included).
 */
export function buildServer() {
  const server = new McpServer({
    name: 'fitness-coach',
    version: '1.0.0',
    // Per the MCP spec (2025-11-25), Implementation.icons — src must be an
    // absolute URL or data: URI, so this is built from config.issuer rather
    // than a bare relative path. Client support for this field is still
    // patchy as of writing (see /public's favicon files for the fallback
    // that actually works today: Claude currently resolves a connector's
    // icon via its own domain favicon lookup, not this field), but it costs
    // nothing to advertise correctly for clients that do honor it.
    icons: [
      { src: `${config.issuer}/icon.svg`, mimeType: 'image/svg+xml' },
      { src: `${config.issuer}/icon-512.png`, mimeType: 'image/png', sizes: ['512x512'] },
    ],
  }, { instructions: INSTRUCTIONS });

  const registerTool = server.registerTool.bind(server);
  server.registerTool = (name, cfg, handler) =>
    registerTool(name, { ...cfg, annotations: { ...READ_ONLY, ...cfg.annotations } }, handler);

  registerWorkoutTools(server);
  registerActivityTools(server);
  registerVitalsTools(server);
  registerNutritionTools(server);
  registerSleepTools(server);
  registerDailySummaryTools(server);
  registerLiftProgressionTools(server);
  registerWeeklyRollupTools(server);
  registerPlanTools(server);
  registerTrainingAnalysisTools(server);
  registerMediaTools(server);
  for (const register of localRegistrars) register(server);

  return server;
}
