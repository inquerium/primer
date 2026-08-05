# The World

Versioned, reviewed, public data that ships inside primer releases. What it
is and why it exists is specified in `docs/WORLD.md`. The pipeline that
maintains it is specified in `docs/OPENCLAW.md`.

Layout:

- `claims/` holds pedagogy claims with citations, one claim per entry.
- `priors/` holds parameter priors derived from claims. They feed `primer fit`
  as starting points. Fitted always beats prior.
- `curriculum/` is where proposed skill packs and edges land. They are
  promoted into `src/curriculum/` after human review, never before.
- `lenses/` holds interest and career lenses: mappings over existing skill
  ids, never new skill trees.
- `trajectories/` holds upper-grade path metadata.
- `WORLD_VERSION` is a single semver line, bumped on any admitted change.

Every entry carries a provenance block, human-authored entries included.
`scripts/validate-world.mjs` enforces the mechanical rules and runs in CI.
Nothing in this directory targets an individual child, and nothing in it may
contain a learner id. The World proposes. The Record and the humans dispose.
