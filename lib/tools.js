import { readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWorkoutTools } from './tools/workouts.js';
import { registerActivityTools } from './tools/activity.js';
import { registerVitalsTools } from './tools/vitals.js';
import { registerHrvTools } from './tools/hrv.js';
import { registerNutritionTools } from './tools/nutrition.js';
import { registerSleepTools } from './tools/sleep.js';
import { registerDailySummaryTools } from './tools/daily-summary.js';
import { registerLiftProgressionTools } from './tools/lift-progression.js';

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
if (existsSync(localToolsDir)) {
  const files = readdirSync(localToolsDir).filter((f) => f.endsWith('.js'));
  for (const file of files) {
    const mod = await import(`./tools/local/${file}`);
    for (const [name, value] of Object.entries(mod)) {
      if (name.startsWith('register') && typeof value === 'function') localRegistrars.push(value);
    }
  }
}

/**
 * Builds a fresh McpServer with every tool registered. Called once per
 * incoming request (see server.js) rather than reused across requests —
 * reusing a single server/transport across clients is exactly the pattern
 * behind CVE-2026-25536 in the MCP SDK's stateless HTTP mode.
 *
 * Each domain's tools, and the helpers/reshaping logic behind them, live in
 * their own module under ./tools/ rather than one file — e.g. workouts.js
 * for everything openGym-sourced, nutrition.js for SparkyFitness food/water,
 * vitals.js for the daily check-in/custom-measurement fields, hrv.js
 * specifically (see its own note for why HRV isn't in vitals.js).
 */
export function buildServer() {
  const server = new McpServer({ name: 'fitness-coach', version: '1.0.0' });

  registerWorkoutTools(server);
  registerActivityTools(server);
  registerVitalsTools(server);
  registerHrvTools(server);
  registerNutritionTools(server);
  registerSleepTools(server);
  registerDailySummaryTools(server);
  registerLiftProgressionTools(server);
  for (const register of localRegistrars) register(server);

  return server;
}
