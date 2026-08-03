/**
 * The detector, on its own evidence.
 *
 * Builds its own minimal records rather than leaning on the fixture corpus, so
 * these cases stay readable as arguments about the detector rather than as
 * arguments about a persona.
 *
 * The bias throughout is toward silence. A missed misconception leaves the tutor
 * working slightly blind, which is where it already was. A fabricated one has it
 * teaching against a model the child does not hold, and a parent being told
 * something false about their kid.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-misc-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { recordObservations } = await import('../src/record/observations.ts');
const { mineMisconceptions, singleSubstitution } = await import('../src/domain/misconceptions.ts');

before(() => {
  db();
  loadCurriculum();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

let n = 0;
/** A learner with a given set of wrong answers on one skill. */
function learnerWith(
  attempts: Array<{ item: string; response: string; expected: string; skill?: string; correct?: number }>,
) {
  const learner = createLearner({ display_name: `Case ${++n}`, birth_date: '2020-01-01' });
  recordObservations(
    learner.id,
    attempts.map((a, i) => ({
      skill_id: a.skill ?? 'ph_cvc_short_e',
      kind: 'attempt' as const,
      correct: a.correct ?? 0,
      item: a.item,
      response: a.response,
      expected: a.expected,
      ts: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
    })),
    'test',
  );
  return learner.id;
}

const pair = (expected: string, response: string, skill?: string) => ({
  item: expected,
  response,
  expected,
  skill,
});

test('a single substitution is found, and only when there is exactly one', () => {
  assert.deepEqual(singleSubstitution('bed', 'bid'), { from: 'e', to: 'i', index: 1 });
  assert.deepEqual(singleSubstitution('e', 'i'), { from: 'e', to: 'i', index: 0 });
  assert.equal(singleSubstitution('bed', 'bed'), null, 'no difference is not a substitution');
  assert.equal(singleSubstitution('bed', 'bid ') , null, 'different lengths are a different error');
  assert.equal(singleSubstitution('bed', 'pit'), null, 'two differences are not one rule');
  assert.equal(singleSubstitution('', ''), null);
});

test('a consistent wrong model is found', () => {
  const id = learnerWith([
    pair('bed', 'bid'),
    pair('pen', 'pin'),
    pair('den', 'din'),
    pair('bet', 'bit'),
    pair('leg', 'lig'),
  ]);
  const found = mineMisconceptions(id);
  assert.equal(found.length, 1);
  assert.equal(found[0]!.from, 'e');
  assert.equal(found[0]!.to, 'i');
  assert.equal(found[0]!.occurrences, 5);
  assert.equal(found[0]!.distinct_items, 5);
  // The string a human reads must be language, not a code.
  assert.match(found[0]!.pattern, /Reads "e" as "i"/);
  assert.doesNotMatch(found[0]!.pattern, /ph_cvc|skill_id|0\.\d/);
});

test('a rule holding across two skills is more confident than one confined to a single skill', () => {
  const narrow = mineMisconceptions(
    learnerWith([pair('bed', 'bid'), pair('pen', 'pin'), pair('den', 'din'), pair('bet', 'bit')]),
  );
  const broad = mineMisconceptions(
    learnerWith([
      pair('bed', 'bid'),
      pair('pen', 'pin'),
      pair('den', 'din'),
      pair('bet', 'bit', 'pa_phoneme_isolate_medial'),
    ]),
  );
  // One skill failing this way may be that skill being taught badly. The same
  // rule surviving into a second skill is a property of the child.
  assert.ok(
    broad[0]!.confidence > narrow[0]!.confidence,
    `broad ${broad[0]!.confidence} should beat narrow ${narrow[0]!.confidence}`,
  );
});

test('the same word missed repeatedly is one word, not a model', () => {
  const id = learnerWith([pair('bed', 'bid'), pair('bed', 'bid'), pair('bed', 'bid'), pair('bed', 'bid')]);
  assert.deepEqual(mineMisconceptions(id), [], 'four misses of one item is not a rule about e');
});

test('twice is a coincidence', () => {
  const id = learnerWith([pair('bed', 'bid'), pair('pen', 'pin')]);
  assert.deepEqual(mineMisconceptions(id), []);
});

test('scattered wrongness produces nothing', () => {
  // A child guessing at the vowel. Six misses spread across three different
  // substitutions, none of them dominant. A detector that finds a model here
  // will find one in any struggling child, which is how a parent ends up being
  // told something confident and false.
  //
  // Getting this case right took two goes. The first version read as random and
  // was not: bed/bat/tan were all e to a, three times out of six, and the
  // detector correctly called it. Writing a convincing negative for a pattern
  // finder is harder than it looks, which is rather the point of having one.
  const id = learnerWith([
    pair('bed', 'bad'),
    pair('bet', 'bat'),
    pair('pen', 'pon'),
    pair('ten', 'ton'),
    pair('den', 'dun'),
    pair('leg', 'lug'),
  ]);
  const found = mineMisconceptions(id);
  assert.deepEqual(found, [], `expected silence, got ${JSON.stringify(found.map((f) => f.pattern))}`);
});

test('a minority rule inside mostly random wrongness is not promoted', () => {
  // Three consistent misses among eleven readable ones. Real, perhaps, but it
  // explains under a third of what happened, and the cost of being wrong here
  // is a parent told something false.
  const id = learnerWith([
    pair('bed', 'bid'),
    pair('pen', 'pin'),
    pair('den', 'din'),
    pair('bat', 'bot'),
    pair('cat', 'cut'),
    pair('mat', 'mit'),
    pair('sat', 'sot'),
    pair('rat', 'rut'),
    pair('hat', 'hot'),
    pair('fan', 'fun'),
    pair('man', 'mon'),
  ]);
  assert.deepEqual(mineMisconceptions(id), []);
});

test('correct answers are not evidence of a wrong model', () => {
  const id = learnerWith([
    { ...pair('bed', 'bed'), correct: 1 },
    { ...pair('pen', 'pen'), correct: 1 },
    { ...pair('den', 'den'), correct: 1 },
    { ...pair('bet', 'bet'), correct: 1 },
  ]);
  assert.deepEqual(mineMisconceptions(id), []);
});

test('a record with no response text yields nothing rather than guessing', () => {
  const learner = createLearner({ display_name: 'No text', birth_date: '2020-01-01' });
  recordObservations(
    learner.id,
    Array.from({ length: 8 }, (_, i) => ({
      skill_id: 'ph_cvc_short_e',
      kind: 'attempt' as const,
      correct: 0,
      ts: new Date(Date.UTC(2026, 5, 1 + i)).toISOString(),
    })),
    'test',
  );
  // Eight failures and nothing readable. The honest answer is that this detector
  // has nothing to say, not that the child is fine.
  assert.deepEqual(mineMisconceptions(learner.id), []);
});

test('a corrected attempt is not evidence of a standing model', () => {
  const learner = createLearner({ display_name: 'Superseded', birth_date: '2020-01-01' });
  const written = recordObservations(
    learner.id,
    [pair('bed', 'bid'), pair('pen', 'pin'), pair('den', 'din')].map((a, i) => ({
      skill_id: 'ph_cvc_short_e',
      kind: 'attempt' as const,
      correct: 0,
      item: a.item,
      response: a.response,
      expected: a.expected,
      ts: new Date(Date.UTC(2026, 6, 1 + i)).toISOString(),
    })),
    'test',
  );
  assert.equal(mineMisconceptions(learner.id).length, 1);

  // Corrections are new observations pointing at the old ones, never edits.
  recordObservations(
    learner.id,
    written.map((w) => ({
      skill_id: 'ph_cvc_short_e',
      kind: 'attempt' as const,
      correct: 1,
      supersedes: w.observation_id,
      ts: new Date(Date.UTC(2026, 6, 10)).toISOString(),
    })),
    'test',
  );
  assert.deepEqual(mineMisconceptions(learner.id), [], 'superseded evidence must not sustain a pattern');
});
