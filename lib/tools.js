import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerWorkoutTools } from './tools/workouts.js';
import { registerActivityTools } from './tools/activity.js';
import { registerVitalsTools } from './tools/vitals.js';
import { registerHrvTools } from './tools/hrv.js';
import { registerNutritionTools } from './tools/nutrition.js';
import { registerSleepTools } from './tools/sleep.js';

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

  return server;
}
