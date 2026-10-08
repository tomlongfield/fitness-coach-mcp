// Re-vendors the slice of openGym's own frontend training logic this server
// reuses (queue/rotation, muscle load, progression, session preview,
// structural balance, set-model helpers) into lib/vendor/opengym/, copied
// verbatim from a pinned release tag. Reusing upstream's code rather than
// re-deriving its rules is the point: a "next session" or "planned weekly
// volume" answer here then matches what the app itself shows.
//
// openGym is AGPL-3.0-or-later, and so is this repo because of it.
//
// Usage: node scripts/update-opengym-vendor.mjs [tag]   (default: VENDOR_TAG below)
//
// Starts from ENTRY_MODULES and follows every relative import/export, so a
// new upstream dependency is picked up without updating this list. After
// running, `node -e "import('./lib/vendor/opengym/index.js')"` must still
// load under plain node — upstream's modules are written for Vite, and a
// Vite-only import (import.meta.glob, a .jsx file) landing in this graph
// would only show up at server start.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VENDOR_TAG = 'v1.3.10';
const tag = process.argv[2] || VENDOR_TAG;
const BASE = `https://raw.githubusercontent.com/DuarteSantos8/openGym/${tag}/frontend/src/lib/`;
const OUT_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '../lib/vendor/opengym');

const ENTRY_MODULES = [
  'queue.js',
  'rotation.js',
  'history.js',
  'muscles.js',
  'progression.js',
  'session-start.js',
  'workout-model.js',
  'onerm.js',
  'pyramid.js',
  'structuralBalance.js',
  'structuralBalanceTemplates.js',
  'media-refs.js',
];

const IMPORT_RE = /(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

async function fetchText(file) {
  const res = await fetch(BASE + file);
  if (!res.ok) throw new Error(`Failed to fetch ${BASE + file}: ${res.status}`);
  return res.text();
}

const files = new Map();
const queue = [...ENTRY_MODULES];
while (queue.length) {
  const file = queue.shift();
  if (files.has(file)) continue;
  const text = await fetchText(file);
  files.set(file, text);
  if (!file.endsWith('.js')) continue;
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1] || m[2] || m[3];
    if (!spec.startsWith('./')) {
      throw new Error(`${file} imports ${spec}, which is outside frontend/src/lib — not vendorable as-is`);
    }
    const target = path.posix.normalize(spec.slice(2));
    queue.push(path.posix.extname(target) ? target : `${target}.js`);
  }
}

fs.rmSync(OUT_DIR, { recursive: true, force: true });
fs.mkdirSync(OUT_DIR, { recursive: true });
for (const [file, text] of files) {
  fs.mkdirSync(path.dirname(path.join(OUT_DIR, file)), { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, file), text);
}
fs.writeFileSync(
  path.join(OUT_DIR, 'VERSION'),
  `DuarteSantos8/openGym ${tag} — frontend/src/lib/, copied verbatim by scripts/update-opengym-vendor.mjs.\n` +
    'Do not edit these files by hand; re-run the script instead.\n'
);
console.log(`Vendored ${files.size} files from openGym ${tag} into ${path.relative(process.cwd(), OUT_DIR)}`);
