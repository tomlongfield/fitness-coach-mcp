import { config } from './config.js';

// The whole app state is one blob (per the openGym spec). We fetch it once
// and let each tool slice out what it needs, rather than one round-trip per
// tool call. A short cache keeps a burst of tool calls within one Claude
// turn from hitting openGym repeatedly.
let cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;
const FETCH_TIMEOUT_MS = 15000;

export async function getState() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  let res;
  try {
    res = await fetch(`${config.openGymBaseUrl}/api/data`, {
      headers: { Authorization: `Bearer ${config.openGymToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`openGym did not respond within ${FETCH_TIMEOUT_MS / 1000}s fetching /api/data.`);
    }
    throw err;
  }

  if (res.status === 401) {
    throw new Error(
      'openGym rejected this server\'s bearer token (401) — it has likely expired. ' +
      'Re-pair (POST /api/pair/create from a signed-in browser tab, then /api/pair/redeem) ' +
      'and update OPENGYM_BEARER_TOKEN in .env, then restart this server.'
    );
  }
  if (!res.ok) {
    throw new Error(`openGym returned ${res.status} fetching /api/data`);
  }

  const body = await res.json();
  if (!body.state) {
    throw new Error('openGym has no synced state for this account yet.');
  }

  cache = { at: Date.now(), data: body.state };
  return body.state;
}

// One stored photo/video by its SHA-256 (the `hash` of a MediaRef in the
// state blob). Not cached: these are only fetched when a tool is asked to
// show them, and openGym itself marks them no-store. Returns the bytes as
// base64 plus the server-sniffed content type.
export async function getMedia(hash) {
  if (!/^[0-9a-f]{64}$/.test(hash)) throw new Error(`Not a media hash: ${hash}`);
  let res;
  try {
    res = await fetch(`${config.openGymBaseUrl}/api/media/${hash}`, {
      headers: { Authorization: `Bearer ${config.openGymToken}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') {
      throw new Error(`openGym did not respond within ${FETCH_TIMEOUT_MS / 1000}s fetching media ${hash}.`);
    }
    throw err;
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`openGym returned ${res.status} fetching media ${hash}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { mimeType: (res.headers.get('content-type') || '').split(';')[0].trim(), data: bytes.toString('base64'), size: bytes.length };
}
