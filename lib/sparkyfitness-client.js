import { config } from './config.js';

async function sparkyFetch(path) {
  const res = await fetch(`${config.sparkyFitnessBaseUrl}${path}`, {
    headers: { Authorization: `Bearer ${config.sparkyFitnessApiKey}` },
  });

  if (res.status === 401) {
    throw new Error(
      "SparkyFitness rejected this server's API key (401) — it may have been " +
      'revoked or disabled. Generate a new one under Settings → Developer & ' +
      'Integrations → API Key Management and update SPARKYFITNESS_API_KEY in ' +
      '.env, then restart this server.'
    );
  }
  if (!res.ok) {
    throw new Error(`SparkyFitness returned ${res.status} fetching ${path}`);
  }
  return res.json();
}

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

export async function getDailySummary(date) {
  return sparkyFetch(`/daily-summary?date=${date}`);
}

export async function getCheckInRange(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return sparkyFetch(`/measurements/check-in-measurements-range/${isoDate(start)}/${isoDate(end)}`);
}
