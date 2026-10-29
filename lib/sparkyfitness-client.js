import { config } from './config.js';
import { localIsoDate, daysAgoIsoDate } from './date-utils.js';

const FETCH_TIMEOUT_MS = 15000;

// Several tools read the same days (the weekly rollup, the daily summary and
// recent workouts all fetch per-day entries), often within one Claude turn.
// A short cache, as openGym's client has, makes those one request each; the
// promise is kept, so concurrent calls for one path share it too. A failure
// is never cached. What can no longer change is kept longer (keepFor).
const CACHE_MS = 60 * 1000;
const PAST_DAY_CACHE_MS = 60 * 60 * 1000;
const HR_ZONES_CACHE_MS = 24 * 60 * 60 * 1000;
const cache = new Map(); // path -> { at, ms, promise }

// Exported for local plugins (lib/tools/local), so their SparkyFitness reads
// share this cache and the limit on requests in flight.
export function sparkyFetch(path, keepFor = () => CACHE_MS) {
  const now = Date.now();
  for (const [key, hit] of cache) if (now - hit.at >= hit.ms) cache.delete(key);
  let hit = cache.get(path);
  if (!hit) {
    hit = { at: now, ms: CACHE_MS, promise: fetchUncached(path) };
    cache.set(path, hit);
    hit.promise.then(
      (body) => { hit.ms = keepFor(body); },
      () => { if (cache.get(path) === hit) cache.delete(path); }
    );
  }
  // Each caller gets its own copy: a tool that sorts or annotates what it
  // got must not change what the next one reads.
  return hit.promise.then(structuredClone);
}

// A day's entries keep changing for a while: food is logged the next
// morning, and the Watch can sync a workout a day late. Earlier days don't.
// A keepFor for sparkyFetch.
export const keepDay = (date) => () => (date < daysAgoIsoDate(1) ? PAST_DAY_CACHE_MS : CACHE_MS);

// SparkyFitness gets no faster past about 4–6 requests in flight; beyond
// that each one just waits longer (timed on its server, 2026-10-29). Its
// API-key check also writes to the key's own row on every request, so one
// key's requests queue on that row. The limit holds across every tool
// running in this process. A request waiting to retry gives up its place.
const MAX_IN_FLIGHT = 4;
let inFlight = 0;
const waiting = [];

async function withSlot(fn) {
  if (inFlight < MAX_IN_FLIGHT) inFlight++;
  else await new Promise((resolve) => waiting.push(resolve)); // handed a slot
  try {
    return await fn();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else inFlight--;
  }
}

// SparkyFitness answers 500 ("timeout exceeded when trying to connect")
// when its database pool is briefly exhausted, e.g. by a long daily-summary
// window running alongside another tool. A short wait usually clears it.
// Each wait is randomised (0 to twice the figure), so requests that failed
// together don't all come back together.
const RETRY_DELAYS_MS = [300, 1000];

async function fetchUncached(path) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await withSlot(() => fetchOnce(path));
    } catch (err) {
      if (!err.retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt] * 2 * Math.random()));
    }
  }
}

async function fetchOnce(path) {
  let res;
  try {
    res = await fetch(`${config.sparkyFitnessBaseUrl}${path}`, {
      headers: { Authorization: `Bearer ${config.sparkyFitnessApiKey}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`SparkyFitness did not respond within ${FETCH_TIMEOUT_MS / 1000}s fetching ${path}.`);
    }
    throw err;
  }

  if (res.status === 401) {
    throw new Error(
      "SparkyFitness rejected this server's API key (401) — it may have been " +
      'revoked or disabled. Generate a new one under Settings → Developer & ' +
      'Integrations → API Key Management and update SPARKYFITNESS_API_KEY in ' +
      '.env, then restart this server.'
    );
  }
  if (!res.ok) {
    const err = new Error(`SparkyFitness returned ${res.status} fetching ${path}`);
    err.retryable = res.status >= 500;
    throw err;
  }
  return res.json();
}

export async function getDailySummary(date) {
  return sparkyFetch(`/daily-summary?date=${date}`, keepDay(date));
}

export async function getCheckInRange(days) {
  return sparkyFetch(`/measurements/check-in-measurements-range/${daysAgoIsoDate(days)}/${localIsoDate()}`);
}

export async function getSleepAnalytics(days) {
  return sparkyFetch(`/sleep/analytics?startDate=${daysAgoIsoDate(days)}&endDate=${localIsoDate()}`);
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
  return sparkyFetch(`/measurements/custom-measurements-range/${id}/${daysAgoIsoDate(days)}/${localIsoDate()}`);
}

// No date-range endpoint exists for exercise entries (confirmed against
// SparkyFitness's route list) — only per-day lookup, so a multi-day window
// means one request per day.
export async function getExerciseEntriesByDate(date) {
  return sparkyFetch(`/exercise-entries/by-date?selectedDate=${date}`, keepDay(date));
}

// Time in each heart-rate zone for one exercise entry. SparkyFitness derives
// these from the workout's heart-rate series (max HR estimated from the
// profile's date of birth) when the Watch uploads it, and stores them, so an
// entry synced without heart-rate samples has none — the same endpoint its
// own mobile app reads. Stored zones don't change, so they are kept a day;
// none yet may only mean the upload hasn't arrived, so that is asked again.
export async function getWorkoutHrZones(entryId) {
  const res = await sparkyFetch(
    `/generic-health/workout-hr-zones/${encodeURIComponent(entryId)}`,
    (body) => (body?.data?.length ? HR_ZONES_CACHE_MS : CACHE_MS)
  );
  return res?.data ?? [];
}

// Each check-in field's latest value on or before `date` (weight, height,
// body fat…), resolved field by field, except bmr: that one is the exact
// day's synced reading (Apple Health's resting energy) or null.
export async function getLatestCheckInOnOrBefore(date) {
  return sparkyFetch(`/measurements/check-in/latest-on-or-before-date?date=${date}`);
}

// bmr_algorithm, use_external_bmr and the rest of the account's settings.
export async function getUserPreferences() {
  return sparkyFetch('/user-preferences');
}

// SparkyFitness's adaptive TDEE as of `date`: its own estimate from weight
// trend against logged intake, with confidence and, when it lacks the data,
// a fallback figure and the reason.
export async function getAdaptiveTdee(date) {
  return sparkyFetch(`/adaptive-tdee?date=${date}`);
}
