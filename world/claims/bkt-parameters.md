# Bayesian Knowledge Tracing parameters

Claims about the BKT mastery model and its parameters. Same structure as
`spacing.md`: one claim per `##` entry, one sentence, strength, dependents,
and a fenced `json` provenance block.

Citations below were verified against Crossref metadata on 2026-07-30 by
resolving each DOI. Verification of a citation is not review of a claim.

## bkt/four-parameter-model

**Claim.** Student knowledge of a skill can be tracked as a two-state model with init, learn, guess, and slip parameters updated from each observed response.

**Strength.** strong. Corbett and Anderson (1995) introduced the model, and it has since been the standard baseline for mastery estimation in intelligent tutoring systems for three decades.

**Depends on this.** `bktUpdate` and `DEFAULT_PARAMS` in `src/domain/bkt.ts`, the per-skill parameter columns in the schema, and the estimators in `src/domain/fit.ts`.

```json
{
  "provenance": {
    "sources": [
      "doi:10.1007/BF01099821"
    ],
    "retrieved": "2026-07-30",
    "agreement": 1,
    "review": "unreviewed",
    "reviewer": null,
    "depends_on_claims": []
  }
}
```

## bkt/guess-two-choice

**Claim.** The guess parameter tracks the chance rate of the item's answer format, so a two-choice item has a guess rate near one half while a constructed response has one near zero.

**Strength.** moderate. Corbett and Anderson (1995) treat guess as a per-skill parameter and cap it well below chance-plus-knowledge ambiguity; Baker, Corbett, and Aleven (2008) show guess and slip vary with context and that modeling that variation improves fit. The two papers share an author, so agreement is counted as one, and the specific two-choice value is arithmetic about the format, not a study result.

**Depends on this.** The per-skill-type guess priors in `world/priors/bkt-priors.json`, and the `GUESS_CEILING` of 0.5 in `src/domain/fit.ts`.

```json
{
  "provenance": {
    "sources": [
      "doi:10.1007/BF01099821",
      "doi:10.1007/978-3-540-69132-7_44"
    ],
    "retrieved": "2026-07-30",
    "agreement": 1,
    "review": "unreviewed",
    "reviewer": null,
    "depends_on_claims": []
  }
}
```

## bkt/identifiability

**Claim.** BKT parameters are not identifiable from response data alone, and unconstrained fits can reach degenerate regions where a wrong answer raises the estimate that the student knows the skill.

**Strength.** strong. Beck and Chang (2007) demonstrated that multiple parameter sets fit the same data with different mastery predictions, which is why every serious implementation constrains the parameter space.

**Depends on this.** `fitParameters` in `src/domain/fit.ts` refuses to apply a fit when guess plus slip reaches 0.95, and `scripts/validate-world.mjs` applies the same coherence bound to proposed priors.

```json
{
  "provenance": {
    "sources": [
      "doi:10.1007/978-3-540-73078-1_17"
    ],
    "retrieved": "2026-07-30",
    "agreement": 1,
    "review": "unreviewed",
    "reviewer": null,
    "depends_on_claims": []
  }
}
```
