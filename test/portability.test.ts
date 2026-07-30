import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-portability-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, all, one, run } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { recordObservations } = await import('../src/record/observations.ts');
const { getMastery, recompute } = await import('../src/record/mastery.ts');
const { exportRecord, importRecord } = await import('../src/record/report.ts');

before(() => {
  db();
  loadCurriculum();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

// A skill no shipped pack defines — the kind a family's custom pack, or a fork,
// or a future primer would add. If the record can't carry this across installs,
// "you can take everything and leave" is only true for stock installs.
const CUSTOM = 'mu_steady_beat';
function addCustomSkill() {
  run(
    `INSERT INTO skill (id, domain, strand, name, description, grade_band, ordinal, probe, p_init, p_learn, p_guess, p_slip)
     VALUES (?, 'music', 'rhythm', 'Keeps a steady beat', 'Claps along without drifting', 'k', 10,
             '{"type":"perform","prompt":"Clap with the song."}', 0.15, 0.2, 0.25, 0.1)`,
    CUSTOM,
  );
  run(
    `INSERT INTO skill_edge (from_skill, to_skill, kind) VALUES ('pa_rhyme_recognize', ?, 'prerequisite')`,
    CUSTOM,
  );
}

test('a record survives landing on an install that never had its curriculum', () => {
  addCustomSkill();
  const child = createLearner({ display_name: 'Traveler', birth_date: '2019-01-01' });
  recordObservations(child.id, [
    { skill_id: CUSTOM, correct: 1, item: 'clap 1', ts: '2026-07-01T10:00:00Z' },
    { skill_id: CUSTOM, correct: 1, item: 'clap 2', ts: '2026-07-02T10:00:00Z' },
    { skill_id: 'cc_count_to_10', correct: 1, item: 'count', ts: '2026-07-01T10:05:00Z' },
  ]);
  const masteryBefore = getMastery(child.id, CUSTOM)!;

  const envelope = exportRecord(child.id);
  assert.equal(envelope['format_version'], 1);
  assert.ok(
    (envelope['curriculum'] as Array<{ id: string }>).some((s) => s.id === CUSTOM),
    'the curriculum must travel with the record',
  );

  // Simulate the receiving install: it never loaded the custom pack.
  run(`DELETE FROM learner WHERE id = ?`, child.id);
  run(`DELETE FROM skill WHERE id = ?`, CUSTOM);
  assert.equal(one(`SELECT id FROM skill WHERE id = ?`, CUSTOM), undefined);

  const result = importRecord(envelope as Record<string, unknown>);
  assert.ok(
    !result.warnings.some((w) => w.includes(CUSTOM)),
    `nothing about the custom skill should warn, got: ${JSON.stringify(result.warnings)}`,
  );
  assert.equal(result.rows['skills_filled'], 1, 'exactly the one missing skill is filled');
  assert.equal(result.rows['skill_edges_filled'], 1, 'its edge into the local graph comes too');

  // The child's history on that skill means what it meant on the old install.
  const landed = getMastery(result.learner_id, CUSTOM)!;
  assert.equal(landed.p_known, masteryBefore.p_known);
  assert.equal(landed.opportunities, masteryBefore.opportunities);
  const edge = one(
    `SELECT 1 AS x FROM skill_edge WHERE from_skill = 'pa_rhyme_recognize' AND to_skill = ?`,
    CUSTOM,
  );
  assert.ok(edge, 'the prerequisite edge is restored');

  // And the deeper guarantee: the cache is disposable. Rebuilt from the raw
  // observations that traveled in the same file, mastery comes out the same.
  recompute(result.learner_id);
  const rebuilt = getMastery(result.learner_id, CUSTOM)!;
  assert.ok(Math.abs(rebuilt.p_known - masteryBefore.p_known) < 1e-9);
});

test('the local curriculum always wins over the envelope', () => {
  const child = createLearner({ display_name: 'Tamper Source' });
  recordObservations(child.id, [{ skill_id: 'cc_count_to_10', correct: 1, item: 'x' }]);
  const envelope = exportRecord(child.id) as Record<string, any>;

  // A doctored envelope claims counting to ten is guessable 90% of the time and
  // renames it. An import is evidence about one child, not curriculum authority.
  const doctored = (envelope['curriculum'] as Array<Record<string, unknown>>).find(
    (s) => s['id'] === 'cc_count_to_10',
  )!;
  doctored['p_guess'] = 0.9;
  doctored['name'] = 'Totally different skill';

  importRecord(envelope);
  const local = one<{ name: string; p_guess: number }>(
    `SELECT name, p_guess FROM skill WHERE id = 'cc_count_to_10'`,
  )!;
  assert.equal(local.name, 'Counts to 10');
  assert.equal(local.p_guess, 0.2);
});

test('an envelope cannot rewire the graph between skills this install already has', () => {
  const child = createLearner({ display_name: 'Rewire Source' });
  recordObservations(child.id, [{ skill_id: 'cc_count_to_10', correct: 1, item: 'x' }]);
  const envelope = exportRecord(child.id) as Record<string, any>;

  (envelope['skill_edges'] as Array<Record<string, unknown>>).push({
    from_skill: 'op_multiply_intro',
    to_skill: 'cc_count_to_10',
    kind: 'prerequisite',
  });

  importRecord(envelope);
  const bogus = one(
    `SELECT 1 AS x FROM skill_edge WHERE from_skill = 'op_multiply_intro' AND to_skill = 'cc_count_to_10'`,
  );
  assert.equal(bogus, undefined, 'multiplication must not become a prerequisite for counting');
});

test('a hostile skill id is refused, and the rows that used it degrade the old way', () => {
  const child = createLearner({ display_name: 'Hostile Source' });
  recordObservations(child.id, [{ skill_id: 'cc_count_to_10', correct: 1, item: 'x' }]);
  const envelope = exportRecord(child.id) as Record<string, any>;

  const evil = `x'); DROP TABLE skill; --`;
  (envelope['curriculum'] as Array<Record<string, unknown>>).push({
    id: evil,
    domain: 'reading',
    strand: 'phonics',
    name: 'Evil',
  });
  (envelope['mastery'] as Array<Record<string, unknown>>).push({
    learner_id: (envelope['learner'] as Array<{ id: string }>)[0]!.id,
    skill_id: evil,
    p_known: 0.5,
    opportunities: 1,
    correct: 1,
    streak: 1,
    half_life_days: 3,
    status: 'learning',
  });

  const result = importRecord(envelope);
  assert.ok(result.warnings.some((w) => w.includes('fails validation')));
  assert.equal(one(`SELECT 1 AS x FROM skill WHERE id = ?`, evil), undefined);
  assert.ok(one(`SELECT 1 AS x FROM skill WHERE id = 'cc_count_to_10'`), 'the skill table survived');
});

test('an envelope from before format_version still imports', () => {
  const child = createLearner({ display_name: 'Old Envelope' });
  recordObservations(child.id, [{ skill_id: 'cc_count_to_10', correct: 1, item: 'x' }]);
  const envelope = exportRecord(child.id) as Record<string, any>;
  delete envelope['format_version'];

  const result = importRecord(envelope);
  assert.ok(result.learner_id);
  assert.equal(result.rows['observation'], 1);
});

test('everything the format promises about the envelope is true of a real export', () => {
  const child = createLearner({ display_name: 'Promise Check' });
  recordObservations(child.id, [
    { skill_id: 'cc_count_to_10', correct: 1, item: 'a' },
    { skill_id: 'pa_rhyme_recognize', correct: 0, item: 'b' },
  ]);
  const envelope = exportRecord(child.id) as Record<string, any>;

  assert.equal(envelope['format'], 'open-learner-record');
  assert.equal(typeof envelope['format_version'], 'number');
  assert.equal((envelope['learner'] as unknown[]).length, 1, 'exactly one learner per file');

  // Guarantee 3: every referenced skill appears in the curriculum.
  const curriculumIds = new Set((envelope['curriculum'] as Array<{ id: string }>).map((s) => s.id));
  for (const table of ['mastery', 'observation'] as const) {
    for (const row of envelope[table] as Array<{ skill_id: string | null }>) {
      if (row.skill_id) assert.ok(curriculumIds.has(row.skill_id), `${table} references ${row.skill_id}`);
    }
  }

  // Guarantee 4: nothing about any other learner. Every learner-scoped row in the
  // file points at the exported child.
  const learnerId = (envelope['learner'] as Array<{ id: string }>)[0]!.id;
  for (const row of envelope['observation'] as Array<{ learner_id: string }>) {
    assert.equal(row.learner_id, learnerId);
  }
});
