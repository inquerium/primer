# The Open Learner Record (OLR) — v0.1

A portable, local-first record of everything one child knows, is learning, has struggled
with, cares about, and how they like to be taught.

This spec exists for the same reason FHIR exists in medicine: the record must outlive any
one vendor, any one app, any one model. A child's learning history is theirs. If the
company that made the tutor disappears, the record must still open.

## Design principles

1. **The record is the product. The interface is disposable.**
   There is no canonical UI. A tutor (today: Claude) reads the record and generates an
   interface for this child, this minute. Tomorrow's interface may look nothing like
   today's. The record persists across all of them.

2. **Local-first, single file.** One SQLite file per child (or per family). It lives on
   the family's machine. Sync is opt-in and additive, never required.

3. **Evidence, not scores.** Every mastery estimate is derived from raw observations that
   are kept forever. You can always recompute the model with a better model. A number with
   no evidence behind it is not allowed in this record.

4. **Auditable.** Every write is logged with actor, timestamp, and payload. A parent can
   ask "why does it think she can't do vowel teams" and get a list of exact attempts.

5. **Exportable in full.** `primer export` writes the entire record as JSON. No lock-in is
   the whole point. The file it writes is a documented interchange format, not a private
   dump — [FORMAT.md](FORMAT.md) is the contract, versioned so that other implementations
   can read and write it.

6. **Boring, small schema.** Twenty tables. If it can't be expressed here, propose an
   extension rather than a private column.

## Entities

### `learner`
The child. Minimal PII by design: a display name, an approximate birth date (used only to
pick the starting guess for cold-start placement — see `src/domain/placement.ts`), locale,
timezone.

### `skill`
An atom of learning. Not a lesson, not a worksheet — the smallest thing you can be said to
know or not know. `cvc_short_a` ("decode CVC words with short a") is a skill. "Unit 3" is
not.

Fields: `domain` (reading | writing | math), `strand` (phonological_awareness, place_value,
…), `grade_band` (pk, k, 1, 2, 3), `ordinal` (teaching order within strand), `probe` (a JSON
template describing how to generate an assessment item for this skill), `tags`.

`probe` is what lets a tutor generate fresh items forever instead of shipping a fixed item
bank. Example:

```json
{ "type": "decode", "pattern": "C{short_a}C", "examples": ["cat", "map", "sad"],
  "distractors": ["cot", "mop"], "prompt": "Read this word out loud." }
```

### `skill_edge`
Directed graph over skills. `kind` is one of:
- `prerequisite` — must be reasonably solid before the target is teachable
- `component` — target decomposes into this
- `extends` — same idea, harder

A skill is **teachable** when every `prerequisite` parent has `p_known >= 0.7`.

### `mastery`
One row per (learner, skill). Holds the Bayesian Knowledge Tracing state:
`p_known`, `opportunities`, `correct`, plus a forgetting model: `half_life_days`,
`last_seen`, `next_due`. `status` ∈ `unseen | learning | mastered | lapsed`.

`p_known` is always recomputable from `observation`. It is a cache, never the source of
truth.

### `observation`
The atom of evidence. One attempt at one thing.

`kind` ∈ `attempt | probe | self_report | tutor_judgment | artifact_review`
plus `correct` (0/1/partial), `latency_ms`, `hint_count`, `item` (what was actually asked),
`response` (what the child actually did), `expected`, `modality`
(`spoken | typed | drawn | selected | manipulated`), `source` (which interface produced it).

Observations are never deleted or edited. Corrections are new observations with
`supersedes` pointing at the old one.

### `misconception`
A *stable wrong model*, not a wrong answer. "Reads every vowel as short" or "believes
larger digit count always means larger number." Has `pattern`, `evidence_count`,
`first_seen`, `last_seen`, `status` ∈ `active | fading | resolved`.

This is the single highest-value thing in the record. It is what a great tutor carries in
their head about a student and what every worksheet app throws away.

### `interest`
What the child actually cares about — dinosaurs, drawing, a particular game, their dog's
name. `weight` decays if unreinforced. This is the raw material for every generated story
problem and every generated interface.

### `affect`
Engagement signal attached to a moment: `frustration | delight | flow | fatigue | boredom`,
with intensity and the evidence that suggested it (e.g. "3 abandoned attempts in 40s",
"asked to do one more"). Sessions are shaped by this more than by accuracy.

### `accommodation`
Standing instructions about how this child must be taught. Dyslexia-friendly typography,
audio-first, no timers, high contrast, extra processing time. Every generated interface
MUST honor every active accommodation. This is a hard constraint, not a hint.

### `session`
A bounded stretch of tutoring. `mode` (`play | practice | assess | story | free`),
`summary` written by the tutor at the end, `energy`, and a pointer to the interface used.

### `interface`
**The memory of what UI worked.** When the tutor generates an interface, it is saved here
with the spec that produced it, the skills it targeted, and afterwards an `outcome_score`
derived from what happened inside it (accuracy, engagement, completion, affect).

Over months this becomes a per-child library of proven interaction designs — the record
learns not just what the child knows, but how to reach them.

### `artifact`
The child's actual work: an audio clip of them reading, a photo of handwriting, a drawing.
Stored as files with pointers. This is what a parent wants to see in five years.

### `goal`, `note`
Human-set intent and human-written observations. Parents and teachers write here. The tutor
reads.

### `planned_activity`
What the child will meet next, in order. The child's screen reads from here and
nothing else — there is no library, no menu, no chat box.

A row is `pending_review` until an adult approves it. `status` moves
`pending_review → ready → delivered → done`, or stops at `rejected`. A rejection
carries a `review_note`, which is read back into the next planning run: telling the
tutor why is more useful than silently blocking it.

### `agent_run`
One row per autonomous planning cycle: what triggered it, how many turns, tokens in
and out, cache hits, dollars, how many activities it produced, and what it decided.
A system that runs unattended for years has to be answerable for any given day.

### `setting`
Per-install configuration, in the record rather than a config file, because the
settings that govern an autonomous system belong in the audited data. `review_required`
(default on), daily and monthly budget ceilings, queue target, model, effort, minimum
gap between runs. Every change is logged with an actor.

### `event_log`
Append-only audit of every mutation: actor, tool, timestamp, payload hash.

## The loop

```
  ┌─ record ──────────────────────────────────────────────┐
  │ mastery · misconceptions · interests · accommodations │
  │ affect · what interfaces worked                       │
  └───────────────┬───────────────────────────────────────┘
                  │  learner_context
                  ▼
          ┌───────────────┐
          │ tutor (Claude)│  reads the whole child, decides what to
          └───────┬───────┘  teach and how to reach them today
                  │  save_interface
                  ▼
      ┌───────────────────────────┐
      │ a UI that did not exist   │  built for this child, this minute
      │ ten seconds ago           │  instrumented with primer runtime
      └───────────┬───────────────┘
                  │  observations stream back automatically
                  └──────────────► record
```

The generated interface is instrumented: `primer.observe({...})` posts every attempt back
into `observation` in real time. There is no manual data entry step and no separate
"progress tracking" feature. Using the thing *is* the assessment.

## Two clocks

The loop above runs at two speeds, and keeping them separate is a design rule, not
an implementation detail.

**The fast loop — a child working — contains no model.** The interface is a static
file that adapts using logic decided in advance. This is not a performance
compromise: a live model in the child's path means latency they must wait through,
cost that scales with attention, and a text channel between a young child and a
model. All three are avoidable, so they are avoided.

**The slow loop — between sessions — is where the model works.** It reads the record,
decides, builds, and queues. It has no access to the child and no ability to change
the standing facts about them: an unattended process may not create or delete
learners, alter accommodations, or set goals. Those tools exist for a human driving
the same record, and are absent from the autonomous surface by construction rather
than by instruction.

The model is reached through the operator's existing Claude Code login, not an API
key. There is one tool surface — this record's MCP server — and two things that
drive it: a person working interactively, and an unattended `claude -p` run with
every built-in tool disabled and an explicit allowlist of record tools. A capability
the unattended run should not have is one it is not given, not one it is asked not
to use.

**Nothing generated reaches a child unreviewed by default.** `review_required` ships
on. An adult reads the tutor's stated rationale, opens the activity themselves, and
approves or rejects it with a note that the next planning run will read. Turning the
gate off is permitted and is recorded in `event_log` with who did it.

**Spend is bounded in the record.** Daily and monthly ceilings are checked before a
run starts and again after every turn. A run that hits the ceiling stops mid-flight
and says so.

## Invariants

The boundaries above are not conventions — they are pinned as executable doctrine in
`test/invariants.test.ts`, so that moving any of them has to be a conscious, reviewed
decision rather than a side effect of a refactor:

| Guarantee | Enforced by |
|---|---|
| The unattended tutor's reach is exactly its allowlist, and every exposed tool is consciously classified as allowed or withheld | `test/invariants.test.ts`, `test/acp.test.ts` (both transports agree) |
| No model-reachable tool can change settings — the review gate and budgets cannot be reached by prompt injection | `test/invariants.test.ts` |
| The tutor cannot approve its own work: `plan_activity` has no status channel, and the gate is the install's setting, not the model's choice | `test/invariants.test.ts`, `test/autonomy.test.ts` |
| Recordings are opaque to the model — metadata and human notes only, never the path, never the bytes | `test/invariants.test.ts` |
| An activity that phones home, or reports nothing back to the record, is refused before it can be saved | `test/invariants.test.ts`, `test/validate.test.ts` |
| Generated activities are served under a CSP that stops them talking to anything but this record | `test/security.test.ts` |
| Deletion is real and export is complete — the family can always take everything and leave | `test/forget.test.ts`, `test/portability.test.ts` |

A failing test in that file means a capability boundary moved. If the move is right,
the PR that moves it must say why.

## What is deliberately not in the spec

- **No lesson content.** No videos, no fixed item banks, no scripted curriculum. Skills
  carry `probe` templates; the tutor generates the rest, fresh, forever.
- **No UI schema.** Interfaces are HTML. Constraining them would defeat the point.
- **No leaderboards, streaks, or coins.** Extrinsic motivation is a design choice an
  implementer can make; it does not belong in the record.
- **No cloud.** Sync is an extension, not the core.

## Privacy stance

- Data stays on disk unless the operator explicitly moves it.
- Minimum viable PII: no address, no school, no photos required, no full legal name needed.
- `primer export` and `primer delete --learner` both work and are tested. Deletion is real
  deletion, including artifacts on disk.
- Nothing in this repo phones home.

## Versioning

`schema_version` in `meta`. Migrations are forward-only and shipped in `src/db/migrations`.
Any change that drops or reinterprets an existing column is a major version.
