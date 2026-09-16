# Example: openGym built-in exercise ID map

openGym's built-in exercise library isn't exposed via its API — only custom
exercises you've created yourself are (the MCP server already resolves
those automatically, see `buildExerciseIndex` in `lib/tools.js`). When a
workout or routine entry shows a raw numeric ID instead, add it to a table
like this one in your Claude Project's knowledge, so Claude can look it up
instead of guessing.

This is a small illustrative sample (real ID→name pairs, confirmed against
openGym's own exercise data), not a working mapping for your account — your
IDs will be different, and there are ~1,300 possible entries in the full
library. Keep this table scoped to just the exercises that actually show up
in *your* workouts/routines, not the whole library — see the main README
and the worked example in this project's own development history for why
(a full-library file is both mostly-irrelevant noise and, in a Claude
Project specifically, large enough to risk tipping the project into
degraded RAG-search mode instead of being read in full — bad for a table
where exact ID lookups matter).

To build your own version: fetch a day's `/api/data` from your openGym
instance, collect the numeric IDs from `workouts[].entries[].id` and
`routines[].ex[].id` that *don't* match anything in `customEx`, then cross-
reference each one against openGym's own exercise library source
(`frontend/src/lib/exercises-data.js` in
[DuarteSantos8/openGym](https://github.com/DuarteSantos8/openGym)) to get
the name. Re-run this whenever a new unresolved ID shows up.

| ID   | Name |
|------|------|
| 0001 | 3/4 sit-up |
| 0002 | 45° side bend |
| 0003 | air bike |
| 0577 | lever chest press |
| 2141 | walk elliptical cross trainer |
| 2318 | lever shoulder press v. 3 |

If an ID shows up that isn't in your table, say so explicitly rather than
guessing at the exercise — it just means a new one hasn't been added yet.
