#!/usr/bin/env node
/**
 * Score the misconception detector against the corpus.
 *
 *   node --experimental-strip-types scripts/mine-misconceptions.mjs
 *   node --experimental-strip-types scripts/mine-misconceptions.mjs --json
 *
 * This is misconception-miner's instrument, and the only honest way to know
 * whether the detector works. `vowel-confuser` carries a real wrong model in its
 * response column and carries no `misconception` row, deliberately: a detector
 * scored against a record that already names the answer has found nothing.
 *
 * Precision matters more than recall here, and by a lot. A missed misconception
 * is a tutor working slightly blind, which is where it already is. A fabricated
 * one is a tutor teaching against a model the child does not hold, and a parent
 * being told something false about their kid. The thresholds are set for that
 * asymmetry, and this harness exists so that moving them is an argued decision
 * with a number attached.
 */

import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');
const asJson = process.argv.includes('--json');

const personasPath = join(REPO, 'test/fixtures/personas.ts');
if (!existsSync(personasPath)) {
  const msg = 'test/fixtures/personas.ts is absent; there is nothing to score against';
  if (asJson) console.log(JSON.stringify({ ran: false, why: msg }));
  else console.log(`\n  ${msg}\n`);
  process.exit(2);
}

/**
 * What each persona should yield, by construction.
 *
 * This lives here rather than in the corpus so that the corpus stays a
 * description of a child and does not become a description of this detector.
 * A persona should not know what is hunting it.
 */
const GROUND_TRUTH = {
  'vowel-confuser': [{ from: 'e', to: 'i' }],
  // Every other persona holds no readable wrong model. They are the precision
  // test, and they matter as much as the positive case: a detector that fires
  // on `stuck-blending` has learned that failure means confusion, which is the
  // error that would put a fabricated pattern in front of a parent.
  'cold-start': [],
  'cold-start-young': [],
  'stuck-blending': [],
  'lapsed-summer': [],
  crammer: [],
  accommodated: [],
  'above-band': [],
};

const home = mkdtempSync(join(tmpdir(), 'primer-mine-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

let report;
try {
  const { db, closeDb } = await import('../src/db/index.ts');
  const { buildAll } = await import('../test/fixtures/personas.ts');
  const { mineMisconceptions } = await import('../src/domain/misconceptions.ts');

  db();
  const built = buildAll();

  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  const rows = [];

  for (const [id, persona] of Object.entries(built)) {
    const expected = GROUND_TRUTH[id];
    if (!expected) continue;
    const found = mineMisconceptions(persona.learner_id);

    const matched = new Set();
    for (const want of expected) {
      const hit = found.find((f) => f.from === want.from && f.to === want.to);
      if (hit) {
        truePositives++;
        matched.add(hit);
      } else {
        falseNegatives++;
        rows.push({ persona: id, kind: 'missed', want, got: found.map((f) => f.pattern) });
      }
    }
    for (const f of found) {
      if (!matched.has(f)) {
        falsePositives++;
        rows.push({ persona: id, kind: 'fabricated', pattern: f.pattern, confidence: f.confidence });
      }
    }
    if (found.length) {
      for (const f of found) {
        rows.push({
          persona: id,
          kind: matched.has(f) ? 'found' : 'extra',
          pattern: f.pattern,
          skills: f.skill_ids,
          occurrences: f.occurrences,
          distinct_items: f.distinct_items,
          share: f.share,
          confidence: f.confidence,
        });
      }
    }
  }

  const precision = truePositives + falsePositives ? truePositives / (truePositives + falsePositives) : 1;
  const recall = truePositives + falseNegatives ? truePositives / (truePositives + falseNegatives) : 1;

  report = {
    ran: true,
    true_positives: truePositives,
    false_positives: falsePositives,
    false_negatives: falseNegatives,
    precision: Number(precision.toFixed(3)),
    recall: Number(recall.toFixed(3)),
    rows,
  };
  closeDb();
} finally {
  rmSync(home, { recursive: true, force: true });
}

if (asJson) {
  console.log(JSON.stringify(report));
} else {
  console.log(`\n  misconception detector against the corpus\n`);
  console.log(
    `  precision ${report.precision}   recall ${report.recall}   ` +
      `(${report.true_positives} found, ${report.false_positives} fabricated, ${report.false_negatives} missed)\n`,
  );
  for (const r of report.rows) {
    if (r.kind === 'found') {
      console.log(`  ok    ${r.persona}: ${r.pattern}`);
      console.log(
        `        ${r.occurrences} times, ${r.distinct_items} distinct items, across ${r.skills.join(' + ')}`,
      );
      console.log(`        explains ${Math.round(r.share * 100)}% of readable errors, confidence ${r.confidence}`);
    } else if (r.kind === 'fabricated' || r.kind === 'extra') {
      console.log(`  FALSE ${r.persona}: ${r.pattern} (confidence ${r.confidence})`);
    } else if (r.kind === 'missed') {
      console.log(`  MISS  ${r.persona}: expected ${r.want.from} -> ${r.want.to}, found ${JSON.stringify(r.got)}`);
    }
  }
  console.log('');
}

// Precision is the gate. A fabricated pattern is a parent told something false
// about their child, and it fails the run.
process.exit(report.false_positives > 0 ? 1 : 0);
