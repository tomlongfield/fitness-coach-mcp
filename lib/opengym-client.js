import { config } from './config.js';
import { loadJson, saveJson } from './store.js';

// openGym session tokens are `<uid>:<expiry ms>:<version>.<hmac>` and last
// 90 days (its SESSION_DAYS). Since v1.4.0 openGym renews a bearer token
// past half its life: GET /api/me then answers with a fresh `token`. This
// server asks at most twice a day and keeps the newest token it has seen in
// data/opengym-token.json, so OPENGYM_BEARER_TOKEN in .env only has to be
// set once. Whichever of the two expires later is used, so pasting a new
// token into .env still takes over.
function expiryOf(token) {
  const s = String(token || '');
  const exp = Number(s.slice(0, s.lastIndexOf('.')).split(':')[1]);
  return Number.isFinite(exp) ? exp : 0;
}
let token = (() => {
  const saved = loadJson('opengym-token', null)?.token;
  return saved && expiryOf(saved) > expiryOf(config.openGymToken) ? saved : config.openGymToken;
})();
if (expiryOf(token)) console.log(`[opengym] bearer token valid until ${new Date(expiryOf(token)).toISOString()}`);

const RENEW_CHECK_MS = 12 * 60 * 60 * 1000;
let lastRenewCheck = 0;
async function maybeRenewToken() {
  if (Date.now() - lastRenewCheck < RENEW_CHECK_MS) return;
  lastRenewCheck = Date.now();
  try {
    const res = await fetch(`${config.openGymBaseUrl}/api/me`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return;
    const body = await res.json();
    if (typeof body?.token === 'string' && expiryOf(body.token) > expiryOf(token)) {
      token = body.token;
      saveJson('opengym-token', { token, renewedAt: new Date().toISOString() });
      console.log(`[opengym] bearer token renewed, now valid until ${new Date(expiryOf(token)).toISOString()}`);
    }
  } catch (err) {
    console.error(`[opengym] token renewal check failed: ${err.message}`);
  }
}

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
      headers: { Authorization: `Bearer ${token}` },
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
      'openGym rejected this server\'s bearer token (401) — it has expired or been signed out ' +
      '(it renews itself while this server is in use, so this usually means a long gap or ' +
      '"sign out everywhere"). Re-pair (POST /api/pair/create from a signed-in browser tab, ' +
      'then /api/pair/redeem), update OPENGYM_BEARER_TOKEN in .env, then restart this server.'
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
  void maybeRenewToken();
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
      headers: { Authorization: `Bearer ${token}` },
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
