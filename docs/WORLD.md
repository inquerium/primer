# The World

The Record answers "what does this child know." It cannot answer "what is worth
knowing, what order does the field teach it in, and what does the evidence say
about how memory works." That second body of knowledge already exists in this
repository, unnamed and frozen at authoring time: the 213-skill curriculum, the
prerequisite graph, the probe templates, and the BKT parameters that SPEC.md
honestly labels principled defaults rather than fitted values.

The World is that body of knowledge, given a name, a schema, and a lifecycle.

## First principle: an artifact, not a service

The World is versioned data in this repository. It ships inside primer
releases and enters a family's machine through `loadCurriculum` and the
existing import path. It is reviewed before it ships and static after.

This preserves the invariant that matters most: the unattended tutor run has
no network access and reaches nothing but the record's MCP tools. The tutor
never fetches The World. It is already on disk. Families never run the
pipeline that maintains it and never know it exists.

## Directory layout

```
world/
  claims/                    pedagogy claims with citations (research lane)
    spacing.md
    bkt-parameters.md
  priors/                    parameter priors derived from claims
    bkt-priors.json
  curriculum/                skill packs and edges (curriculum lane)
    (extends src/curriculum/; same format, plus provenance)
  lenses/                    interest and career lenses (careers lane)
    engineering/
      math.grade-2.measurement.json
      reading.grade-1.blends.json
  trajectories/              upper-grade path metadata (careers lane)
    engineering.json
  WORLD_VERSION              single line, semver, bumped on any admitted change
```

If `world/` does not exist yet, creating this layout is the first task.
`src/curriculum/` remains the loading path families consume; `world/curriculum/`
is where proposals land and are reviewed before being promoted into it.

## Provenance

Every World entry carries a provenance block. No exceptions, including
human-authored entries.

```json
"provenance": {
  "sources": ["<url or doi>", "<url or doi>"],
  "retrieved": "2026-07-30",
  "agreement": 4,
  "review": "unreviewed",
  "reviewer": null,
  "depends_on_claims": ["spacing/half-life-growth", "bkt/guess-two-choice"]
}
```

- `agreement` counts independent sources attesting the same placement or
  claim. Computed, not asserted.
- `review` is one of `unreviewed`, `specialist-reviewed`, `field-tested`.
  Nothing self-promotes. Only a human moves it, and the move is a commit.
- `depends_on_claims` links parameters and curriculum decisions back to the
  claims files, so a retracted claim can be traced to everything downstream.
- The `reviewer` is a named person. An agent cannot appear in this field.

## The three lanes

### Research lane

Sources: learning-science literature. Spaced repetition, testing effect,
Bayesian Knowledge Tracing parameter estimation, accommodation design
evidence.

Output, two artifacts:

1. **Claims files** (`world/claims/*.md`). One claim per entry: the claim in
   one sentence, citations, strength of evidence, and what in primer depends
   on it. Plain text, because pedagogy in this project is inspectable by
   anyone.
2. **Parameter priors** (`world/priors/*.json`). Per-skill-type guess, slip,
   learn, and forgetting-curve priors, each carrying `depends_on_claims`.
   These feed `primer fit` as starting points. They never overwrite fitted
   values from real evidence; fitted always beats prior.

Papers do not map to skills. Do not let this lane produce curriculum.

### Curriculum lane

Sources: public standards frameworks and scope-and-sequence documents.

Output: skill packs and prerequisite edges in the existing curriculum JSON
format plus provenance. Priority is the stated gap: grade 4 and up, and
languages beyond English. Cross-source `agreement` is the mechanizable half of
vetting; whether a sequence is pedagogically defensible is the human half, and
the pipeline must never blur that line.

### Careers lane

Sources: what practitioners in a field actually use, decomposed to the skills
underneath.

Output, two artifacts:

1. **Lenses** (`world/lenses/<name>/`). A lens is not a new skill tree. It is
   a mapping from existing skill IDs to contexts, vocabulary, manipulatives,
   and problem framings. Grade 2 measurement under an engineering lens becomes
   bridge spans and ramp angles. The skill ID, the mastery model, and the
   prerequisite graph do not change.
2. **Trajectories** (`world/trajectories/*.json`). For older learners: which
   existing skills a path leans on hardest, and what new skills appear past
   the current graph. Metadata about paths, never a selection of one.

Lens activation is decided on the family's machine as a function of the
`goal` table (human-set) and the `interest` table (child-revealed, decaying).
A child who wants to be an engineer this year gets the engineering lens; when
that interest fades, the lens fades with it. The World never picks.

## The admission pipeline

Three layers. Each catches what the previous one structurally cannot. A model
validating a model has correlated failure modes, which is why layer two
attacks instead of approving and layer three is human.

**Layer 1, mechanical.** Deterministic checks, no model: schema conformance,
prerequisite cycle detection, duplicate skill IDs, provenance completeness,
agreement counts, reading level of child-facing prompt text, every skill has
assessable success criteria. These run in CI on every pull request, human or
agent, and fail loudly.

**Layer 2, adversarial.** A model prompted to find the reason a proposal is
wrong: a miscited paper, a skill placed a grade early, an edge that only holds
for one teaching sequence. Findings land as a PR comment. This layer filters
what reaches humans. It admits nothing.

**Layer 3, human.** The merge. A named reviewer, recorded in provenance.
Specialists get a queue: entries filtered to `review: "unreviewed"`, sorted by
how many children the change would touch. For the curriculum graph this
liability is real: a wrong edge quietly mis-teaches a real child. An agent
cannot carry that. A named human can.

## Composition at planning time

On the family's machine, the tutor's planning run composes:

```
Record (mastery, misconceptions, interests, accommodations, affect)
  + World (skills, edges, priors, active lens content)
  + Goals (human-set intent)
  = the session plan
```

The scheduler picks the skill from the Record's state against the World's
graph. The active lens, if any, supplies the costume. The tutor writes the
one-off activity. For the genuinely unanticipated case, the tutor's ability to
generate a bespoke activity from the whole child is already the answer, and it
is safe precisely because it is ephemeral and local.

Pin the composition rule as an executable invariant alongside the existing
ones: no World data structure contains a learner ID, and no pipeline code path
can read a family record. The pipeline operates on synthetic fixtures only.

## Build order

1. **Research lane first.** It is the smallest artifact, it bridges
   "principled defaults" to "fitted to data," and it exercises the entire
   pipeline end to end: watch, propose, attack, admit, ship, consumed by
   existing `fit` machinery with zero new family-side code. Start with one
   watcher on spacing and BKT literature, one claims file, one priors
   proposal.
2. **Curriculum lane second.** Grade 4 math, one standards source, one grade
   band. Prove the diff-to-PR loop produces PRs a specialist finds worth
   reading. About three PRs will tell you.
3. **Lenses third**, once the admission pipeline has proven itself on
   lower-stakes content. Ship a handful; the format is JSON so specialists can
   author them without code.

The pipeline that runs these lanes is specified in `docs/OPENCLAW.md`.
