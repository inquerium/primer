#!/usr/bin/env node
/**
 * Score the activity reviewer against the sample corpus.
 *
 *   node --experimental-strip-types scripts/activity-audit.mjs
 *   node --experimental-strip-types scripts/activity-audit.mjs --json
 *
 * activity-attacker's instrument. Same asymmetry as the misconception detector,
 * for the same reason: a missed defect leaves an activity slightly worse than it
 * could be, while a fabricated one refuses good work and teaches the tutor that
 * the gate is noise to be routed around. Precision first.
 *
 * The samples that must come back clean carry the weight here. Four of the nine
 * are pages doing something that superficially resembles a violation and is not:
 * a streak named only in a comment, "point to the picture", a decorative star.
 */

import { ACTIVITIES } from '../test/fixtures/activities.ts';
import { reviewActivity } from '../src/surface/activity-review.ts';

const asJson = process.argv.includes('--json');

let truePositives = 0;
let falsePositives = 0;
let falseNegatives = 0;
const rows = [];

for (const sample of ACTIVITIES) {
  const review = reviewActivity(sample.html);
  const found = [...review.refusals, ...review.flags].map((f) => f.rule);
  const want = new Set(sample.expect);
  const got = new Set(found);

  const missed = [...want].filter((r) => !got.has(r));
  const spurious = [...got].filter((r) => !want.has(r));

  truePositives += [...want].filter((r) => got.has(r)).length;
  falseNegatives += missed.length;
  falsePositives += spurious.length;

  rows.push({
    id: sample.id,
    summary: sample.summary,
    ok: missed.length === 0 && spurious.length === 0,
    expected: [...want],
    found: [...got],
    missed,
    spurious,
    refused: review.refusals.length > 0,
  });
}

const precision = truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : 1;
const recall = truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : 1;
const report = {
  precision: Number(precision.toFixed(3)),
  recall: Number(recall.toFixed(3)),
  true_positives: truePositives,
  false_positives: falsePositives,
  false_negatives: falseNegatives,
  rows,
};

if (asJson) {
  console.log(JSON.stringify(report));
} else {
  console.log('\n  activity reviewer against the sample corpus\n');
  console.log(
    `  precision ${report.precision}   recall ${report.recall}   ` +
      `(${truePositives} found, ${falsePositives} spurious, ${falseNegatives} missed)\n`,
  );
  for (const r of rows) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.id.padEnd(24)} ${r.found.join(', ') || '(clean)'}`);
    if (r.missed.length) console.log(`        missed: ${r.missed.join(', ')}`);
    if (r.spurious.length) console.log(`        SPURIOUS: ${r.spurious.join(', ')} on "${r.summary}"`);
  }
  console.log('');
}

// A spurious finding refuses or flags good work. That fails the run.
process.exit(falsePositives > 0 ? 1 : 0);
