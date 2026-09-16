import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name} (copy .env.example to .env and fill it in)`);
    process.exit(1);
  }
  return v;
}

const publicUrl = new URL(required('PUBLIC_URL'));

export const config = {
  port: Number(process.env.PORT || 8787),
  openGymBaseUrl: required('OPENGYM_BASE_URL').replace(/\/+$/, ''),
  openGymToken: required('OPENGYM_BEARER_TOKEN'),
  sparkyFitnessBaseUrl: required('SPARKYFITNESS_BASE_URL').replace(/\/+$/, ''),
  sparkyFitnessApiKey: required('SPARKYFITNESS_API_KEY'),
  mcpPassword: required('MCP_PASSWORD'),
  tokenSecret: required('TOKEN_SECRET'),
  // Origin (scheme + host) — where OAuth metadata and endpoints are served.
  issuer: publicUrl.origin,
  // Path the MCP endpoint itself lives at, e.g. "/mcp".
  mcpPath: publicUrl.pathname,
  // Full MCP URL, must match exactly what's typed into Claude's connector form.
  mcpUrl: publicUrl.toString(),
};

// Redirect URIs Claude's hosted surfaces and Claude Code use. Anything else
// is refused at registration time — this is a personal single-user server,
// there's no reason to accept an arbitrary redirect target.
export const ALLOWED_REDIRECT_URIS = [
  'https://claude.ai/api/mcp/auth_callback',
];
// Loopback callback paths accepted on top of ALLOWED_REDIRECT_URIS, per
// client: Claude Code (RFC 8252 loopback) uses /callback, MCP Inspector
// uses /oauth/callback.
const ALLOWED_LOOPBACK_PATHS = ['/callback', '/oauth/callback'];
export function isAllowedRedirect(uri) {
  if (ALLOWED_REDIRECT_URIS.includes(uri)) return true;
  try {
    const u = new URL(uri);
    const isLoopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    return isLoopback && ALLOWED_LOOPBACK_PATHS.includes(u.pathname);
  } catch {
    return false;
  }
}
