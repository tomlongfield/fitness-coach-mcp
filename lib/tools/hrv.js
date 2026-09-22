import { z } from 'zod';
import { getCustomMeasurementRange } from '../sparkyfitness-client.js';
import { asJson } from './shared.js';

// Raw per-reading, not merged to one-per-day like fetchVitalsEntries
// (vitals.js) — HRV_SDNN's category is configured for multiple entries a
// day (frequency "All"), and folding them into a daily figure here would
// just be re-inventing the averaging get_vitals_trend deliberately doesn't
// do for this metric. Sorted chronologically so a consumer doesn't have to.
function summarizeHrvSample(e) {
  return { timestamp: e.timestamp, value: Number(e.value) };
}

// Exported for get_daily_summary (daily-summary.js), which buckets these
// into an overnight-window average per day.
export async function fetchHrvSamples(days) {
  const entries = await getCustomMeasurementRange('HRV_SDNN', days);
  return entries
    .map(summarizeHrvSample)
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
}

export function registerHrvTools(server) {
  server.registerTool(
    'get_hrv_samples',
    {
      title: 'Get heart rate variability samples',
      description:
        'Returns raw heart rate variability (HRV, SDNN, in ms) readings from Apple Health over a recent window — one entry per actual measurement, several a day, not one value per day like every other vitals field (see get_vitals_trend). Deliberately not pre-averaged or otherwise reduced: a single reading is noisy on its own (posture, activity, time since eating, and where in the day it landed all move it), and there is no established personal baseline for a new account yet, so summarizing here would just be presenting a guess as a fact. Fed by an Apple Shortcut posting through this connector\'s own relay, not a first-party SparkyFitness/Apple Health sync path — a day with no readings means the Shortcut didn\'t run that day, not that HRV was zero.',
      inputSchema: { days: z.number().int().min(1).max(365).optional().describe('Lookback window in days (default 14).') },
    },
    async ({ days }) => {
      const window = days ?? 14;
      const samples = await fetchHrvSamples(window);
      return asJson({ windowDays: window, unit: 'ms', sampleCount: samples.length, samples });
    }
  );
}
