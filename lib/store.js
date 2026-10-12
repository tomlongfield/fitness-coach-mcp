import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

// The only state this server keeps beyond its signed tokens: OAuth client
// registrations (lib/oauth.js) and a renewed openGym token
// (lib/opengym-client.js), as small JSON files under config.dataDir.
// Instance data, never code (gitignored). Private permissions, since both
// hold credentials, and written atomically (temp file + rename) so a crash
// mid-write can't leave a half-written file behind.
function fileFor(name) {
  return path.join(config.dataDir, `${name}.json`);
}

export function loadJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(fileFor(name), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`[store] could not read ${name}: ${err.message}`);
    return fallback;
  }
}

export function saveJson(name, value) {
  fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const file = fileFor(name);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
