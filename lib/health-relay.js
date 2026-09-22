import crypto from 'node:crypto';
import { config } from './config.js';
import { postHealthData } from './sparkyfitness-client.js';
import { localIsoDate } from './date-utils.js';

// Health Auto Export's own display name for this metric, normalized a few
// plausible ways (its docs don't commit to one spelling, and this endpoint
// is genuinely unverified against a live payload as of writing — see the
// debug logging below).
function normalizeMetricName(name) {
  return String(name || '').toLowerCase().replace(/[\s_]+/g, '');
}
const HRV_METRIC_NAMES = ['heart rate variability', 'hrv', 'heart rate variability sdnn'].map(normalizeMetricName);

function findHrvMetric(metrics) {
  return (metrics || []).find((m) => HRV_METRIC_NAMES.includes(normalizeMetricName(m.name)));
}

// Field names are a best guess (qty is Health Auto Export's most common
// convention for a simple numeric reading) — not confirmed against this
// specific metric. Tried in order; whichever is present and numeric wins.
const VALUE_FIELDS = ['qty', 'Avg', 'avg', 'value', 'Value'];
const DATE_FIELDS = ['date', 'Date', 'startDate', 'timestamp'];

function extractValue(point) {
  for (const f of VALUE_FIELDS) {
    const v = Number(point?.[f]);
    if (point?.[f] != null && !Number.isNaN(v)) return v;
  }
  return null;
}

function extractDate(point) {
  for (const f of DATE_FIELDS) {
    if (point?.[f]) {
      const d = new Date(point[f]);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

// One SparkyFitness /api/health-data entry per raw sample — no averaging.
// SparkyFitness stores each one as its own row (category frequency "All",
// verified live: two same-hour readings both survived with distinct ids and
// timestamps, not collapsed), so there's no reason to throw away the
// within-day signal here. date is derived from timestamp via the account's
// own timezone (localIsoDate), matching every other date computation in
// this connector, rather than trusting whatever calendar day the caller's
// own clock/timezone thinks a sample falls on.
function toEntry(value, date) {
  return { value: Number(value.toFixed(2)), type: 'HRV_SDNN', date: localIsoDate(date), timestamp: date.toISOString() };
}

function timingSafeEqualStrings(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  return bufA.length === bufB.length && crypto.timingSafeEqual(bufA, bufB);
}

// A caller that controls its own payload (e.g. an Apple Shortcut we wrote
// ourselves) doesn't need Health Auto Export's shape guessed at — it can
// send either one {value, timestamp?} reading or an array of them, already
// shaped the way it was measured. timestamp defaults to now if omitted.
function parseSimplePayload(body) {
  const readings = Array.isArray(body) ? body : [body];
  const entries = [];
  for (const r of readings) {
    const value = Number(r?.value);
    if (r?.value == null || Number.isNaN(value)) continue;
    const ts = r?.timestamp ? new Date(r.timestamp) : new Date();
    if (Number.isNaN(ts.getTime())) continue;
    entries.push({ value: Number(value.toFixed(2)), type: 'HRV_SDNN', date: localIsoDate(ts), timestamp: ts.toISOString() });
  }
  return entries.length ? entries : null;
}

/**
 * Accepts HRV from either of two payload shapes and forwards to
 * SparkyFitness's flat {value,type,date,timestamp} /api/health-data ingest
 * shape, one entry per raw reading (no daily averaging — see toEntry's
 * note):
 *
 *   1. Health Auto Export's fixed {data:{metrics:[{name,units,data}]}}
 *      export shape — the two don't overlap with SparkyFitness's shape at
 *      all (confirmed against both systems' real source/docs), so this is
 *      reshaped rather than passed through.
 *   2. A single {value, timestamp?} object, or an array of them, for
 *      callers that build their own payload (e.g. an Apple Shortcut) and
 *      so don't need shape 1's guesswork at all.
 *
 * Scoped to HRV only; add another route rather than generalizing this one
 * if a second metric is wanted later.
 *
 * Reachable only from the same nginx allowlist as /authorize (see
 * gym-mcp.tomlo.ng's config) — narrower than the rest of this server, which
 * also allows Claude's own connector CIDR. This route has no reason to be
 * reachable from there. HEALTH_RELAY_SECRET is a second, independent layer
 * on top of that network restriction, not a substitute for it — in
 * particular, it's what lets a phone-based caller (Shortcuts, or an app)
 * hold a narrow, write-only, HRV-only credential instead of the full
 * SparkyFitness API key, which can read everything.
 *
 * One-time setup this route depends on: SparkyFitness auto-creates a new
 * custom category with frequency "Daily" (one entry per day, silently
 * overwritten by the next post that day) — HRV_SDNN needs frequency "All"
 * (unlimited entries) instead, or every reading past the first each day
 * gets lost. See the README for the one-off PUT this needs.
 */
export function registerHealthRelayRoutes(app) {
  app.post('/health-relay/hrv', async (req, res) => {
    if (!config.healthRelaySecret) {
      res.status(503).json({ error: 'health_relay_disabled', message: 'HEALTH_RELAY_SECRET is not configured.' });
      return;
    }
    if (!timingSafeEqualStrings(req.headers['x-relay-secret'], config.healthRelaySecret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    let entries;
    const metrics = req.body?.data?.metrics;
    if (Array.isArray(metrics)) {
      console.log(`[health-relay] ${metrics.length} metric(s) in payload:`, metrics.map((m) => m.name));
      const hrvMetric = findHrvMetric(metrics);
      if (!hrvMetric) {
        console.log('[health-relay] no HRV metric matched; full payload:', JSON.stringify(req.body).slice(0, 4000));
        res.status(200).json({ message: 'No HRV metric found in this payload.', metricNamesPresent: metrics.map((m) => m.name) });
        return;
      }
      // First real run against a new sender: hit with ?debug=1 to log the
      // raw metric object and confirm its actual field names before
      // trusting the parsed output — VALUE_FIELDS/DATE_FIELDS above are a
      // best guess, not a confirmed shape.
      if (req.query.debug === '1') {
        console.log('[health-relay] raw HRV metric object:', JSON.stringify(hrvMetric).slice(0, 4000));
      }
      entries = (hrvMetric.data || [])
        .map((point) => {
          const value = extractValue(point);
          const date = extractDate(point);
          return value != null && date ? toEntry(value, date) : null;
        })
        .filter(Boolean);
      console.log(`[health-relay] parsed ${entries.length}/${(hrvMetric.data || []).length} raw sample(s)`);
      if (!entries.length) {
        res.status(200).json({
          message: 'HRV metric matched but no usable data points in it — check VALUE_FIELDS/DATE_FIELDS against ?debug=1 output.',
          rawSampleCount: (hrvMetric.data || []).length,
        });
        return;
      }
    } else {
      entries = parseSimplePayload(req.body);
      if (!entries) {
        console.log('[health-relay] unexpected payload shape:', JSON.stringify(req.body).slice(0, 2000));
        res.status(400).json({
          error: 'unexpected_payload',
          message: 'Expected body.data.metrics (Health Auto Export shape) or {value,timestamp?}/[{value,timestamp?}] (simple shape).',
        });
        return;
      }
    }

    const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
    if (dryRun) {
      res.status(200).json({ dryRun: true, wouldPost: entries });
      return;
    }

    try {
      const sparkyFitnessResult = await postHealthData(entries);
      res.status(200).json({ posted: entries, sparkyFitnessResult });
    } catch (err) {
      console.error('[health-relay] failed to post to SparkyFitness:', err);
      res.status(502).json({ error: 'sparkyfitness_post_failed', message: String(err.message || err) });
    }
  });
}
