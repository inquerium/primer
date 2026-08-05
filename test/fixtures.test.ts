/**
 * The fixture corpus is a set of claims about the model, made in evidence.
 * This file holds it to them.
 *
 * Without this, a persona that quietly stops exhibiting the property it is named
 * for does not fail loudly. It makes every agent that measures itself against
 * the corpus report success against nothing, which is worse than having no
 * corpus at all.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-fixtures-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, all } = await import('../src/db/index.ts');
const { buildPersona, buildAll, PERSONAS, AS_OF } = await import('./fixtures/personas.ts');
const { nextTargets } = await import('../src/domain/scheduler.ts');
const { learnerContext } = await import('../src/record/context.ts');
const { getMastery } = await import('../src/record/mastery.ts');
const { statusOf, nextDue } = await import('../src/domain/bkt.ts');
const { toState } = await import('../src/record/mastery.ts');

before(() => {
  db();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('every persona builds, and builds a distinct learner', () => {
  const built = buildAll();
  assert.equal(Object.keys(built).length, PERSONAS.length);
  const ids = new Set(Object.values(built).map((b) => b.learner_id));
  assert.equal(ids.size, PERSONAS.length, 'personas must not share a learner row');
});

test('cold-start: an older empty record opens placement', () => {
  const { learner_id } = buildPersona('cold-start');
  const ctx = learnerContext(learner_id, { at: AS_OF });

  assert.ok(ctx.placement, 'an eight-year-old with no evidence must be placed before teaching');
  assert.equal(ctx.placement.domains.reading.status, 'in_progress');
  assert.ok(ctx.placement.domains.reading.probes.length > 0, 'placement must say what to probe');
  assert.equal(
    all<{ n: number }>(`SELECT count(*) AS n FROM mastery WHERE learner_id = ?`, learner_id)[0]!.n,
    0,
  );
  assert.ok(ctx.learner.expected_bands, 'age gives a starting guess');

  const targets = nextTargets(learner_id, { at: AS_OF });
  assert.ok(targets.length > 0);
  assert.ok(
    targets.every((t) => t.reason === 'frontier'),
    `nothing has been seen, so nothing can be lapsed or stuck: ${[...new Set(targets.map((t) => t.reason))]}`,
  );
});

test('cold-start-young: placement is withheld on purpose, not missing', () => {
  const { learner_id } = buildPersona('cold-start-young');
  const ctx = learnerContext(learner_id, { at: AS_OF });

  // For a five-year-old the roots of the graph are the right first material, so
  // there is nothing to place. Pinning it here keeps a future refactor from
  // "fixing" the null and marching every kindergartener through a probe session.
  assert.equal(ctx.placement, null);
  assert.equal(ctx.learner.expected_bands?.primary, 'k');
});

test('stuck-blending: the stuck skill surfaces, and outranks everything else', () => {
  const { learner_id } = buildPersona('stuck-blending');
  const targets = nextTargets(learner_id, { at: AS_OF });

  const blend = targets.find((t) => t.skill.id === 'pa_phoneme_blend_3');
  assert.ok(blend, 'the skill with nine failed attempts must appear in the queue');
  assert.equal(blend.reason, 'stuck');
  assert.ok(blend.opportunities >= 6, `condition is opportunities >= 6, got ${blend.opportunities}`);
  assert.ok(blend.p_known < 0.5, `condition is p_known < 0.5, got ${blend.p_known}`);

  // A child failing repeatedly is the most important thing in the queue. If a
  // lapsed skill outranks it, the tutor is told "quick win" when it should be
  // told "change approach".
  assert.equal(targets[0]!.skill.id, 'pa_phoneme_blend_3', 'stuck must sort to the top');
});

test('lapsed-summer: cramming lapses over a summer, spacing survives it', () => {
  const { learner_id } = buildPersona('lapsed-summer');
  const crammed = ['al_letter_sounds_short_vowels', 'ph_cvc_short_a', 'ph_cvc_short_i'];

  for (const skillId of crammed) {
    const m = getMastery(learner_id, skillId);
    assert.ok(m, `${skillId} should have mastery state`);
    const state = toState(m);

    assert.equal(statusOf(state, AS_OF), 'lapsed', `${skillId} should read as lapsed at AS_OF`);
    assert.ok(
      (state.peak_p_known ?? 0) >= 0.95,
      `${skillId} must have genuinely been held once, peak was ${state.peak_p_known}`,
    );
    // The stability floor is what stops a practiced skill decaying to zero. It is
    // the difference between "review this" and "teach this again from scratch".
    assert.ok(state.p_known > 0, `${skillId} should not have decayed to nothing`);
  }

  // Same child, same absence, same number of correct answers. Only the spacing
  // differed, and it is the whole difference between holding and losing.
  const spaced = getMastery(learner_id, 'ph_cvc_short_o');
  assert.ok(spaced);
  const spacedState = toState(spaced);
  assert.equal(
    statusOf(spacedState, AS_OF),
    'mastered',
    'a well-spaced skill must survive a summer; if this flips, the spacing model moved',
  );
  assert.ok(
    spacedState.half_life_days > toState(getMastery(learner_id, 'ph_cvc_short_a')!).half_life_days * 2,
    'spacing must buy a materially longer half-life than cramming the same count',
  );

  // Forgotten is not the same as stuck, and the queue has to say which.
  //
  // Six opportunities is an ordinary number of tries to learn something, so
  // before the lapsed guard in scheduler.ts these three tripped the stuck branch
  // and the tutor was told to change modality or drop to a prerequisite for a
  // child who simply took the summer off. `peak_p_known` is the only thing that
  // separates "lost it" from "never had it", and this is where that matters.
  const targets = nextTargets(learner_id, { at: AS_OF });
  const byId = new Map(targets.map((t) => [t.skill.id, t.reason]));
  for (const skillId of crammed) {
    assert.equal(byId.get(skillId), 'lapsed', `${skillId} was held and forgotten, so it is a review`);
  }
  assert.ok(
    targets.filter((t) => t.reason === 'stuck').length === 0,
    `nothing on this record has failed to land: ${JSON.stringify([...byId])}`,
  );
});

test('crammer: one sitting buys weeks of retention, not months', () => {
  const { learner_id } = buildPersona('crammer');
  const m = getMastery(learner_id, 'cc_count_to_20');
  assert.ok(m);
  const state = toState(m);

  assert.equal(state.opportunities, 20);
  // Twenty items answered in one sitting are one practice occasion. The gain
  // floor in applyEvidence is what enforces that, and this is the number that
  // moves if anyone removes it.
  assert.ok(
    state.half_life_days < 30,
    `cramming must not buy a long interval, half-life was ${state.half_life_days} days`,
  );

  const due = nextDue(state);
  assert.ok(due);
  const daysOut = (new Date(due).getTime() - new Date(state.last_seen!).getTime()) / 86_400_000;
  assert.ok(daysOut < 60, `next review was ${Math.round(daysOut)} days out; that is a season away`);
});

test('vowel-confuser: the misconception is in the responses, and nothing has labelled it', () => {
  const { learner_id } = buildPersona('vowel-confuser');

  const wrong = all<{ item: string; response: string; expected: string }>(
    `SELECT item, response, expected FROM observation
      WHERE learner_id = ? AND skill_id = 'ph_cvc_short_e' AND correct < 0.6`,
    learner_id,
  );
  assert.ok(wrong.length >= 8, `expected a real run of errors, got ${wrong.length}`);

  // Every miss is the same substitution. That regularity is the entire signal a
  // miner has to work with, and it must survive in the record verbatim.
  for (const row of wrong) {
    assert.notEqual(row.response, row.expected);
    assert.equal(
      row.response,
      row.expected.replace(/e/, 'i'),
      `${row.item} should have been misread as its short-i twin, got "${row.response}"`,
    );
  }

  // Short i is solid, so "she does not know short i" is ruled out by construction.
  const shortI = getMastery(learner_id, 'ph_cvc_short_i');
  assert.ok(shortI);
  assert.equal(statusOf(toState(shortI), AS_OF), 'mastered');

  // Ground truth means unlabelled. A miner that finds this has found it; a miner
  // scored against a record that already names the answer has found nothing.
  const labelled = all<{ n: number }>(
    `SELECT count(*) AS n FROM misconception WHERE learner_id = ?`,
    learner_id,
  )[0]!.n;
  assert.equal(labelled, 0, 'the corpus must not hand the miner its own answer');
});

test('accommodated: three hard constraints are enforced by the validator', async () => {
  const { learner_id } = buildPersona('accommodated');
  const ctx = learnerContext(learner_id, { at: AS_OF });

  const kinds = ctx.accommodations.map((a) => a.kind).sort();
  assert.deepEqual(kinds, ['audio_first', 'dyslexia_typography', 'no_timers']);
  for (const a of ctx.accommodations) {
    assert.ok(a.detail && a.detail.length > 20, `${a.kind} needs actionable detail, not a label`);
  }

  // This is a page the prompt used to be trusted to catch. The validator must
  // now receive this child's instructions and refuse it on their behalf.
  const { validateInterface } = await import('../src/surface/validate.ts');
  const tiny = '<!doctype html><html lang="en"><head></head><body><p>go</p>' +
    '<style>body{font-size:9px}</style>' +
    '<script>primer.observe({skill:"s",correct:1});primer.done({});</script></body></html>';
  const result = validateInterface(tiny, { accommodations: ctx.accommodations });
  assert.equal(result.ok, false, '9px text must be refused for a child who needs accessible typography');
  assert.ok(result.errors.some((e) => e.rule === 'accommodation:text_too_small'));
});

test('above-band: upstream skills are demoted, never walled off', () => {
  const { learner_id } = buildPersona('above-band');
  const ctx = learnerContext(learner_id, { at: AS_OF });

  // Her age says k and 1. Her evidence says otherwise, and the evidence wins.
  assert.ok(ctx.learner.expected_bands);
  const pv = getMastery(learner_id, 'pv_teen_numbers');
  assert.ok(pv);
  assert.equal(statusOf(toState(pv), AS_OF), 'mastered');

  const targets = nextTargets(learner_id, { at: AS_OF, limit: 200 });
  const countToTen = targets.find((t) => t.skill.id === 'cc_count_to_10');

  // Reachable, because a child who stalls downstream needs a route back to the
  // foundation. But not offered first to a child already doing place value.
  assert.ok(countToTen, 'implied-known skills must stay in the graph, not be deleted from it');
  const rank = targets.findIndex((t) => t.skill.id === 'cc_count_to_10');
  assert.ok(
    rank > 3,
    `"Counts to 10" was ranked ${rank} for a child doing teen place value; implied-known is not demoting it`,
  );
});
