import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-fit-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, one } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { recordObservations } = await import('../src/record/observations.ts');
const { fitParameters, exportContribution } = await import('../src/domain/fit.ts');

before(() => {
  db();
  loadCurriculum();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('a thin record refuses to fit rather than fitting noise', () => {
  const learner = createLearner({ display_name: 'Thin Record Child' });
  recordObservations(
    learner.id,
    Array.from({ length: 8 }, (_, i) => ({
      skill_id: 'cc_count_to_10',
      correct: i % 3 === 0 ? 0 : 1,
      item: `try ${i}`,
    })),
  );

  const result = fitParameters({ minSamples: 30 });
  assert.equal(result.fitted.length, 0, 'eight attempts must not produce a fitted parameter');

  const skipped = result.skipped.find((s) => s.skill_id === 'cc_count_to_10')!;
  assert.equal(skipped.enough_data, false);
  assert.match(skipped.why_not!, /first attempts/);

  // And the shipped prior is untouched.
  const skill = one<{ p_guess: number }>(`SELECT p_guess FROM skill WHERE id = 'cc_count_to_10'`)!;
  assert.equal(skill.p_guess, 0.2);
});

test('with enough children the estimates track the truth they were generated from', () => {
  // Simulate a skill where guessing is easy (two choices, so ~0.5) and slipping is
  // rare, across enough learners for the estimators to have something to work with.
  const TRUE_GUESS = 0.5;
  const TRUE_SLIP = 0.05;
  let seed = 12345;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let child = 0; child < 40; child++) {
    const learner = createLearner({ display_name: `Sim ${child}` });
    let knows = false;
    const rows = [];
    for (let attempt = 0; attempt < 14; attempt++) {
      // Before they know it, they can still guess right. After, they rarely miss.
      const correct = knows ? (rand() > TRUE_SLIP ? 1 : 0) : rand() < TRUE_GUESS ? 1 : 0;
      rows.push({
        skill_id: 'pa_rhyme_recognize',
        correct,
        item: `item ${attempt}`,
        ts: new Date(Date.UTC(2026, 0, 1 + attempt)).toISOString(),
      });
      if (!knows && rand() < 0.3) knows = true;
    }
    recordObservations(learner.id, rows);
  }

  const result = fitParameters({ minSamples: 30 });
  const fit = result.fitted.find((f) => f.skill_id === 'pa_rhyme_recognize');
  assert.ok(fit, 'forty children should be enough to fit one skill');

  assert.ok(
    Math.abs(fit!.fitted!.p_guess - TRUE_GUESS) < 0.2,
    `guess ${fit!.fitted!.p_guess} should land near ${TRUE_GUESS}`,
  );
  assert.ok(fit!.fitted!.p_slip < 0.2, `slip ${fit!.fitted!.p_slip} should be small`);
  assert.ok(
    fit!.fitted!.p_guess > 0.35,
    'a two-choice skill must not keep the 0.2 default that assumes it is hard to guess',
  );
});

test('nothing is written until --apply is asked for', () => {
  const before = one<{ p_guess: number }>(
    `SELECT p_guess FROM skill WHERE id = 'pa_rhyme_recognize'`,
  )!.p_guess;
  assert.equal(before, 0.2, 'a dry run must not have written anything');

  const applied = fitParameters({ minSamples: 30, apply: true });
  assert.equal(applied.applied, true);

  const after = one<{ p_guess: number; p_slip: number }>(
    `SELECT p_guess, p_slip FROM skill WHERE id = 'pa_rhyme_recognize'`,
  )!;
  assert.notEqual(after.p_guess, before);
  assert.ok(after.p_guess > 0 && after.p_guess < 1);
  assert.ok(after.p_slip > 0 && after.p_slip < 1);
});

test('an exported contribution is just counts, for every skill this install touched', () => {
  const contribution = exportContribution();
  assert.equal(contribution.contribution_format, 1);

  // This install has already generated evidence on both skills used above.
  const rhyme = contribution.skills.find((s) => s.skill_id === 'pa_rhyme_recognize');
  const count = contribution.skills.find((s) => s.skill_id === 'cc_count_to_10');
  assert.ok(rhyme, 'a skill this install has evidence for must be included');
  assert.ok(count, 'a skill with only eight attempts must still be included — the whole point is that a small install can still contribute to a shared threshold');

  // 40 simulated children x 14 attempts each = 560 first-side observations.
  assert.equal(rhyme!.first_attempts, 40);
  assert.ok(rhyme!.first_correct >= 0 && rhyme!.first_correct <= rhyme!.first_attempts);
  assert.ok(rhyme!.post_mastery_wrong <= rhyme!.post_mastery);
  assert.equal(count!.first_attempts, 1, 'first_attempts counts (learner, skill) pairs, not raw rows');

  // Nothing here should ever carry anything besides the six counts and the id.
  for (const s of contribution.skills) {
    assert.deepEqual(
      Object.keys(s).sort(),
      [
        'first_attempts',
        'first_correct',
        'learning_windows',
        'opportunities_before_first_correct',
        'post_mastery',
        'post_mastery_wrong',
        'skill_id',
      ],
      'a contribution row must carry nothing but skill_id and the six counts — no learner id, no item, no timestamp',
    );
  }

  // A skill nobody has ever attempted must not appear at all.
  const untouched = contribution.skills.find((s) => s.skill_id === 'pc_book_orientation');
  assert.equal(untouched, undefined, 'a skill with zero attempts contributes nothing and should not be listed');
});
