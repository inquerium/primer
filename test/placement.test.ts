import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-placement-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, all } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { recordObservations } = await import('../src/record/observations.ts');
const { recompute, getMastery } = await import('../src/record/mastery.ts');
const { nextTargets } = await import('../src/domain/scheduler.ts');
const { expectedBands, placementStatus } = await import('../src/domain/placement.ts');
const { learnerContext } = await import('../src/record/context.ts');

// Every date in this file is pinned so the tests mean the same thing on any day.
const AT = new Date(Date.UTC(2026, 6, 29));
const OBS_DAY = new Date(Date.UTC(2026, 6, 28));
const GRAPH_ROOTS = ['pa_rhyme_recognize', 'cc_count_to_10', 'hw_grip_strokes'];

before(() => {
  db();
  loadCurriculum();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('an age maps to the band children that age typically work in', () => {
  assert.deepEqual(expectedBands(3.2), { bands: ['pk'], primary: 'pk', beyond_curriculum: false });
  assert.deepEqual(expectedBands(5.5), { bands: ['k'], primary: 'k', beyond_curriculum: false });
  // Near a boundary, both neighbours are plausible — a birthday is not a placement test.
  assert.deepEqual(expectedBands(6.1), { bands: ['k', '1'], primary: '1', beyond_curriculum: false });
  assert.deepEqual(expectedBands(6.5), { bands: ['1'], primary: '1', beyond_curriculum: false });
  assert.deepEqual(expectedBands(8.2), { bands: ['2', '3'], primary: '3', beyond_curriculum: false });
  // Older than the curriculum reaches: the curriculum tops out, not the child.
  assert.deepEqual(expectedBands(10), { bands: ['3'], primary: '3', beyond_curriculum: true });
});

test('the youngest children and children without a birth date are left exactly as before', () => {
  const anon = createLearner({ display_name: 'No Birthday' });
  assert.equal(placementStatus(anon.id, AT), null, 'no birth date, no placement');

  const four = createLearner({ display_name: 'Four', birth_date: '2022-07-01' });
  assert.equal(placementStatus(four.id, AT), null, 'the roots of the graph are already the right start at four');
});

test('an eight-year-old is probed at band-appropriate material, not offered pencil grip', () => {
  const eight = createLearner({ display_name: 'Eight', birth_date: '2018-05-01' });
  const ps = placementStatus(eight.id, AT);
  assert.ok(ps, 'an eight-year-old with an empty record needs placing');
  assert.deepEqual(ps!.expected.bands, ['2', '3']);

  for (const domain of ['reading', 'writing', 'math'] as const) {
    const d = ps!.domains[domain];
    assert.equal(d.status, 'in_progress');
    assert.ok(d.probes.length > 0, `${domain} must have probes`);
    assert.ok(d.probes.length <= 8, 'one assess session, not an exam');
    for (const p of d.probes) {
      assert.ok(!GRAPH_ROOTS.includes(p.skill_id), `${p.skill_id} is a graph root, not a placement probe for an eight-year-old`);
      assert.ok(p.why.length > 0, 'every probe says why it was chosen');
    }
    assert.ok(
      d.probes.some((p) => p.grade_band === '2' || p.grade_band === '3'),
      `${domain} probes must reach the expected band`,
    );
  }
});

test('probe evidence brackets the child and placement settles, without storing any state', () => {
  const child = createLearner({ display_name: 'Bracketed', birth_date: '2018-05-01' });

  // The truth this child walks in with: solid through band 1, nothing beyond.
  const knows = (band: string | null) => band === 'pk' || band === 'k' || band === '1';
  const bandOf = new Map(
    all<{ id: string; grade_band: string | null }>(`SELECT id, grade_band FROM skill`).map((s) => [
      s.id,
      s.grade_band,
    ]),
  );

  let rounds = 0;
  for (; rounds < 25; rounds++) {
    const ps = placementStatus(child.id, AT)!;
    const math = ps.domains.math;
    if (math.status !== 'in_progress') break;
    for (const probe of math.probes) {
      const right = knows(bandOf.get(probe.skill_id) ?? null) ? 1 : 0;
      recordObservations(
        child.id,
        Array.from({ length: 3 }, (_, i) => ({
          skill_id: probe.skill_id,
          kind: 'probe' as const,
          correct: right,
          item: `probe ${i}`,
          ts: OBS_DAY.toISOString(),
        })),
      );
    }
  }

  const settled = placementStatus(child.id, AT)!;
  assert.equal(settled.domains.math.status, 'settled', `math should settle, still open after ${rounds} rounds`);
  assert.ok(rounds <= 6, `bisection should converge in a few short sessions, took ${rounds}`);
  assert.equal(
    settled.domains.math.frontier_band,
    '1',
    'the frontier the evidence found is the band the child actually knows through',
  );

  // And the scheduler now starts where the child actually is: nothing offered
  // from the far side of what placement demonstrated.
  const targets = nextTargets(child.id, { domains: ['math'], at: AT });
  assert.ok(targets.length > 0);
  assert.ok(
    !targets.some((t) => t.skill.id === 'cc_count_to_10'),
    'counting to ten must not be offered to a child who demonstrated band-1 material',
  );
});

test('two correct probes on a mid-graph skill imply its foundations without drilling them', () => {
  const child = createLearner({ display_name: 'Implied', birth_date: '2019-06-01' });
  recordObservations(
    child.id,
    Array.from({ length: 3 }, (_, i) => ({
      skill_id: 'ph_cvc_short_a',
      kind: 'probe' as const,
      correct: 1,
      item: `cvc ${i}`,
      ts: OBS_DAY.toISOString(),
    })),
  );

  const prereqs = all<{ from_skill: string }>(
    `SELECT from_skill FROM skill_edge WHERE to_skill = 'ph_cvc_short_a' AND kind = 'prerequisite'`,
  ).map((e) => e.from_skill);
  assert.ok(prereqs.length > 0, 'the test needs a skill with prerequisites');

  const targets = nextTargets(child.id, { domains: ['reading'], at: AT });
  for (const p of prereqs) {
    assert.ok(
      !targets.some((t) => t.skill.id === p),
      `${p} is implied by the demonstrated skill and should not be front of the queue`,
    );
  }
  assert.ok(
    targets.some((t) => t.skill.id === 'ph_cvc_short_a'),
    'the demonstrated skill itself keeps its real, evidence-backed place in the queue',
  );
});

test('a record with probe evidence rebuilds to exactly the same state', () => {
  const child = createLearner({ display_name: 'Replayed', birth_date: '2018-05-01' });
  recordObservations(child.id, [
    { skill_id: 'op_add_within_20', kind: 'probe', correct: 1, item: 'p1', ts: OBS_DAY.toISOString() },
    { skill_id: 'op_add_within_20', kind: 'probe', correct: 1, item: 'p2', ts: OBS_DAY.toISOString() },
    { skill_id: 'op_add_within_20', kind: 'attempt', correct: 0, item: 'a1', ts: AT.toISOString() },
    { skill_id: 'pv_tens_ones', kind: 'probe', correct: 0, item: 'p3', ts: OBS_DAY.toISOString() },
    { skill_id: 'pv_tens_ones', kind: 'probe', correct: 0, item: 'p4', ts: OBS_DAY.toISOString() },
  ]);
  const live = getMastery(child.id, 'op_add_within_20')!;
  const statusBefore = placementStatus(child.id, AT)!;

  recompute(child.id);

  const rebuilt = getMastery(child.id, 'op_add_within_20')!;
  assert.ok(Math.abs(live.p_known - rebuilt.p_known) < 1e-9, `${live.p_known} vs ${rebuilt.p_known}`);
  assert.equal(live.opportunities, rebuilt.opportunities);

  // Placement is derived, so rebuilding the record cannot change where it stands.
  assert.deepEqual(placementStatus(child.id, AT), statusBefore);
});

test('learner_context carries placement and tells the tutor to assess before teaching', () => {
  const child = createLearner({ display_name: 'Context Placed', birth_date: '2018-05-01' });
  const ctx = learnerContext(child.id, { at: AT });

  assert.ok(ctx.placement, 'a cold-start older child must surface placement');
  assert.deepEqual(ctx.learner.expected_bands, { bands: ['2', '3'], primary: '3', beyond_curriculum: false });
  assert.ok(
    ctx.guidance.some((g) => g.includes('assess-mode') && g.includes('starting line')),
    `guidance must point at placement first, got: ${JSON.stringify(ctx.guidance)}`,
  );

  // A young child's context is unchanged: no placement, no placement guidance.
  const tot = learnerContext(createLearner({ display_name: 'Tot Context', birth_date: '2022-07-01' }).id, { at: AT });
  assert.equal(tot.placement, null);
  assert.ok(!tot.guidance.some((g) => g.includes('assess-mode')));
});
