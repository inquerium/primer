import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-test-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, all } = await import('../src/db/index.ts');
const { loadCurriculum, findCycle } = await import('../src/curriculum/load.ts');
const { createLearner, resolveLearner, noteInterest, addAccommodation } = await import(
  '../src/record/learners.ts'
);
const { recordObservations, noteMisconception } = await import('../src/record/observations.ts');
const { nextTargets } = await import('../src/domain/scheduler.ts');
const { learnerContext } = await import('../src/record/context.ts');
const { recompute, getMastery, currentP } = await import('../src/record/mastery.ts');
const { TEACHABLE_THRESHOLD } = await import('../src/domain/bkt.ts');
const { exportRecord, progressReport } = await import('../src/record/report.ts');
const { saveInterface, renderInterface, getInterface } = await import('../src/surface/store.ts');

before(() => {
  db();
  loadCurriculum();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('the built-in curriculum loads, resolves, and has no prerequisite cycles', () => {
  const skills = all<{ n: number }>(`SELECT count(*) AS n FROM skill`)[0]!;
  const edges = all<{ n: number }>(`SELECT count(*) AS n FROM skill_edge`)[0]!;
  assert.ok(skills.n > 100, `expected a real curriculum, got ${skills.n} skills`);
  assert.ok(edges.n > 80);
  assert.equal(findCycle(), null);

  const orphans = all<{ id: string }>(
    `SELECT e.from_skill AS id FROM skill_edge e
      LEFT JOIN skill s ON s.id = e.from_skill WHERE s.id IS NULL`,
  );
  assert.deepEqual(orphans, []);
});

test('reloading the curriculum is idempotent', () => {
  const before = all<{ n: number }>(`SELECT count(*) AS n FROM skill`)[0]!.n;
  loadCurriculum();
  const after = all<{ n: number }>(`SELECT count(*) AS n FROM skill`)[0]!.n;
  assert.equal(after, before);
});

test('a new learner starts at the roots of the graph, not the middle', () => {
  const learner = createLearner({ display_name: 'Test Child' });
  const targets = nextTargets(learner.id, { limit: 20 });
  assert.ok(targets.length > 0);
  assert.ok(targets.every((t) => t.blocked_by.length === 0), 'no target may have unmet prerequisites');
  assert.ok(
    targets.some((t) => ['pa_rhyme_recognize', 'cc_count_to_10', 'hw_grip_strokes'].includes(t.skill.id)),
    'early skills should be reachable on day one',
  );
  assert.ok(
    !targets.some((t) => t.skill.id === 'ph_two_syllable_decode'),
    'a grade-2 skill must not surface before its prerequisites',
  );
});

test('evidence moves mastery and unlocks what it should unlock', () => {
  const learner = createLearner({ display_name: 'Evidence Child' });

  const unlockedBefore = nextTargets(learner.id, { limit: 200 }).some(
    (t) => t.skill.id === 'ph_cvc_short_a',
  );
  assert.equal(unlockedBefore, false, 'decoding should be blocked before letter sounds');

  for (const skill of ['al_letter_sounds_consonants', 'al_letter_sounds_short_vowels', 'pa_phoneme_blend_3']) {
    recordObservations(
      learner.id,
      Array.from({ length: 10 }, (_, i) => ({
        skill_id: skill,
        correct: 1,
        item: `item ${i}`,
        ts: new Date(Date.now() - (10 - i) * 86_400_000).toISOString(),
      })),
    );
  }

  const mastery = getMastery(learner.id, 'pa_phoneme_blend_3')!;
  assert.ok(mastery.p_known > 0.9, `p_known was ${mastery.p_known}`);

  const unlockedAfter = nextTargets(learner.id, { limit: 200 }).some((t) => t.skill.id === 'ph_cvc_short_a');
  assert.equal(unlockedAfter, true, 'decoding should open once its prerequisites are solid');
});

test('a skill with many attempts and no progress is flagged as stuck, not repeated', () => {
  const learner = createLearner({ display_name: 'Stuck Child' });
  recordObservations(
    learner.id,
    Array.from({ length: 10 }, (_, i) => ({
      skill_id: 'pa_rhyme_recognize',
      correct: i % 5 === 0 ? 1 : 0,
      item: `pair ${i}`,
    })),
  );
  const target = nextTargets(learner.id, { limit: 200 }).find((t) => t.skill.id === 'pa_rhyme_recognize');
  assert.ok(target, 'the skill should still be a target');
  assert.equal(target!.reason, 'stuck');
});

test('using a skill keeps its foundations alive instead of grinding them down', () => {
  const learner = createLearner({ display_name: 'Foundation Child' });

  // Establish the prerequisites the ordinary way.
  for (const skill of ['al_letter_sounds_consonants', 'al_letter_sounds_short_vowels', 'pa_phoneme_blend_3']) {
    recordObservations(
      learner.id,
      Array.from({ length: 6 }, (_, i) => ({
        skill_id: skill,
        correct: 1,
        item: `item ${i}`,
        ts: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      })),
    );
  }
  const start = getMastery(learner.id, 'al_letter_sounds_short_vowels')!.p_known;
  assert.ok(start > 0.8, `prerequisite should be solid to begin with, was ${start}`);

  // Now read CVC words for two months. Letter sounds are never assessed directly
  // again — but every one of these words exercises them.
  for (let day = 0; day < 60; day++) {
    recordObservations(learner.id, [
      {
        skill_id: 'ph_cvc_short_a',
        correct: 1,
        item: 'cat',
        ts: new Date(Date.UTC(2026, 1, 1 + day)).toISOString(),
      },
    ]);
  }

  const after = getMastery(learner.id, 'al_letter_sounds_short_vowels')!;
  assert.ok(
    after.p_known >= start,
    `constant use must not erode the foundation: ${start} -> ${after.p_known}`,
  );
  assert.ok(
    currentP(after, new Date(Date.UTC(2026, 3, 2))) > TEACHABLE_THRESHOLD,
    'a child reading CVC words daily still knows their vowel sounds',
  );

  // And the scheduler must not be offering vowel-sound practice to that child.
  const targets = nextTargets(learner.id, { at: new Date(Date.UTC(2026, 3, 2)), limit: 200 });
  assert.ok(
    !targets.some((t) => t.skill.id === 'al_letter_sounds_short_vowels'),
    'a fluent decoder should never be scheduled for letter-sound drills',
  );
});

test('mastery recomputed from raw evidence matches mastery accumulated live', () => {
  const learner = createLearner({ display_name: 'Recompute Child' });
  const rows = Array.from({ length: 12 }, (_, i) => ({
    skill_id: 'cc_count_to_10',
    correct: i % 4 === 3 ? 0 : 1,
    item: `count ${i}`,
    ts: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
  }));
  recordObservations(learner.id, rows);
  const live = getMastery(learner.id, 'cc_count_to_10')!;

  recompute(learner.id);
  const rebuilt = getMastery(learner.id, 'cc_count_to_10')!;

  assert.ok(
    Math.abs(live.p_known - rebuilt.p_known) < 1e-9,
    `${live.p_known} vs ${rebuilt.p_known}`,
  );
  assert.equal(live.opportunities, rebuilt.opportunities);
});

test('learner_context answers everything a tutor needs in one call', () => {
  const learner = createLearner({ display_name: 'Context Child', pronouns: 'they/them' });
  addAccommodation(learner.id, 'no_timers', 'No countdown timers.');
  noteInterest(learner.id, 'dinosaurs');
  noteMisconception(learner.id, 'Reads every vowel as short', { skill_id: 'ph_magic_e' });
  recordObservations(learner.id, [{ skill_id: 'cc_count_to_10', correct: 1, item: 'count to 10' }]);

  const ctx = learnerContext(learner.id);
  assert.equal(ctx.learner.name, 'Context Child');
  assert.equal(ctx.learner.pronouns, 'they/them');
  assert.deepEqual(ctx.accommodations, [{ kind: 'no_timers', detail: 'No countdown timers.' }]);
  assert.equal(ctx.interests[0]!.topic, 'dinosaurs');
  assert.equal(ctx.misconceptions.length, 1);
  assert.ok(ctx.targets.length > 0);
  assert.ok(ctx.guidance.length > 0);
  assert.ok(ctx.targets.every((t) => 'probe' in t), 'targets must carry their probe templates');
});

test('resolving a learner by name works, and an unknown name says who exists', () => {
  createLearner({ display_name: 'Findable' });
  assert.equal(resolveLearner('findable').display_name, 'Findable');
  assert.throws(() => resolveLearner('Nobody'), /Known learners/);
});

test('a saved interface is served with the runtime and its identifiers injected', () => {
  const learner = createLearner({ display_name: 'Interface Child' });
  const iface = saveInterface(learner.id, {
    title: 'Dino word hunt',
    html: '<!doctype html><html><head><title>hunt</title></head><body>hi</body></html>',
    kind: 'game',
    target_skills: ['ph_cvc_short_a'],
    spec: { why: 'she likes dinosaurs' },
  });

  const rendered = renderInterface(getInterface(iface.id)!, {
    learner_id: learner.id,
    session_id: 'ses_test',
    api: 'http://127.0.0.1:7333',
  });
  assert.ok(rendered.includes('/runtime.js'), 'runtime must be injected');
  assert.ok(rendered.includes(iface.id));
  assert.ok(rendered.includes('ses_test'));
  assert.ok(rendered.includes('hi'), 'the original body must survive');
});

test('the whole record exports, including raw evidence', () => {
  const learner = createLearner({ display_name: 'Export Child' });
  recordObservations(learner.id, [
    { skill_id: 'cc_count_to_10', correct: 1, item: 'count', response: 'one two three' },
  ]);
  const dump = exportRecord(learner.id) as Record<string, any>;
  assert.equal(dump['format'], 'open-learner-record');
  assert.equal(dump['learner'].length, 1);
  assert.equal(dump['observation'].length, 1);
  assert.equal(dump['observation'][0].response, 'one two three');
  assert.ok(dump['curriculum'].length > 100);
});

test('progress report summarises without inventing prose', () => {
  const learner = createLearner({ display_name: 'Report Child' });
  recordObservations(
    learner.id,
    Array.from({ length: 8 }, (_, i) => ({ skill_id: 'cc_count_to_10', correct: 1, item: `c${i}` })),
  );
  const report = progressReport(learner.id, 30);
  assert.equal(report.totals.observations, 8);
  assert.ok(report.by_domain.length >= 3);
  assert.ok(Array.isArray(report.newly_mastered));
});

test('deleting a learner takes their evidence with them', () => {
  const learner = createLearner({ display_name: 'Delete Child' });
  recordObservations(learner.id, [{ skill_id: 'cc_count_to_10', correct: 1, item: 'x' }]);
  db().prepare(`DELETE FROM learner WHERE id = ?`).run(learner.id);
  const left = all<{ n: number }>(
    `SELECT count(*) AS n FROM observation WHERE learner_id = ?`,
    learner.id,
  )[0]!;
  assert.equal(left.n, 0);
});
