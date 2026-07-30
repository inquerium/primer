# The Open Learner Record interchange format

This document specifies the file `primer export` writes and `primer import` reads. It
exists so that the record is portable in fact, not just in principle: any tutoring
system — this one, a fork of it, or something unrelated — can read a child's whole
history, write a compatible file back, and never hold the only copy of anything.

The promise this format serves is stated in [SPEC.md](SPEC.md): **the family can take
everything and leave at any time.** A format only one program can read is not
portability; it is a hostage with better manners. So this file is the contract, kept
deliberately small, and versioned separately from any implementation.

## The envelope

A single JSON object:

```jsonc
{
  "format": "open-learner-record",   // REQUIRED. Literal. How an importer recognizes the file.
  "format_version": 1,               // Version of THIS contract. Absent means 1.
  "schema_version": "0.1",           // The exporter's internal schema version. Informational.
  "exported_at": "2026-07-29T…Z",    // When the file was written. Informational.

  "learner": [ { … } ],              // Exactly one row: the child this file is about.

  // One array per record table, every row scoped to this learner:
  "accommodation": [ … ],
  "interest": [ … ],
  "goal": [ … ],
  "note": [ … ],
  "mastery": [ … ],
  "session": [ … ],
  "observation": [ … ],
  "misconception": [ … ],
  "affect": [ … ],
  "interface": [ … ],
  "artifact": [ … ],
  "planned_activity": [ … ],

  // The shared curriculum the rows above refer to:
  "curriculum": [ … ],               // Every skill row, with `probe` parsed to an object.
  "skill_edges": [ … ]               // The prerequisite graph between them.
}
```

Row shapes mirror the tables defined in [SPEC.md](SPEC.md) and `src/db/schema.sql`.
Field-by-field semantics live there and are not repeated here.

## What travels and why

**The curriculum travels with the record.** `mastery.skill_id` and
`observation.skill_id` are references into a skill graph. A record that arrives
without its graph has lost its meaning: "she mastered `ph_magic_e`" is information
only if the receiver knows what `ph_magic_e` is. The exporter therefore includes
every skill and edge it has, and an importer fills the gaps it is missing (see
importer requirements below).

**Generated interfaces travel as HTML.** An `interface` row stores an absolute file
path on the exporting machine, which means nothing anywhere else. The exporter
inlines each file's contents as an extra `html` field on the row. `html` is part of
the envelope, not of any table.

**Artifact files do not travel** (recordings can be large and are the most sensitive
thing in the record). An `artifact` row carries its metadata and its path on the
exporting machine; moving the files themselves is a human decision made separately.

## Requirements for an importer

An import file is an **untrusted document**, whatever it claims about its origin.
A conforming importer:

1. **MUST refuse** a file whose `format` is not `open-learner-record`, and a
   `format_version` greater than the newest it understands.
2. **MUST mint fresh ids** for the learner and every row, rewriting every reference
   (`learner_id`, `session_id`, `interface_id`, `supersedes`) to match. Importing
   the same file twice must produce two children, never a silent merge.
3. **MUST NOT trust identifiers into dangerous positions.** Row-id prefixes, skill
   ids, and any value that flows into markup, SQL identifiers, or filenames must be
   validated against a conservative pattern before use, and rejected rows skipped
   with a warning rather than failing the whole import.
4. **MUST NOT store foreign filesystem paths.** An `interface` row is materialized
   from its inlined `html`; an `artifact` row is kept only if its file can be copied
   into the importer's own storage, and dropped (with a warning) otherwise. Storing
   a path from the envelope verbatim turns a later "delete this child" into a
   deletion of an arbitrary file.
5. **SHOULD fill missing curriculum from the envelope, and the local curriculum
   always wins.** A skill the importer already has is never modified by an import —
   a record is evidence about one child, not an authority on the curriculum. A skill
   the importer lacks is inserted (after validation) so the child's evidence keeps
   its meaning. Edges are added only where at least one endpoint was newly filled:
   the envelope must never rewire the graph between skills the importer already has.
6. **MUST ignore fields and tables it does not recognize** rather than failing.
   Exports from newer implementations may carry more than this document names.
7. **MAY discard `mastery` and recompute it.** Mastery is a derived cache; the
   observations are the truth. A conforming record can always be rebuilt from its
   `observation` rows alone (this is the append-only guarantee doing its job), and
   an importer that distrusts the cache should replay instead.

## Guarantees an exporter makes

1. `observation` rows are append-only history: none has ever been updated or
   deleted. Corrections appear as new rows with `supersedes` pointing at the row
   they replace.
2. Every `mastery` row is derivable from the `observation` rows in the same file.
3. Every `skill_id` referenced by any row appears in `curriculum`.
4. The file contains exactly one learner and nothing about any other learner.

## Versioning

- `format_version` is a single integer. It increments only when a change would
  mislead an existing importer — removing a field, changing a field's meaning, or
  changing a structural rule above. Additions are not breaking: importers ignore
  what they don't recognize (rule 6).
- A file without `format_version` is version 1.
- This document is versioned with the format, not with primer. Implementations
  other than primer are welcome and are the point.
