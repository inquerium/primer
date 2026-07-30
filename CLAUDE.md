# CLAUDE.md

Context for any Claude Code session working in this repository. Read this file
fully before making changes. It states what this project is, the doctrine that
governs it, and the rules that no refactor, feature, or pipeline may move.

## What this repository is

primer is an open learner record plus an MCP server. One SQLite file per family,
on the family's machine, holding everything one child knows, struggles with,
cares about, and how they learn. An AI tutor (Claude, via the parent's own
Claude Code login) reads the record between sessions, builds a one-off HTML
activity, and queues it for parent approval. The child never talks to a model.
The record is what lasts.

The project answers Y Combinator's RFS "The Primer" while rejecting its
dangerous half: no company should own a decade of a child's most intimate
learning data. The open version must exist before proprietary lock-in accretes.

## The doctrine

One sentence governs every architectural decision:

**The Record knows the child. The World knows the field. The humans know the
goal. The tutor is the only place the three are allowed to meet.**

- **The Record** is the per-family SQLite file. Mastery, misconceptions,
  interests, accommodations, affect, evidence. It never leaves the family's
  machine.
- **The World** is versioned, reviewed, public data shipped with primer
  releases: curriculum packs, prerequisite edges, pedagogy claims with
  citations, parameter priors, and interest lenses. It is an artifact, never a
  service. See `docs/WORLD.md`.
- **The goal** is human-set intent. The `goal` table is written by parents and
  teachers. The `interest` table is revealed by the child and decays if
  unreinforced. The tutor reads both. Nothing else sets direction.
- **The tutor** composes all three at planning time, on the family's machine,
  with no network access.

The composition rule that follows, stated as doctrine and pinned by an
invariant test:

**The World proposes. The Record and the humans dispose.** Nothing in The World
may target, rank, or select content for an individual child. Which lens
activates, which skill comes next, what the session looks like: those decisions
are made by the scheduler and the tutor on the family's machine, as a function
of the Record and the human-set goals. The World is a menu. It is never a hand
on the child's back.

## Hard rules

These are not conventions. Moving any of them requires a conscious, reviewed
decision, and most are already pinned in `test/invariants.test.ts`. If you add
capabilities described in these docs, extend that file to pin the new
boundaries too.

1. The child never talks to a model. Activities are static HTML with logic
   baked in at generation time. No chat box, ever.
2. The unattended tutor run has no Bash, no file read or write, no web fetch.
   It reaches this record's MCP tools and nothing else. The World must be on
   disk, reviewed, before any run starts. Never give the unattended run
   network access to fetch World content live.
3. The parent review gate is enforced server-side. No model-reachable tool can
   change settings, approve its own work, or lift the gate.
4. Nothing phones home. Generated activities are served under a CSP that blocks
   all external requests. The World pipeline (see `docs/OPENCLAW.md`) runs on
   the maintainer's machine only and must never touch a real family record.
5. No streaks, coins, leaderboards, or countdown timers for children.
6. No World content varies by demographic background. Prior knowledge and
   language of instruction are legitimate dimensions. Anything shading into
   demographic targeting is gated behind specialist review with no autonomous
   path at all.
7. Agents never merge. Every World change enters through a pull request
   admitted by a named human. Agents find, propose, and attack. Humans admit.
8. Never fabricate testimonials, user counts, outcomes, or citations. Never
   present unmerged work as shipped. Provenance is machine-readable and every
   claim carries its source.

## Map of this repository's planning docs

- `docs/WORLD.md` describes The World: what it contains, its schemas, its
  admission pipeline, and the build order. This is what to build.
- `docs/OPENCLAW.md` describes the maintainer-side OpenClaw pipeline that
  keeps The World current: agents, watchers, worktrees, and the security
  gates. This is how it runs. Claude Code sessions have no prior knowledge of
  OpenClaw; that file is self-contained.

## Working in this repository

- Node 22+. Storage is `node:sqlite`. One runtime dependency (the MCP SDK).
  `npm test` runs the full suite; run it before and after changes.
- Curriculum is JSON in `src/curriculum/`: a `domain`, skills with `prereq`
  edges and a `probe` template. `loadCurriculum` is idempotent and never
  touches a learner's evidence. World content reaches families through this
  path and through release artifacts, nothing else.
- Migrations are forward-only, numbered files in `src/db/migrations`. Nothing
  drops a column.
- Mastery is a cache. Any model change must keep `recompute_mastery` able to
  replay the whole evidence history.

## Voice

For anything written for the project (docs, site copy, PR descriptions, error
messages a parent will read): measured, concrete, quietly forceful. Short
declarative sentences. No exclamation points, no startup superlatives, no
fear-mongering, no em dashes. Candor is the brand. The prime/Primer wordplay
is used once and prominently, nowhere else.
