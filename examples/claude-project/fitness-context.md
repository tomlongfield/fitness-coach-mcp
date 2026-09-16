# Example fitness-context.md

A **very loose** structural example of a project-knowledge file to pair with
`instructions.md`. No real values here — every number, date, and detail is
a placeholder showing the *shape* of a section, not something to copy.

**Where this file ends and `instructions.md` begins:** this file is
*facts* — who you are, your actual goals and constraints, your injury
history. It changes as your life does. `instructions.md` is *process* —
how Claude should behave, which tool covers what. It should barely change.
Don't duplicate `instructions.md`'s content here (e.g. don't re-explain
which connector covers which data, or restate date-handling rules) —
that's the overlap that makes the two files quietly drift apart. This file
should read as a dossier, not a manual.

```markdown
# Fitness & Health Context — [Name]

*Last updated: [date]*
*Numbers (workouts and routines from openGym; food, water, bodyweight, and
body measurements from SparkyFitness) come live from the connector tools —
this file holds only what the APIs can't tell you.*

## Biographical

- Date of birth: [YYYY-MM-DD]
- Height: [value]
- Relevant standing conditions/medications: [if any — only what actually
  needs to shape recommendations]
- Diet: [e.g. vegan, none, allergy-driven]
- Training programme start date: [YYYY-MM-DD]

## Current goal

[One or two sentences on what "good" looks like right now, entirely in
your own terms, plus any explicit trade-off that should shape
recommendations. This is yours to define — there's no default goal a
template should nudge you toward.]

## Standing constraints (apply to every recommendation)

The last four below are sensible general-safety defaults, not
personalized advice — keep them unless you have a specific reason not to.
They're not a substitute for actually seeing a professional; the point is
to make sure Claude nudges you toward one rather than helping you work
around a symptom that needs it.

- [Any condition-driven rule, e.g. "prioritize X over Y given Z."]
- [Dietary restriction]: never suggest [excluded category].
- [Experience level]: don't recommend advanced programming prematurely —
  normal progression first.
- Joint/soft-tissue pain persisting beyond ~2 weeks despite rest and
  normal self-care → recommend seeing a physio or GP, not further
  self-directed changes (matches general NHS guidance on when
  musculoskeletal pain warrants assessment rather than continued
  watchful waiting).
- Any red-flag symptom — signs of spreading infection (redness, warmth,
  fever), numbness/tingling/weakness, sudden inability to bear weight or
  move a joint, or loss of bladder/bowel control — flag for urgent/same-day
  medical attention immediately, don't wait it out or suggest self-managing.
- Never diagnose. Flag, don't label.

## Injury history and current status

[Only if relevant. Log the injury, the date, and — per the safety defaults
above — a clear trigger for when it stops being something to self-manage.
Example: "Left ankle sprain, onset [date]. If pain/swelling persists
beyond ~2 weeks from onset with no improvement, or any red-flag symptom
above appears, that's the trigger for a physio/GP visit, not more
self-adjustment." Compute "2 weeks from onset" against today's actual
date, not a stale relative phrase.]

## Structural coaching notes (judgment calls, not raw data)

[Longer-lived reasoning that doesn't fit "current status" — programming
gaps, planned changes once some condition resolves, how to calibrate a
new exercise with no benchmark, frequency/volume reasoning appropriate to
experience level. This is the section for "why," not "what."]

## Nutrition

[If targets are tracked live via the connector (e.g. SparkyFitness goals),
say so explicitly and point there rather than hardcoding a number here —
a number in this file will silently go stale the moment the real target
changes. Reserve this section for framing: e.g. "treat the calorie goal as
a starting point to revise based on observed trend, not a fixed target."]

## [Any other standing-context sections specific to you]

[E.g. the ongoing purpose of a recurring session type, a fixed weekly
schedule, a running status update on something long-term. Add sections
freely — the only rule is: if it's a fact or number the connector can
already answer, don't duplicate it here.]
```
