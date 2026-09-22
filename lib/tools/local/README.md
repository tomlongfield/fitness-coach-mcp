# Local extensions

Anything you drop in this directory is picked up automatically at server
startup, the same way every built-in domain module under `lib/tools/` is: a
file here that exports a function named `registerSomethingTools(server)`
gets called with the live `McpServer` instance, same as `registerWorkoutTools`
or `registerNutritionTools`.

This is the place for a private data source you don't want in this public
template — a journal app, a second tracker, anything specific to your own
setup. It's genuinely a directory, not a build step: no config, no registry
to update, just add the file.

Everything in this directory except this README is gitignored (see
`.gitignore`). That's deliberate, not incidental:

- **A local extension is never committed here.** `git pull` on this repo
  never touches it, and it never risks getting swept into a commit to this
  *public* repository. Keep its own source elsewhere (a private repo, or
  just the file on the server) and copy it in.
- **Read its own env vars directly**, e.g. `process.env.MY_SERVICE_TOKEN` —
  don't add fields to `lib/config.js` for something that isn't generic to
  every deployment of this template.
- **Follow the existing module shape.** Look at any file under
  `lib/tools/` (`sleep.js` is a short one) for the pattern: a `summarize*`
  reshaping function, a `fetch*`/`get*` data function, and a
  `registerXTools(server)` that calls `server.registerTool(...)`.

## Minimal example

```js
// lib/tools/local/example.js
import { z } from 'zod';
import { asJson } from '../shared.js';

export function registerExampleTools(server) {
  server.registerTool(
    'get_example_thing',
    {
      title: 'Get example thing',
      description: 'Replace this with a real description of what it returns and why.',
      inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    },
    async ({ limit }) => {
      return asJson({ hello: 'world', limit: limit ?? 10 });
    }
  );
}
```
