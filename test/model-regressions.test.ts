import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-model-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { recordObservations } = await import('../src/record/observations.ts');
const { nextTargets } = await import('../src/domain/scheduler.ts');
const { getMastery, statusNow } = await import('../src/record/mastery.ts');
const { progressReport } = await import('../src/record/report.ts');
const { applyEvidence, statusOf, DEFAULT_PARAMS } = await import('../src/domain/bkt.ts');

before(() => {
  db();
  loadCurriculum();
});
after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

const fresh = () => ({
  p_known: 0.15,
  opportunities: 0,
  correct: 0,
  streak: 0,
  half_life_days: 3,
  last_seen: null as string | null,
});

test('a struggling child is still offered the foundations underneath', () => {
  // 10% accuracy on CVC words means letter sounds or blending are broken. Two
  // lucky guesses used to mark every ancestor "implied known" and hide them
  // permanently — she would be drilled on CVC words forever while the real gap
  // stayed invisible, and the parent report called those skills "not started".
  const learner = createLearner({ display_name: 'Struggling Child' });
  recordObservations(
    learner.id,
    Array.from({ length: 20 }, (_, i) => ({
      skill_id: 'ph_cvc_short_a',
      correct: i < 2 ? 1 : 0,
      item: `word ${i}`,
      ts: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    })),
  );

  const targets = nextTargets(learner.id, { at: new Date(Date.UTC(2026, 0, 22)), limit: 300 });
  const offered = new Set(targets.map((t) => t.skill.id));

  // The roots of the chain she is failing must be on offer. Skills further up that
  // chain are legitimately *blocked* until their own prerequisites are solid —
  // that is the graph working. What must not happen is them being suppressed as
  // "she has already shown she can do this", which is what two lucky guesses used
  // to buy, permanently and invisibly.
  for (const root of ['al_letter_names_upper', 'pa_rhyme_recognize', 'pa_syllable_count']) {
    assert.ok(offered.has(root), `${root} must be reachable for a child failing what depends on it`);
  }

  // And she must not be offered only more of the thing she cannot do.
  assert.ok(
    targets.some((t) => t.skill.strand !== 'phonics'),
    'a child failing CVC words needs somewhere else to go, not more CVC words',
  );
});

test('a child who has genuinely mastered something is not sent back to its basics', () => {
  const learner = createLearner({ display_name: 'Fluent Child' });
  recordObservations(
    learner.id,
    Array.from({ length: 12 }, (_, i) => ({
      skill_id: 'op_add_within_20',
      correct: 1,
      item: `${i} + 1`,
      ts: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    })),
  );
  const targets = nextTargets(learner.id, { at: new Date(Date.UTC(2026, 0, 14)), limit: 12 });
  assert.ok(
    !targets.some((t) => t.skill.id === 'cc_count_to_10'),
    'counting to ten is not what a child adding within twenty needs',
  );
});

test('status is what is true now, not what was true when it was written', () => {
  const learner = createLearner({ display_name: 'Forgetful Child' });
  recordObservations(
    learner.id,
    Array.from({ length: 8 }, (_, i) => ({
      skill_id: 'cc_count_to_10',
      correct: 1,
      item: `count ${i}`,
      ts: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    })),
  );
  const m = getMastery(learner.id, 'cc_count_to_10')!;
  assert.equal(statusNow(m, new Date(Date.UTC(2026, 0, 10))), 'mastered');

  // More than a year later the model's own arithmetic says she has probably lost
  // it. Saying "mastered" here is a false claim about a child.
  const later = new Date(Date.UTC(2027, 2, 1));
  assert.equal(statusNow(m, later), 'lapsed', 'a stale status must not survive a year of silence');
});

test('a child mid-learning is never reported as having lost a skill she never had', () => {
  // Three correct among many wrong used to read as "lapsed" — telling a parent
  // their child had gone backwards on something she had never once held.
  let state = fresh();
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1 + i));
  for (let i = 0; i < 12; i++) {
    state = applyEvidence(state, { correct: i % 4 === 0 ? 1 : 0, at: at(i) }, DEFAULT_PARAMS);
  }
  assert.ok(state.correct >= 3, 'precondition: several correct answers');
  assert.equal(statusOf(state, at(13)), 'learning', 'never held it, so it cannot have lapsed');
});

test('one enthusiastic sitting does not buy a three-month gap', () => {
  // Twenty items answered at one moment are one practice occasion. Growing the
  // interval per item is exactly the "certain she knows something she last saw in
  // March" failure the spacing model exists to prevent.
  const moment = new Date(Date.UTC(2026, 0, 1));
  let state = fresh();
  for (let i = 0; i < 30; i++) {
    state = applyEvidence(state, { correct: 1, at: moment }, DEFAULT_PARAMS);
  }
  assert.ok(
    state.half_life_days <= 6,
    `thirty items in one sitting must not stretch the interval to ${state.half_life_days.toFixed(1)} days`,
  );

  // Spread across widening gaps, the same thirty answers should earn far more.
  let spaced = fresh();
  for (let i = 0; i < 8; i++) {
    spaced = applyEvidence(spaced, { correct: 1, at: new Date(Date.UTC(2026, 0, 1 + i * i)) }, DEFAULT_PARAMS);
  }
  assert.ok(
    spaced.half_life_days > state.half_life_days,
    'spacing, not repetition, is what earns a longer interval',
  );
});

test('evidence timestamped out of order cannot corrupt the schedule', () => {
  const base = applyEvidence(fresh(), { correct: 1, at: new Date(Date.UTC(2026, 2, 10)) }, DEFAULT_PARAMS);
  for (const daysBack of [0.5, 1.0, 1.2, 1.21, 1.5, 3]) {
    const backdated = applyEvidence(
      base,
      { correct: 1, at: new Date(Date.UTC(2026, 2, 10) - daysBack * 86_400_000) },
      DEFAULT_PARAMS,
    );
    assert.ok(
      backdated.half_life_days <= base.half_life_days + 0.001,
      `backfilling ${daysBack}d earlier must not stretch the interval ` +
        `(${base.half_life_days} -> ${backdated.half_life_days})`,
    );
    assert.equal(backdated.last_seen, base.last_seen, 'the clock must not run backwards');
  }
});

test('a child failing repeatedly stays at the top of the queue, not the bottom', () => {
  // The signal that says "try a different approach" used to be visible for about
  // two hours after a session and then vanish, because a failing skill's interval
  // collapses and `review_due` was checked first. The tutor runs the next day.
  const learner = createLearner({ display_name: 'Stuck Child' });
  const start = Date.UTC(2026, 0, 1);
  recordObservations(
    learner.id,
    Array.from({ length: 12 }, (_, i) => ({
      skill_id: 'pa_rhyme_recognize',
      correct: 0,
      item: `pair ${i}`,
      ts: new Date(start + i * 3_600_000).toISOString(),
    })),
  );

  for (const hoursLater of [1, 24, 24 * 7]) {
    const targets = nextTargets(learner.id, {
      at: new Date(start + 12 * 3_600_000 + hoursLater * 3_600_000),
      limit: 300,
    });
    const stuck = targets.find((t) => t.skill.id === 'pa_rhyme_recognize');
    assert.ok(stuck, `still a target ${hoursLater}h later`);
    assert.equal(stuck!.reason, 'stuck', `still flagged as stuck ${hoursLater}h later`);
    assert.equal(
      targets[0]!.skill.id,
      'pa_rhyme_recognize',
      `a child failing twelve times running should top her own queue at ${hoursLater}h`,
    );
  }
});

test('the parent report counts what is true today', () => {
  const learner = createLearner({ display_name: 'Report Truth Child' });
  recordObservations(
    learner.id,
    Array.from({ length: 8 }, (_, i) => ({
      skill_id: 'cc_count_to_10',
      correct: 1,
      item: `c${i}`,
      ts: new Date(Date.UTC(2020, 0, 1 + i)).toISOString(),
    })),
  );

  // Practised once, six years ago. Nothing may claim this is mastered.
  const report = progressReport(learner.id, 30);
  const math = report.by_domain.find((d) => d.domain === 'math')!;
  assert.equal(math.mastered, 0, 'six years of silence is not mastery');
  assert.ok(
    report.slipped_since_last_practice.some((s) => s.id === 'cc_count_to_10'),
    'it should be surfaced as something that has slipped',
  );
  assert.equal(report.newly_mastered.length, 0);
});
