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

export async function getSleepAnalytics(days) {
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return sparkyFetch(`/sleep/analytics?startDate=${isoDate(start)}&endDate=${isoDate(end)}`);
}

// SparkyFitness auto-creates a "custom measurement category" for any synced
// health metric it has no dedicated column for (e.g. Apple Health's
// LeanBodyMass, RestingHeartRate — confirmed against SparkyFitness's own
// source, which explicitly excludes these from its fixed check-in schema).
// Reading one back means resolving its name to a category id first, so we
// cache the category list briefly rather than doing that lookup on every
// single call for every tracked metric.
let categoryCache = { at: 0, byName: new Map() };
const CATEGORY_CACHE_MS = 5 * 60 * 1000;

async function getCategoryIdByName(name) {
  if (Date.now() - categoryCache.at > CATEGORY_CACHE_MS) {
    const categories = await sparkyFetch('/measurements/custom-categories');
    categoryCache = { at: Date.now(), byName: new Map(categories.map((c) => [c.name, c.id])) };
  }
  return categoryCache.byName.get(name);
}

// Returns [] rather than throwing when the category doesn't exist yet (e.g.
// a metric that hasn't synced from Apple Health for this account) — that's
// a legitimate "no data" state, not an error.
export async function getCustomMeasurementRange(categoryName, days) {
  const id = await getCategoryIdByName(categoryName);
  if (!id) return [];
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return sparkyFetch(`/measurements/custom-measurements-range/${id}/${isoDate(start)}/${isoDate(end)}`);
}

// No date-range endpoint exists for exercise entries (confirmed against
// SparkyFitness's route list) — only per-day lookup, so a multi-day window
// means one request per day.
export async function getExerciseEntriesByDate(date) {
  return sparkyFetch(`/exercise-entries/by-date?selectedDate=${date}`);
}
