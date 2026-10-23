// Test harness: a fake openGym and SparkyFitness on one local port, and the
// real tools behind an in-memory MCP client. Nothing here reaches a real
// server; local plugins (lib/tools/local) are left out.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

export const hash = (c) => c.repeat(64);
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
export const photo = (h, at) => ({ kind: 'image', hash: h, mime: 'image/jpeg', size: JPEG.length, width: 1, height: 1, at });

// A small account in openGym 1.4.2's shapes, dated from today so the
// windows the tools default to always cover it.
export function fixtureState() {
  const today = new Date().toISOString().slice(0, 10);
  const t0 = Date.now() - 3600e3;
  return {
    unit: 'kg',
    routines: [{
      id: 'r1', name: 'Upper A', emoji: 'figureStrength',
      ex: [
        { id: '0577', sets: 3, mode: 'reps', reps: 12, weight: 30, _ts: 1, subs: ['0596', '0577', '0596', '0294', 'nope-unknown'] },
        { id: '0334', sets: 3, mode: 'reps', reps: 20, weight: 4 },
        { id: '0276', sets: 2, mode: 'reps', reps: 10, weight: 0, side: true },
      ],
    }],
    workouts: [{
      id: 'watch-ABC', d: today, name: 'Upper A', routineId: 'r1', start: t0, end: t0 + 1800e3,
      media: [photo(hash('a'), t0 + 60e3)],
      entries: [
        { id: '0577', sets: [
          { w: 30, r: 12, done: true, hr: { avg: 118, max: 131 }, restHr: { avg: 102, max: 120 } },
          { w: 30, r: 12, done: true },                                 // ticked on the phone
          { w: 30, r: 11, done: true, hr: { avg: 140, max: 120 } },     // max below avg: not a reading
        ] },
        { id: '0276', sets: [
          { w: 0, r: 10, done: true, hr: { avg: 96, max: 104 }, sides: { L: { w: 0, r: 5, done: true }, R: { w: 0, r: 5, done: true } } },
        ] },
      ],
    }],
    dayPhotos: {
      [hash('b')]: { d: '2026-10-20', m: photo(hash('b'), t0 + 120e3), _ts: 1 },  // the newest photo
      [hash('c')]: { _ts: 2 },                                                    // removed
      [hash('d')]: { d: '2026-10-19', m: photo(hash('e'), t0), _ts: 3 },         // filed under the wrong key
    },
  };
}

// Today's Apple Health workouts as SparkyFitness returns them: a strength
// session from Apple's Workout app, and openGym's own copy of the logged
// workout, which openGym writes to Apple Health with no energy or heart rate.
function fixtureExerciseEntries() {
  const today = new Date().toISOString().slice(0, 10);
  const entry = (id, minutes, kcal, bundle) => ({
    id, entry_date: today, name: 'Traditional Strength Training', duration_minutes: minutes, calories_burned: kcal,
    exercise_snapshot: { category: 'Strength' },
    activity_details: [{ detail_data: { sourceBundleId: bundle } }],
  });
  return [entry('apple', 25, 200, 'com.apple.health.1234'), entry('copy', 30, 0, 'ch.opengym.app')];
}

// Starts the fake upstream, points the server's config at it, and returns
// an MCP client connected to a fresh buildServer(). `hits` counts requests
// per path, for checking what the server actually asked for. `failNext`
// maps a path to how many of its next requests answer 500, as SparkyFitness
// does when its database pool is exhausted.
export async function startHarness({ state = fixtureState() } = {}) {
  const hits = new Map();
  const failNext = new Map();
  const upstream = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://x');
    hits.set(pathname, (hits.get(pathname) || 0) + 1);
    if (failNext.get(pathname) > 0) {
      failNext.set(pathname, failNext.get(pathname) - 1);
      res.writeHead(500, { 'content-type': 'application/json' });
      return res.end('{"error":"timeout exceeded when trying to connect"}');
    }
    const json = (body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (pathname === '/api/data') return json({ state, rev: 1 });
    if (pathname === '/api/me') return json({});
    if (pathname.startsWith('/api/media/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end(JPEG); }
    if (pathname === '/sparky/exercise-entries/by-date') {
      const date = new URL(req.url, 'http://x').searchParams.get('selectedDate');
      return json(date === new Date().toISOString().slice(0, 10) ? fixtureExerciseEntries() : []);
    }
    // A day with nothing logged: SparkyFitness reports water as 0, not absent.
    if (pathname === '/sparky/daily-summary') return json({ foodEntries: [], waterIntake: 0, goals: {} });
    if (pathname.startsWith('/sparky/')) return json([]);
    res.writeHead(404).end();
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${upstream.address().port}`;

  Object.assign(process.env, {
    PUBLIC_URL: 'http://localhost:9/mcp',
    OPENGYM_BASE_URL: base,
    OPENGYM_BEARER_TOKEN: 'u:9999999999999:1.x',
    SPARKYFITNESS_BASE_URL: `${base}/sparky`,
    SPARKYFITNESS_API_KEY: 'k',
    MCP_PASSWORD: 'p',
    TOKEN_SECRET: 's',
    TIMEZONE: 'UTC',
    DATA_DIR: path.join(os.tmpdir(), `fitness-coach-test-${process.pid}`),
    SKIP_LOCAL_TOOLS: '1',
  });

  const { buildServer } = await import('../lib/tools.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await buildServer().connect(serverSide);
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(clientSide);

  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const callJson = async (name, args = {}) => {
    const r = await call(name, args);
    if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
    return JSON.parse(r.content[0].text);
  };
  const close = async () => {
    await client.close();
    await new Promise((resolve) => upstream.close(resolve));
  };
  return { client, call, callJson, hits, failNext, close };
}
