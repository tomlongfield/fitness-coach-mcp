import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { config } from './lib/config.js';
import { registerOAuthRoutes, requireAuth } from './lib/oauth.js';
import { registerHealthRelayRoutes } from './lib/health-relay.js';
import { buildServer } from './lib/tools.js';

const app = express();
app.set('trust proxy', true); // we sit behind nginx/caddy; needed for req.ip in the login rate limiter

// DCR (/register) uses JSON; the token endpoint uses form-urlencoded (RFC 6749).
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Branding assets only (favicon/icon) — no auth, deliberately: the whole
// point is for Claude's own connector-icon lookup (and any browser showing
// the login page) to be able to fetch these from outside this server's
// normal IP allowlist. See README's reverse-proxy section for the matching
// nginx location block this needs alongside /authorize and /health-relay/.
app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'), { maxAge: '7d' }));

registerOAuthRoutes(app);
registerHealthRelayRoutes(app);

// --- The MCP endpoint itself -------------------------------------------------
// Stateless: a brand-new McpServer + transport per request, never reused.
// This is the documented-safe pattern (and avoids CVE-2026-25536).
app.post(config.mcpPath, requireAuth, async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('MCP request failed:', err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'internal_error', error_description: String(err.message || err) });
    }
  }
});

// Stateless mode doesn't support the optional GET (server->client stream) or
// DELETE (session teardown) — there's no session to stream to or tear down.
app.get(config.mcpPath, requireAuth, (req, res) => res.status(405).json({ error: 'method_not_allowed' }));
app.delete(config.mcpPath, requireAuth, (req, res) => res.status(405).json({ error: 'method_not_allowed' }));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(config.port, () => {
  console.log(`Fitness coach MCP server listening on :${config.port}`);
  console.log(`MCP endpoint (public): ${config.mcpUrl}`);
});
