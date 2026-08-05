# Spacing and retrieval

Claims about how practice timing shapes memory, and what in primer depends on
each. One claim per entry. Each entry is a `##` heading whose text is the
claim id, then the claim in one sentence, its strength, what depends on it,
and a fenced `json` provenance block. `scripts/validate-world.mjs` parses
this structure. Keep it.

Citations below were verified against Crossref metadata on 2026-07-30 by
resolving each DOI. Verification of a citation is not review of a claim;
`review` stays `unreviewed` until a named human moves it.

## spacing/spacing-improves-retention

**Claim.** Practice distributed across time produces better delayed retention than the same amount of practice massed into one session.

**Strength.** strong. Cepeda et al. (2006) is a meta-analysis of 317 experiments in verbal recall; the effect is large, robust, and one of the most replicated findings in learning science.

**Depends on this.** `applyEvidence` in `src/domain/bkt.ts` grows the retention half-life as a function of the gap since last practice, not the count of repetitions. Twenty answers in one sitting are treated as one practice occasion.

```json
{
  "provenance": {
    "sources": [
      "doi:10.1037/0033-2909.132.3.354"
    ],
    "retrieved": "2026-07-30",
    "agreement": 1,
    "review": "unreviewed",
    "reviewer": null,
    "depends_on_claims": []
  }
}
```

## spacing/optimal-gap-grows

**Claim.** The gap between practice sessions that best preserves memory grows with how long the material must be retained.

**Strength.** strong. Cepeda et al. (2008) mapped the gap-by-retention-interval surface directly across 1,354 participants; the ridgeline of optimal gaps rises with the retention interval. Shares authors with the 2006 meta-analysis, so the two entries here are attested separately rather than counted as agreeing.

**Depends on this.** The half-life gain in `src/domain/bkt.ts` is driven by the gap relative to the current half-life, so review intervals widen as retention strengthens. `nextDue` schedules the next encounter from the half-life against a target recall of 0.8.

```json
{
  "provenance": {
    "sources": [
      "doi:10.1111/j.1467-9280.2008.02209.x"
    ],
    "retrieved": "2026-07-30",
    "agreement": 1,
    "review": "unreviewed",
    "reviewer": null,
    "depends_on_claims": []
  }
}
```

## spacing/testing-effect

**Claim.** Retrieving material from memory strengthens long-term retention more than restudying it for the same time.

**Strength.** strong. Roediger and Karpicke (2006) showed tested prose passages beat restudied ones at a week despite losing at five minutes, and the finding has an extensive replication record.

**Depends on this.** Probes are retrieval events, not presentations. Every activity must exercise a skill and report observations; `validateInterface` refuses an activity that records nothing.

```json
{
  "provenance": {
    "sources": [
      "doi:10.1111/j.1467-9280.2006.01693.x"
    ],
    "retrieved": "2026-07-30",
    "agreement": 1,
    "review": "unreviewed",
    "reviewer": null,
    "depends_on_claims": []
  }
}
```

## spacing/half-life-growth

**Claim.** Recall probability after practice is well modeled as exponential decay with a half-life that grows when practice is successful and spaced.

**Strength.** moderate. Settles and Meeder (2016) fit a half-life regression to millions of Duolingo practice traces and it outperformed fixed-interval baselines; the functional form is a workable engineering approximation rather than settled theory, and the population is adult language learners, not children.

**Depends on this.** `retrievability` in `src/domain/bkt.ts` is the exponential decay, `half_life_days` in the mastery state is the parameter, and the 3.0-day initial value in the schema and in `world/priors/bkt-priors.json` is the prior this claim anchors.

```json
{
  "provenance": {
    "sources": [
      "doi:10.18653/v1/P16-1174"
    ],
    "retrieved": "2026-07-30",
    "agreement": 1,
    "review": "unreviewed",
    "reviewer": null,
    "depends_on_claims": []
  }
}
```
