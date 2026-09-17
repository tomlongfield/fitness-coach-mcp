// Regenerates lib/exercise-library.js from openGym's own exercise library
// source. Run whenever get_recent_workouts/get_current_routines shows a raw
// exerciseId that isn't resolving — it usually just means openGym added new
// built-in exercises since the last snapshot.
//
// Usage: node scripts/update-exercise-library.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_URL =
  'https://raw.githubusercontent.com/DuarteSantos8/openGym/main/frontend/src/lib/exercises-data.js';
const OUT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../lib/exercise-library.js'
);

const res = await fetch(SOURCE_URL);
if (!res.ok) {
  throw new Error(`Failed to fetch ${SOURCE_URL}: ${res.status}`);
}
const raw = await res.text();

// The file is `export const EXDB=[...]` — pull out just the array literal by
// bracket-depth counting rather than assuming a fixed prefix length, so a
// harmless upstream formatting change doesn't silently truncate the parse.
const jsonStart = raw.indexOf('[');
if (jsonStart === -1) throw new Error('Could not find EXDB array in source file');
let depth = 0;
let jsonEnd = -1;
for (let i = jsonStart; i < raw.length; i++) {
  if (raw[i] === '[') depth++;
  else if (raw[i] === ']') {
    depth--;
    if (depth === 0) {
      jsonEnd = i + 1;
      break;
    }
  }
}
if (jsonEnd === -1) throw new Error('Could not find end of EXDB array in source file');

const exercises = JSON.parse(raw.slice(jsonStart, jsonEnd));
const idToName = Object.fromEntries(exercises.map((e) => [e.id, e.n]));
const today = new Date().toISOString().slice(0, 10);

const output = `// Snapshot of openGym's built-in exercise library (id -> name only), so
// this server can resolve exerciseId -> exerciseName for built-in exercises
// itself, without needing a lookup file maintained on the Claude side.
//
// Source: DuarteSantos8/openGym, frontend/src/lib/exercises-data.js (EXDB).
// The metadata/names in that dataset are MIT-licensed (images/GIFs are
// separately licensed and are not included here — see openGym's NOTICE.md).
//
// This is a point-in-time snapshot (${today}, ${Object.keys(idToName).length}
// entries) of openGym's own library, not a live API — it goes stale if
// openGym adds new built-in exercises after this date. Regenerate with:
// node scripts/update-exercise-library.mjs
export const EXERCISE_LIBRARY = ${JSON.stringify(idToName)};
`;

fs.writeFileSync(OUT_PATH, output);
console.log(`Wrote ${Object.keys(idToName).length} exercises to ${OUT_PATH}`);
