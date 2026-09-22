import { z } from 'zod';
import { getSleepAnalytics } from '../sparkyfitness-client.js';
import { asJson } from './shared.js';

// stagePercentages is always {unspecified: 100} when the sync source doesn't
// report a deep/REM/light breakdown — only include it when some other stage
// actually has a nonzero share, otherwise it's pure noise.
function summarizeSleepDay(e) {
  const hasStageData = e.stagePercentages
    && Object.entries(e.stagePercentages).some(([stage, pct]) => stage !== 'unspecified' && pct > 0);
  return {
    date: e.date,
    asleepMin: Math.round(e.timeAsleep / 60),
    sessionDurationMin: Math.round(e.totalSleepDuration / 60),
    sleepScore: e.sleepScore,
    bedtime: e.earliestBedtime,
    wakeTime: e.latestWakeTime,
    sleepEfficiencyPct: Number(e.sleepEfficiency.toFixed(1)),
    sleepDebtHours: Number(e.sleepDebt.toFixed(2)),
    awakePeriods: e.awakePeriods,
    awakeMin: Math.round(e.totalAwakeDuration / 60),
    ...(hasStageData ? { stagePercentages: e.stagePercentages } : {}),
  };
}

async function fetchRawSleepEntries(days) {
  return (await getSleepAnalytics(days)).slice().sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
}

// Exported for get_daily_summary (daily-summary.js), which needs
// sleepScore joined alongside every other domain's data.
export async function fetchSleepEntries(days) {
  return (await fetchRawSleepEntries(days)).map(summarizeSleepDay);
}

export function registerSleepTools(server) {
  server.registerTool(
    'get_sleep_trend',
    {
      title: 'Get sleep trend',
      description:
        'Returns nightly sleep analytics from SparkyFitness (time asleep, session duration, sleep score, efficiency, sleep debt, bedtime/wake time, awakenings) over a recent window, plus averages across it.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14).') },
    },
    async ({ days }) => {
      const window = days ?? 14;
      // Averaged from raw seconds (rounded once at the end), not from the
      // already-per-day-rounded asleepMin — summing pre-rounded minutes and
      // rounding again would compound rounding error across the window.
      const rawEntries = await fetchRawSleepEntries(window);
      const summary = {
        windowDays: window,
        entryCount: rawEntries.length,
        avgAsleepMin: rawEntries.length
          ? Math.round(rawEntries.reduce((sum, e) => sum + e.timeAsleep, 0) / rawEntries.length / 60)
          : null,
        avgSleepScore: rawEntries.length
          ? Number((rawEntries.reduce((sum, e) => sum + e.sleepScore, 0) / rawEntries.length).toFixed(1))
          : null,
        entries: rawEntries.map(summarizeSleepDay),
      };
      return asJson(summary);
    }
  );
}
