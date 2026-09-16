import { config } from './config.js';

// The whole app state is one blob (per the openGym spec). We fetch it once
// and let each tool slice out what it needs, rather than one round-trip per
// tool call. A short cache keeps a burst of tool calls within one Claude
// turn from hitting openGym repeatedly.
let cache = { at: 0, data: null };
const CACHE_MS = 60 * 1000;

export async function getState() {
  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return cache.data;
  }

  const res = await fetch(`${config.openGymBaseUrl}/api/data`, {
    headers: { Authorization: `Bearer ${config.openGymToken}` },
  });

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
