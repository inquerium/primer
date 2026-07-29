# Contributing

The most valuable contributions to this project are probably not code.

## What is most needed

**Curriculum, from people who teach.** `src/curriculum/*.json` is the skill graph —
what a child learns, in what order, and what must come first. It is plain JSON and
extending it needs no TypeScript. If a prerequisite is wrong there, it is wrong in a
way that quietly mis-teaches a real child, and it will not throw an error. A reading
specialist reading `reading.json` for an afternoon is worth more than a month of
refactoring.

It currently stops at grade 3 and is English-only. Both are content problems, not
engineering ones.

**Telling us it was wrong about your child.** The model makes claims — she has
mastered this, she is stuck on that, this misconception is fading. If it said
something false about your child, that is a bug report worth more than any feature
request. `primer export <name>` produces the whole record; the parts that matter are
usually the observations and the mastery rows.

**The things listed as missing in the README.** They are listed because they are
real, not as a to-do performance.

## Ground rules

**Evidence is sacred.** `observation` rows are append-only. Nothing may edit or
delete one; a correction is a new observation with `supersedes` set. Every derived
number must be recomputable from evidence alone — if you cannot rebuild it with
`primer recompute`, it does not belong in the record.

**The child never talks to a model.** Generated activities are static HTML that
adapts using logic baked in at generation time. No live model path to a child, ever.

**An adult stays in the loop by construction.** The review gate is enforced
server-side, and the unattended tutor has no tool that could turn it off. If you add
a capability the tutor should not have unattended, leave it out of `AUTONOMOUS_TOOLS`
rather than instructing it not to use it.

**Nothing phones home.** No analytics, no telemetry, no crash reporting, no CDN. The
CSP on generated activities enforces this at runtime; keep it that way.

**Say what is true.** If a feature does not work on some platform, the software
should say so where the person will hit it — not only in the README. Several of the
comments in this codebase exist because a claim was false and the failure was silent.

## Working on it

```bash
npm install
npm test                    # 141 tests, no network, no API key needed
npx tsc --noEmit
npm run dev -- targets Ada  # run from source, no build step
npm run package             # build/primer(.exe) — what a user actually installs
```

`npm run package` bundles the source to one CommonJS file and injects it into a copy
of the running `node` as a [single executable](https://nodejs.org/api/single-executable-applications.html).
It only ever produces a binary for the platform you are on; releases are built by a
matrix, one runner per platform. Because that binary has no repository beside it, the
schema, migrations, activity runtime, and curriculum are all generated into
`src/generated/assets.ts` by `npm run embed` and compiled in. **If you add a `.sql` or
curriculum `.json` file, it will work from source and be missing from the binary until
you re-run embed** — which `npm test` and `npm run build` both do for you.

Tests must pass on Node 22.13 and 24, on Linux, macOS and Windows. Nothing may
require credentials to run: the model-facing paths are tested through their
descriptors and their tool surface, not by calling an API.

**Write the test that would have caught it.** Most tests here name a specific way a
real child gets a worse experience — the assertion messages are written to be read
when they fail. A test called `a struggling child is still offered the foundations
underneath` is more useful than `impliedKnown works`.

## Changing the model

`src/domain/bkt.ts` and `src/domain/scheduler.ts` decide what a child practises.
Changes there need worked examples, not just an argument. Several defects in this
code survived review and were caught only by simulating a specific child:

- a foundation eroding to `p_known` 0.0005 for a child who used it daily
- two lucky guesses permanently hiding letter sounds from a child failing to decode
- thirty items in one sitting buying a three-month gap before review

If you change the maths, add a test that fails on the old behaviour and states, in
its name, which child it protects.

## Changing the schema

Forward-only. Add a numbered file to `src/db/migrations/`; never edit `schema.sql`
for anything but a genuinely new install, and never drop or reinterpret a column —
that is a major version and needs a written migration path. Migrations run once,
inside a transaction, and are recorded in `applied_migration`.

## Security

The surface can be exposed to a home network, and it holds a child's complete
history and audio of their voice. If you find something, please open a private
report rather than an issue. Existing boundaries worth understanding before changing
`src/surface/`:

- `Host` validation is what stops DNS rebinding, and it matters even on loopback.
- The child token opens activities only; recordings, notes and the approval page
  never leave the machine.
- Generated activities run under a CSP that permits `connect-src 'self'` and nothing
  else. They are LLM-written code on the same origin as the record.
