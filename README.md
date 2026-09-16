# Fitness coach MCP server

A small, read-only bridge between a self-hosted fitness stack and Claude.
Exposes four tools over the Model Context Protocol, so Claude can pull live
training and nutrition data instead of you pasting it in:

- `get_recent_workouts`, `get_current_routines` — from [openGym](https://github.com/DuarteSantos8/openGym).
- `get_nutrition_day`, `get_bodyweight_trend` — from [SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness)
  (treated as the authoritative source for body measurements here — openGym
  does log a bodyweight figure per workout too, but it's manually re-typed
  rather than synced from a scale, so SparkyFitness's Apple Health/smart-scale
  sync is preferred instead).

It never writes to either service. It holds one openGym bearer token and one
SparkyFitness API key server-side, and gates access behind a
password-protected OAuth login that only you complete once (in a browser,
when you add the connector in Claude).

## Prerequisites — and what's out of scope

This project assumes you already have a working openGym instance and a
working SparkyFitness instance, both reachable from wherever this server
runs. **Installing and configuring those two apps is out of scope here** —
they're both actively developed, self-hosted apps with their own install
docs, and duplicating that documentation would just go stale. Use their own
instructions:

- openGym: [github.com/DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym)
- SparkyFitness: [github.com/CodeWithCJ/SparkyFitness](https://github.com/CodeWithCJ/SparkyFitness)
  ([install docs](https://codewithcj.github.io/SparkyFitness/))

`examples/opengym/` and `examples/sparkyfitness/` each hold a **trimmed**
`docker-compose.yml` and `.env.example` — not the authoritative install
method, just enough to show the shape of a working setup and, specifically,
to flag the one thing in each that has a knock-on effect on *this* server:
whichever host port each app's frontend ends up published on is what you
point this server's `OPENGYM_BASE_URL` / `SPARKYFITNESS_BASE_URL` at. Both
example files link back to the real upstream files for the full,
current, fully-featured version.

`examples/nginx/` holds three example vhosts (openGym, SparkyFitness, this
MCP server) showing a "dedicated subdomain + optional trusted-network
allowlist" pattern — again, illustrative, adapt to your own setup.

Once both are up and you know their reachable URLs, continue below.

## 1. Get an openGym bearer token

From a browser tab where you're already signed in to openGym, open DevTools
and run this in the Console (a plain visit to the URL sends a GET and will
404 — this needs to be a POST, fired with your session cookie attached):

```js
fetch('/api/pair/create', { method: 'POST', credentials: 'include' })
  .then(r => r.json())
  .then(console.log)
```

Returns `{ "code": "K7WQ2MZP" }`. Within 5 minutes, redeem it (curl is fine,
this doesn't need a browser):

```bash
curl -X POST https://gym.example.com/api/pair/redeem \
  -H 'Content-Type: application/json' \
  -d '{"code":"K7WQ2MZP"}'
```

Returns `{ "token": "...", "user": {...} }`. That token is valid 90 days
(openGym's default `SESSION_DAYS`) — put it in `.env` as `OPENGYM_BEARER_TOKEN`.

**Note the expiry.** When it lapses, tool calls will start failing with a
clear error message telling you to redo this step. There's nothing automatic
here — put a reminder in your calendar for ~80 days out, or just re-pair
whenever you see the error.

## 2. Get a SparkyFitness API key

In the SparkyFitness web UI: **Settings → Developer & Integrations → API Key
Management** → create a new key (any name, e.g. "mcp-server"; no expiry
needed unless you want one). Put it in `.env` as `SPARKYFITNESS_API_KEY`.
It's sent as `Authorization: Bearer <key>` — SparkyFitness distinguishes API
keys from session tokens by format, so no other header is needed.

## 3. Configure

```bash
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"  # run twice
```

Use the two generated values for `MCP_PASSWORD` and `TOKEN_SECRET`. Fill in
`OPENGYM_BASE_URL`, `OPENGYM_BEARER_TOKEN`, `SPARKYFITNESS_BASE_URL`,
`SPARKYFITNESS_API_KEY`, and `PUBLIC_URL` (the externally reachable HTTPS
URL you'll serve `/mcp` at — see step 5).

**The knock-on-effect note, in full:** if this server runs on the same host
as openGym and/or SparkyFitness, point `OPENGYM_BASE_URL` /
`SPARKYFITNESS_BASE_URL` at each app's internal backend port (e.g.
`http://127.0.0.1:8080`, `http://127.0.0.1:3004/api` — whatever they're
actually listening on, see `examples/`) rather than their public HTTPS
URLs. Going out through the public hostname means routing back in through
your own reverse proxy, which can be unreliable (some providers don't
support this "hairpin" routing) and will trip any IP allowlist you've put
on that app's own proxy config (see `examples/nginx/`). Going straight to
the backend port skips both problems, needs no TLS since it never leaves
the box, and needs no changes to the target app's proxy config either.

Also worth checking `PORT` (default `8787`) isn't already taken by
something else on the box before you settle on it:

```bash
sudo ss -ltnp | grep :8787
```

## 4. Install and run

```bash
npm install
npm start
```

Sanity-check it's alive: `curl http://localhost:8787/healthz` → `{"ok":true}`.

Before pointing Claude at it, it's worth testing the MCP endpoint itself with
the [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
(`npx @modelcontextprotocol/inspector`, run on your own machine — it opens a
local browser UI) — it can drive the OAuth flow and list your tools, and
it's a much faster feedback loop than debugging through Claude's connector
UI. Point it at your `PUBLIC_URL` with transport type "Streamable HTTP" and
hit Connect; it'll walk through discovery, registration, and the
`/authorize` login page (enter your `MCP_PASSWORD`) automatically. Both
Claude Code's and MCP Inspector's loopback OAuth callback conventions
(`/callback` and `/oauth/callback` respectively) are already allowlisted in
`lib/config.js`, so this should work without any config changes. A
different MCP client using a different loopback path would need adding
there — see `isAllowedRedirect` in `lib/config.js`.

## 5. Put it behind a reverse proxy

Two common patterns, depending on whether you're sharing a domain with
openGym/SparkyFitness or using a separate one — pick whichever matches your
setup. Full example files are in `examples/nginx/mcp-server.conf`.

### Pattern A: shared domain, `/mcp` path prefix

Example nginx location block, assuming the other app is on `/` and this
server gets the `/mcp` prefix (adjust to taste — just make sure `PUBLIC_URL`
in `.env` matches whatever path you choose exactly):

```nginx
location /mcp {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
location ~ ^/(\.well-known/oauth-(authorization-server|protected-resource)|register|authorize|token)$ {
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

The OAuth endpoints have to live at the *origin* (not under `/mcp`) because
that's where the OAuth spec expects `/.well-known/*` to be — that's already
how `lib/config.js` builds the metadata, so no code changes needed, just the
proxy routing above.

### Pattern B: dedicated subdomain

If you'd rather give this server its own subdomain (e.g.
`mcp.example.com`, separate from the other apps' domains), the whole vhost
belongs to it, so a single catch-all location covers `/mcp` and every OAuth
path — no need to carve anything out:

```nginx
server {
    listen 443 ssl;
    server_name mcp.example.com;
    # ssl_certificate / ssl_certificate_key — managed by certbot or your ACME client

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Set `PUBLIC_URL=https://mcp.example.com/mcp` in `.env` to match.

### Optional: restricting access with an IP allowlist

If the other apps' vhosts already restrict inbound traffic to an allowlist
(e.g. a VPN CIDR — see `examples/nginx/opengym.conf` and
`sparkyfitness.conf`), you may want the same for this server. There's a
wrinkle: traffic to this server comes from two different places, so a
single allowlist covering just one of them will break the other.

- `/mcp`, `/register`, and `/token` are called by Claude's backend
  infrastructure. Anthropic publishes a stable outbound IPv4 range for this
  — `160.79.104.0/21` as of writing, see
  [their IP address docs](https://platform.claude.com/docs/en/api/ip-addresses)
  for the current value — so this is the range to allowlist for these paths.
- `/authorize` — the login page — is loaded by **your own browser** the
  first time you connect the connector (and again if you ever
  disconnect/reconnect). It is not called by Anthropic's servers, so
  restricting it to Anthropic's range instead of your own network will lock
  you out of logging in.

Split them accordingly, matching `/authorize` before the catch-all — full
example in `examples/nginx/mcp-server.conf`:

```nginx
location /authorize {
    allow 203.0.113.0/24;   # your trusted network/VPN CIDR
    deny all;
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}

location / {
    allow 160.79.104.0/21;  # Anthropic's outbound range
    allow 203.0.113.0/24;   # your trusted network/VPN CIDR, for manual testing
    allow 127.0.0.1;
    deny all;
    proxy_pass http://127.0.0.1:8787;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

## 6. Run it under a process supervisor

Run it under whatever process supervisor you already use for the rest of
your stack (systemd, pm2, docker) — a minimal systemd unit:

```ini
[Unit]
Description=Fitness coach MCP server
After=network.target

[Service]
WorkingDirectory=/path/to/fitness-coach-mcp
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/path/to/fitness-coach-mcp/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now fitness-coach-mcp
```

## 7. Connect it in Claude

Settings → Connectors → Add custom connector → paste your `PUBLIC_URL`
(the full `/mcp` URL). Claude will open a browser tab to the login page this
server serves — enter the `MCP_PASSWORD` you generated. After that, Claude
holds a signed access/refresh token pair and won't ask again unless you
disconnect, or ~30 days pass without use (the refresh token is good for a
year, refreshed automatically).

## 8. Set up a Claude Project (recommended)

The connector alone gives Claude live numbers, but nothing that lives
outside either API — injury history, standing goals, coaching judgment
calls, how to interpret a raw exercise ID it can't otherwise resolve. A
[Claude Project](https://support.claude.com/en/articles/9517075-what-are-projects)
with custom instructions and a couple of knowledge files fills that gap.
`examples/claude-project/` has three loose templates to start from:

- `instructions.md` — a project custom-instructions template: splits what's
  live (connector tools) from what's background (knowledge files), and
  says explicitly which tool covers which data.
- `fitness-context.md` — a **very** loose structural example of a knowledge
  file, with every value replaced by a placeholder — the point is the
  shape (what belongs in "standing constraints" vs. "current status" vs.
  what should just be a live connector call instead of a hardcoded
  number), not the content.
- `exercise-id-mapping.md` — a small worked example of the built-in
  exercise ID table mentioned in `instructions.md`, plus notes on why to
  keep it scoped to your own used IDs rather than the whole ~1,300-entry
  library.

None of these are meant to be used verbatim — replace every placeholder
with your own actual context.

## What's deliberately left out

- **No write access.** There's no `log_workout` or food-logging tool for
  either service. If you want that later, it's a new tool plus a new scope
  to think about for whichever API — not a small addition.
- **No SparkyFitness measurement data other than body/food/water.** No
  progress photos (not a good fit for a JSON tool response, and more
  sensitive data than the value justifies) and no exercise sessions
  (openGym already covers workouts; SparkyFitness's own exercise entries
  would just be a second, redundant source).
- **No persistence beyond signed tokens.** Registered OAuth clients and
  in-flight authorization codes live in memory; a restart clears them, and
  Claude will just need to reconnect once. Access/refresh tokens are
  self-contained signed strings, so a restart doesn't log you out.
- **One password, no per-request MFA.** Proportionate for a single-user
  personal server behind your own domain — not something to reuse for
  anything with other users.

## Troubleshooting

- **"unknown client_id" on the login page** — the server restarted since you
  added the connector. Remove and re-add the connector in Claude's settings.
- **Tool calls fail with an openGym 401** — your `OPENGYM_BEARER_TOKEN` has
  expired; redo step 1 and restart the server.
- **Tool calls fail with a SparkyFitness 401** — your
  `SPARKYFITNESS_API_KEY` was revoked or disabled; generate a new one
  (step 2), update `.env`, and restart the server.
- **Claude says it can't reach the server** — check the reverse proxy is
  forwarding the `/.well-known/*`, `/register`, `/authorize`, and `/token`
  routes (step 5), not just `/mcp`. A common failure mode is only proxying
  `/mcp` and leaving OAuth discovery 404ing at the origin.
- **`invalid_redirect_uri` (400) on `/register`** — the client's loopback
  callback path isn't in `ALLOWED_LOOPBACK_PATHS` in `lib/config.js`. Claude
  Code and MCP Inspector's conventions are both allowlisted already; a
  different client may use a different path and need adding there.
- **openGym or SparkyFitness tool calls fail even though the credential is
  valid** — if this server is co-located with the target service and its
  `*_BASE_URL` points at that service's public HTTPS URL, check whether the
  target's own reverse proxy has an IP allowlist blocking this server's
  outbound request. Point the URL at the internal backend port instead
  (step 3).

## License

MIT — see `LICENSE`.
