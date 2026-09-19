import crypto from 'node:crypto';
import { config, isAllowedRedirect } from './config.js';

// ---------------------------------------------------------------------------
// Stateless signed tokens (survive a server restart, no DB needed).
// Format: base64url(payload-json) + "." + hex-hmac(payload, TOKEN_SECRET)
// ---------------------------------------------------------------------------
function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', config.tokenSecret).update(body).digest('hex');
  return `${body}.${sig}`;
}

function verify(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const expected = crypto.createHmac('sha256', config.tokenSecret).update(body).digest('hex');
  const sigBuf = Buffer.from(sig || '', 'hex');
  const expBuf = Buffer.from(expected, 'hex');
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof payload.exp !== 'number' || Date.now() >= payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

const ACCESS_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 days
const REFRESH_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function issueTokenPair() {
  const now = Date.now();
  return {
    access_token: sign({ typ: 'access', iat: now, exp: now + ACCESS_TTL_MS }),
    refresh_token: sign({ typ: 'refresh', iat: now, exp: now + REFRESH_TTL_MS }),
    token_type: 'Bearer',
    expires_in: Math.floor(ACCESS_TTL_MS / 1000),
  };
}

// ---------------------------------------------------------------------------
// In-memory state. Ephemeral by design: registered clients and in-flight
// auth codes don't need to survive a restart. Access/refresh tokens DO
// (they're the signed tokens above), so a restart never logs Claude out.
// ---------------------------------------------------------------------------
// clients isn't swept: DCR registrations only happen when you add/reconnect
// the Claude connector, so growth here is a handful of entries over years —
// not worth the complexity of aging them out.
const clients = new Map();     // client_id -> { redirect_uris }
const authCodes = new Map();   // code -> { clientId, redirectUri, codeChallenge, expiresAt }
const failedAttempts = new Map(); // ip -> { count, lockedUntil, lastAttempt }

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const FAILED_ATTEMPT_RETENTION_MS = 60 * 60 * 1000; // 1hr since last attempt
const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

function isLocked(ip) {
  const rec = failedAttempts.get(ip);
  return rec && rec.lockedUntil && Date.now() < rec.lockedUntil;
}
function recordFailure(ip) {
  const rec = failedAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  rec.lastAttempt = Date.now();
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCKOUT_MS;
    rec.count = 0;
  }
  failedAttempts.set(ip, rec);
}
function clearFailures(ip) {
  failedAttempts.delete(ip);
}

// These two are attacker-influenced (an unauthenticated caller can create
// entries in either just by hitting /authorize repeatedly), so unlike
// `clients` they're swept on a timer rather than left to grow forever.
// Keyed off lastAttempt rather than lockedUntil so a record mid-lockout
// never gets wiped early and silently reset an attacker's attempt count.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodes) {
    if (entry.expiresAt < now) authCodes.delete(code);
  }
  for (const [ip, rec] of failedAttempts) {
    if (now - (rec.lastAttempt || 0) > FAILED_ATTEMPT_RETENTION_MS) failedAttempts.delete(ip);
  }
}, SWEEP_INTERVAL_MS).unref();

function sha256base64url(input) {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

// ---------------------------------------------------------------------------
// Express route registration
// ---------------------------------------------------------------------------
export function registerOAuthRoutes(app) {
  const { issuer, mcpUrl } = config;

  // --- Discovery ------------------------------------------------------------
  app.get('/.well-known/oauth-authorization-server', (req, res) => {
    res.json({
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
    });
  });

  app.get('/.well-known/oauth-protected-resource', (req, res) => {
    res.json({
      resource: mcpUrl,
      authorization_servers: [issuer],
    });
  });

  // --- Dynamic Client Registration (RFC 7591) --------------------------------
  app.post('/register', (req, res) => {
    const redirectUris = req.body?.redirect_uris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      return res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
    }
    if (!redirectUris.every(isAllowedRedirect)) {
      return res.status(400).json({ error: 'invalid_redirect_uri' });
    }
    const clientId = crypto.randomUUID();
    clients.set(clientId, { redirect_uris: redirectUris });
    res.status(201).json({
      client_id: clientId,
      redirect_uris: redirectUris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // --- Authorize: render a password form, then issue a one-shot code --------
  app.get('/authorize', (req, res) => {
    const { client_id, redirect_uri, response_type, code_challenge, code_challenge_method, state } = req.query;

    if (response_type !== 'code') return res.status(400).send('unsupported response_type');
    const client = clients.get(client_id);
    if (!client) return res.status(400).send('unknown client_id — remove and re-add the connector in Claude');
    if (!client.redirect_uris.includes(redirect_uri)) return res.status(400).send('redirect_uri mismatch');
    if (code_challenge_method !== 'S256' || !code_challenge) return res.status(400).send('PKCE S256 required');

    const hidden = { client_id, redirect_uri, code_challenge, state: state || '' };
    res.send(renderLoginPage(hidden));
  });

  app.post('/authorize', (req, res) => {
    const ip = req.ip;
    if (isLocked(ip)) {
      return res.status(429).send('Too many attempts. Try again in a few minutes.');
    }

    const { client_id, redirect_uri, code_challenge, state, password } = req.body || {};
    const client = clients.get(client_id);
    if (!client || !client.redirect_uris.includes(redirect_uri)) {
      return res.status(400).send('invalid request');
    }

    const provided = Buffer.from(String(password || ''));
    const expected = Buffer.from(config.mcpPassword);
    const ok = provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
    if (!ok) {
      recordFailure(ip);
      return res.status(401).send(renderLoginPage({ client_id, redirect_uri, code_challenge, state }, 'Wrong password.'));
    }
    clearFailures(ip);

    const code = crypto.randomBytes(24).toString('base64url');
    authCodes.set(code, {
      clientId: client_id,
      redirectUri: redirect_uri,
      codeChallenge: code_challenge,
      expiresAt: Date.now() + CODE_TTL_MS,
    });

    const url = new URL(redirect_uri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    res.redirect(url.toString());
  });

  // --- Token exchange ---------------------------------------------------------
  app.post('/token', (req, res) => {
    const { grant_type } = req.body || {};

    if (grant_type === 'authorization_code') {
      const { code, redirect_uri, code_verifier, client_id } = req.body;
      const entry = authCodes.get(code);
      if (!entry || entry.expiresAt < Date.now()) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      authCodes.delete(code); // one-shot
      if (entry.clientId !== client_id || entry.redirectUri !== redirect_uri) {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      const computed = sha256base64url(code_verifier || '');
      if (computed !== entry.codeChallenge) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      return res.json(issueTokenPair());
    }

    if (grant_type === 'refresh_token') {
      const { refresh_token } = req.body;
      const payload = verify(refresh_token);
      if (!payload || payload.typ !== 'refresh') {
        return res.status(400).json({ error: 'invalid_grant' });
      }
      return res.json(issueTokenPair());
    }

    return res.status(400).json({ error: 'unsupported_grant_type' });
  });
}

// ---------------------------------------------------------------------------
// Middleware protecting the /mcp endpoint
// ---------------------------------------------------------------------------
export function requireAuth(req, res, next) {
  const header = req.headers['authorization'] || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = token && verify(token);
  if (!payload || payload.typ !== 'access') {
    res
      .status(401)
      .set('WWW-Authenticate', `Bearer resource_metadata="${config.issuer}/.well-known/oauth-protected-resource"`)
      .json({ error: 'unauthorized' });
    return;
  }
  next();
}

function renderLoginPage(hidden, error) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to openGym coach</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 360px; margin: 80px auto; padding: 0 16px; }
  input { width: 100%; padding: 10px; font-size: 16px; box-sizing: border-box; margin: 8px 0; }
  button { width: 100%; padding: 10px; font-size: 16px; cursor: pointer; }
  .error { color: #b00020; font-size: 14px; }
</style></head>
<body>
  <h2>Connect Claude to your openGym data</h2>
  <p>Read-only access. Enter your connector password.</p>
  ${error ? `<p class="error">${esc(error)}</p>` : ''}
  <form method="POST" action="/authorize">
    <input type="hidden" name="client_id" value="${esc(hidden.client_id)}">
    <input type="hidden" name="redirect_uri" value="${esc(hidden.redirect_uri)}">
    <input type="hidden" name="code_challenge" value="${esc(hidden.code_challenge)}">
    <input type="hidden" name="state" value="${esc(hidden.state || '')}">
    <input type="password" name="password" placeholder="Password" autofocus required>
    <button type="submit">Connect</button>
  </form>
</body></html>`;
}
