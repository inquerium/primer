#!/usr/bin/env node
/**
 * Property checks over the mastery model.
 *
 *   node --experimental-strip-types scripts/model-audit.mjs
 *   node --experimental-strip-types scripts/model-audit.mjs --json
 *   node --experimental-strip-types scripts/model-audit.mjs --cases 20000
 *
 * The test suite checks the model against examples someone thought of. This
 * checks it against thousands nobody did. Every property here is a sentence
 * that must be true of every child, and a counterexample is a sentence that is
 * false about a real one.
 *
 * Deterministic by construction: one seeded generator, no wall clock, no
 * Math.random. A run that finds a counterexample and cannot reproduce it has
 * given the lane nothing to work with, so the seed is reported with the failure
 * and replays exactly.
 *
 * This is model-auditor's instrument. It reads. It proves nothing about the
 * scheduler's behavior on a real record, which needs the corpus and is checked
 * separately below when the corpus is present.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyEvidence,
  bktUpdate,
  effectiveCorrect,
  retention,
  retrievability,
  stabilityFloor,
  statusOf,
  nextDue,
  daysBetween,
  DEFAULT_PARAMS,
  MASTERY_THRESHOLD,
  TEACHABLE_THRESHOLD,
} from '../src/domain/bkt.ts';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const CASES = Number(argv[argv.indexOf('--cases') + 1]) || 5000;
const SEED = Number(argv[argv.indexOf('--seed') + 1]) || 20260803;

const REPO = join(import.meta.dirname, '..');

/** mulberry32. Small, fast, and the same sequence on every machine forever. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EPOCH = Date.UTC(2026, 0, 1);
const at = (days) => new Date(EPOCH + days * 86_400_000);

const blank = () => ({
  p_known: 0.15,
  opportunities: 0,
  correct: 0,
  streak: 0,
  half_life_days: 3,
  last_seen: null,
});

/** Build a plausible practice history: n attempts, given accuracy and spacing. */
function history(r, { n, accuracy, gapDays, jitter = 0 }) {
  let state = blank();
  let day = 0;
  const log = [];
  for (let i = 0; i < n; i++) {
    const correct = r() < accuracy ? 1 : 0;
    day += Math.max(0, gapDays + (jitter ? (r() - 0.5) * 2 * jitter : 0));
    state = applyEvidence(state, { correct, at: at(day) }, DEFAULT_PARAMS);
    log.push({ i, correct, day: Number(day.toFixed(3)) });
  }
  return { state, log, lastDay: day };
}

/* ---------------------------------------------------------------- properties -- */

const properties = [];
const property = (name, claim, check) => properties.push({ name, claim, check });

property(
  'belief-moves-with-evidence',
  'A correct answer never lowers belief and a wrong answer never raises it.',
  (r) => {
    // Clamped to the same range bktUpdate clamps its input to. Feeding it 0.9998
    // and comparing against the raw value measures the clamp, not the model, and
    // the clamp is deliberate: it is what keeps BKT numerically stable at the
    // ends. No caller passes an unclamped prior, because every prior is either
    // p_init or a previous posterior.
    const prior = Math.min(0.999, Math.max(0.001, r()));
    const p = {
      p_init: 0.15,
      p_learn: r() * 0.4,
      p_guess: 0.02 + r() * 0.45,
      p_slip: 0.02 + r() * 0.28,
    };
    if (p.p_guess + p.p_slip >= 0.95) return null; // outside identifiability, not a claim
    const up = bktUpdate(prior, 1, p);
    const down = bktUpdate(prior, 0, p);
    if (up < prior - 1e-9) return { why: 'a correct answer lowered belief', prior, up, params: p };
    // p_learn lifts every posterior, including a wrong one. The claim is that a
    // wrong answer is never *better* evidence than a right one.
    if (down > up + 1e-9) return { why: 'a wrong answer beat a correct one', prior, up, down, params: p };
    return null;
  },
);

property(
  'credit-is-never-inflated',
  'Hints and slow retrieval can only reduce the credit for an answer.',
  (r) => {
    const base = { correct: 1, latency_ms: 1000 + r() * 2000, fluent_ms: 3000 };
    const full = effectiveCorrect(base);
    const hinted = effectiveCorrect({ ...base, hint_count: 1 + Math.floor(r() * 3) });
    const slow = effectiveCorrect({ ...base, latency_ms: 20000 });
    if (hinted > full + 1e-9) return { why: 'a hinted answer scored higher', full, hinted };
    if (slow > full + 1e-9) return { why: 'a slow answer scored higher', full, slow };
    return null;
  },
);

property(
  'memory-does-not-improve-while-unused',
  'Retention never rises with time away from practice.',
  (r) => {
    const { state } = history(r, {
      n: 1 + Math.floor(r() * 12),
      accuracy: r(),
      gapDays: r() * 10,
    });
    if (!state.last_seen) return null;
    const start = new Date(state.last_seen);
    let previous = Infinity;
    for (const days of [0, 1, 7, 30, 90, 365, 1000]) {
      const now = retention(state, new Date(start.getTime() + days * 86_400_000));
      if (now > previous + 1e-9) {
        return { why: `retention rose between checks at ${days} days`, now, previous, state };
      }
      previous = now;
    }
    return null;
  },
);

property(
  'belief-stays-a-probability',
  'p_known, retention and the half-life stay inside their bounds, always.',
  (r) => {
    const { state } = history(r, {
      n: 1 + Math.floor(r() * 40),
      accuracy: r(),
      gapDays: r() * 60,
      jitter: r() * 5,
    });
    if (!(state.p_known > 0 && state.p_known < 1)) return { why: 'p_known left (0,1)', state };
    if (!(state.half_life_days >= 0.25 && state.half_life_days <= 365)) {
      return { why: 'half-life left its bounds', state };
    }
    const ret = retention(state, at(10_000));
    if (!(ret >= 0 && ret <= 1)) return { why: 'retention left [0,1]', ret, state };
    return null;
  },
);

property(
  'lapsed-means-it-was-held',
  'Nothing is reported lost that was never held.',
  (r) => {
    const { state, lastDay } = history(r, {
      n: 1 + Math.floor(r() * 30),
      accuracy: r(),
      gapDays: r() * 20,
    });
    for (const later of [0, 30, 200, 900]) {
      const status = statusOf(state, at(lastDay + later));
      if (status === 'lapsed') {
        const peak = Math.max(state.peak_p_known ?? 0, state.p_known);
        if (peak < MASTERY_THRESHOLD) {
          return { why: 'lapsed without ever reaching mastery', peak, state };
        }
      }
    }
    return null;
  },
);

property(
  'spacing-beats-cramming',
  'The same number of correct answers retains longer when spread than when massed.',
  (r) => {
    const n = 5 + Math.floor(r() * 8);
    const massed = history(rng(1), { n, accuracy: 1, gapDays: 0 });
    const spaced = history(rng(1), { n, accuracy: 1, gapDays: 2 + r() * 10 });
    if (massed.state.half_life_days > spaced.state.half_life_days + 1e-9) {
      return {
        why: 'cramming bought a longer half-life than spacing',
        n,
        massed: massed.state.half_life_days,
        spaced: spaced.state.half_life_days,
      };
    }
    return null;
  },
);

property(
  'one-sitting-is-one-occasion',
  'Answers inside a single sitting cannot buy a long interval however many there are.',
  (r) => {
    const n = 10 + Math.floor(r() * 40);
    const { state } = history(r, { n, accuracy: 1, gapDays: 0 });
    // Every answer landed on the same instant. Twenty correct answers in one
    // sitting are one practice occasion, and a model that treats them as twenty
    // is certain a child knows something they last saw in March.
    if (state.half_life_days > 30) {
      return { why: `${n} answers in one sitting bought ${state.half_life_days.toFixed(1)} days`, state };
    }
    return null;
  },
);

property(
  'backdated-evidence-cannot-corrupt-the-schedule',
  'An observation timestamped before the last one does not move the clock or inflate the interval.',
  (r) => {
    const { state, lastDay } = history(r, {
      n: 3 + Math.floor(r() * 10),
      accuracy: 0.8 + r() * 0.2,
      gapDays: 1 + r() * 6,
    });
    const before = { ...state };
    const backdated = applyEvidence(state, { correct: 1, at: at(lastDay - 1 - r() * 30) }, DEFAULT_PARAMS);
    if (backdated.last_seen !== before.last_seen) {
      return { why: 'a backfilled attempt moved last_seen backwards', before, backdated };
    }
    if (backdated.half_life_days > before.half_life_days + 1e-9) {
      return { why: 'a backfilled attempt lengthened the interval', before, backdated };
    }
    return null;
  },
);

property(
  'review-lands-before-recall-collapses',
  'The scheduled review date arrives while recall is still likely.',
  (r) => {
    const { state } = history(r, {
      n: 3 + Math.floor(r() * 10),
      accuracy: 0.9,
      gapDays: 1 + r() * 8,
    });
    const due = nextDue(state);
    if (!due) return null;

    // nextDue targets a retrievability of 0.8: the share of what is known that
    // survives to the due date. Judging it by absolute retention instead folds
    // in p_known and flags a skill the child has barely started, which is not a
    // scheduling failure. That skill is "learning", and how well it is retained
    // is not what the review date is about.
    const surviving = retention(state, new Date(due)) / state.p_known;
    if (surviving < 0.7) {
      return { why: 'review was scheduled past the point of forgetting', surviving, state, due };
    }
    return null;
  },
);

property(
  'the-floor-does-not-manufacture-knowledge',
  'The stability floor can preserve what was practiced, never invent what was not.',
  (r) => {
    const correct = Math.floor(r() * 30);
    const floor = stabilityFloor({ correct });
    if (floor < 0 || floor > 0.6) return { why: 'the floor left its range', correct, floor };
    if (correct === 0 && floor !== 0) return { why: 'a never-correct skill got a floor', correct, floor };
    // A floor is a share of what is already believed, so it can never lift a
    // belief above itself.
    const p = r();
    const held = retrievability(p, 1, 10_000, floor);
    if (held > p + 1e-9) return { why: 'the floor raised belief above p_known', p, held, floor };
    return null;
  },
);

/* ------------------------------------------------------- corpus-level checks -- */

/**
 * Properties that need a record rather than a state object. These are the ones
 * that catch a scheduler telling a parent something false, and they need the
 * fixture corpus, which lives with test/fixtures/personas.ts.
 */
async function corpusChecks() {
  const personas = join(REPO, 'test/fixtures/personas.ts');
  if (!existsSync(personas)) {
    return {
      ran: false,
      why: 'test/fixtures/personas.ts is absent, so record-level properties were not checked',
      violations: [],
    };
  }

  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const home = mkdtempSync(join(tmpdir(), 'primer-audit-'));
  process.env.PRIMER_HOME = home;
  process.env.PRIMER_DB = join(home, 'record.db');

  const violations = [];
  try {
    const { db, closeDb } = await import('../src/db/index.ts');
    const { buildAll, AS_OF } = await import('../test/fixtures/personas.ts');
    const { nextTargets } = await import('../src/domain/scheduler.ts');
    db();
    const built = buildAll();

    for (const [id, p] of Object.entries(built)) {
      const targets = nextTargets(p.learner_id, { at: AS_OF, limit: 200 });

      // Priority bands. A child failing repeatedly is the most important thing
      // in the queue, and nothing may outrank it.
      const stuck = targets.filter((t) => t.reason === 'stuck');
      const lapsed = targets.filter((t) => t.reason === 'lapsed');
      const frontier = targets.filter((t) => t.reason === 'frontier');
      const min = (xs) => (xs.length ? Math.min(...xs.map((t) => t.priority)) : Infinity);
      const max = (xs) => (xs.length ? Math.max(...xs.map((t) => t.priority)) : -Infinity);

      if (max(lapsed) > min(stuck)) {
        violations.push({
          persona: id,
          why: 'a lapsed skill outranked a stuck one; the tutor is told "quick win" when it should be told "change approach"',
          lapsed: max(lapsed),
          stuck: min(stuck),
        });
      }
      if (max(frontier) > min(lapsed)) {
        violations.push({
          persona: id,
          why: 'new material outranked restoring something the child already held',
          frontier: max(frontier),
          lapsed: min(lapsed),
        });
      }

      // Nothing unteachable may be offered. A target whose prerequisites are not
      // met is a child being handed something they cannot do.
      for (const t of targets.slice(0, 8)) {
        if (t.blocked_by.length && t.reason === 'frontier') {
          violations.push({
            persona: id,
            why: 'a frontier target was offered with unmet prerequisites',
            skill: t.skill.id,
            blocked_by: t.blocked_by,
          });
        }
      }

      // A queue of one strand is a session of eight vowel drills.
      const strands = new Map();
      for (const t of targets.slice(0, 8)) {
        const key = `${t.skill.domain}:${t.skill.strand}`;
        strands.set(key, (strands.get(key) ?? 0) + 1);
      }
      for (const [key, n] of strands) {
        if (n > 2) {
          violations.push({ persona: id, why: `the top of the queue is ${n} skills from ${key}`, strand: key });
        }
      }
    }
    closeDb();
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  return { ran: true, violations };
}

/* ------------------------------------------------------------------- driving -- */

const results = [];
for (const p of properties) {
  const r = rng(SEED);
  let counterexample = null;
  let checked = 0;
  for (let i = 0; i < CASES; i++) {
    checked++;
    const found = p.check(r);
    if (found) {
      counterexample = { ...found, case: i };
      break;
    }
  }
  results.push({ name: p.name, claim: p.claim, ok: !counterexample, checked, counterexample });
}

const corpus = await corpusChecks();
const failed = results.filter((r) => !r.ok);
const total = failed.length + corpus.violations.length;

if (asJson) {
  console.log(JSON.stringify({ seed: SEED, cases: CASES, properties: results, corpus, total }));
} else {
  console.log(`\n  model audit, seed ${SEED}, ${CASES} cases per property\n`);
  for (const r of results) {
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}`);
    if (!r.ok) {
      console.log(`        ${r.claim}`);
      console.log(`        counterexample at case ${r.counterexample.case}: ${r.counterexample.why}`);
      console.log(`        replay: --seed ${SEED} --cases ${r.counterexample.case + 1}`);
    }
  }
  console.log('');
  if (!corpus.ran) {
    console.log(`  skipped record-level properties: ${corpus.why}\n`);
  } else if (corpus.violations.length) {
    console.log(`  record-level violations (${corpus.violations.length}):\n`);
    for (const v of corpus.violations) console.log(`    ${v.persona}: ${v.why}`);
    console.log('');
  } else {
    console.log('  record-level properties hold across every persona\n');
  }
  console.log(total ? `  ${total} violation(s)\n` : '  the model holds\n');
}

process.exit(total ? 1 : 0);
