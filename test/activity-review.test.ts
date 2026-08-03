/**
 * What an activity does to a child, as distinct from whether it works.
 *
 * Two things checked here were prompt-only until now. Rule 5 in CLAUDE.md
 * forbids streaks, coins and leaderboards, and test/invariants.test.ts pinned
 * only that both prompts say so, describing prompt text as "the soft layer above
 * the structural enforcement". For engagement mechanics there was no structural
 * layer underneath it. And an activity recording `correct` with no `response`
 * makes every misconception in that session permanently undiscoverable.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { reviewActivity } from '../src/surface/activity-review.ts';
import { validateInterface } from '../src/surface/validate.ts';
import { ACTIVITIES, activity } from './fixtures/activities.ts';

const rulesOf = (html: string) => {
  const r = reviewActivity(html);
  return [...r.refusals, ...r.flags].map((f) => f.rule);
};

test('every sample in the corpus reviews exactly as declared', () => {
  for (const sample of ACTIVITIES) {
    const found = new Set(rulesOf(sample.html));
    const want = new Set(sample.expect);
    assert.deepEqual(
      [...found].sort(),
      [...want].sort(),
      `${sample.id} (${sample.summary}) reviewed as ${JSON.stringify([...found])}`,
    );
  }
});

test('a good activity is not refused, which matters as much as catching a bad one', () => {
  const review = reviewActivity(activity('good').html);
  assert.deepEqual(review.refusals, []);
  assert.deepEqual(review.flags, []);
  // And it survives the full validator, so the tutor is never taught that the
  // gate is noise to be worked around.
  assert.equal(validateInterface(activity('good').html).ok, true);
});

test('rule 5 blocks the save, because the cheapest fix is the correct one', () => {
  for (const id of ['streak-counter', 'coins']) {
    const result = validateInterface(activity(id).html);
    assert.equal(result.ok, false, `${id} should be refused`);
    assert.ok(result.errors.some((e) => e.rule === 'activity:engagement_mechanics'));
  }
});

test('missing response text flags rather than blocks, on purpose', () => {
  // A refusal is a demand a model satisfies the cheapest way it can find, and
  // the cheapest fix here is `response: "x"`. A column of plausible fabrications
  // is worse than an empty one: the miner will read it and yield misconceptions
  // from noise. An empty column can at least be recognised as empty.
  const result = validateInterface(activity('no-response-text').html);
  assert.equal(result.ok, true, 'this must not be refused');
  assert.ok(result.warnings.some((w) => w.rule === 'activity:no_response_recorded'));
});

test('a streak named only in a comment is not a streak', () => {
  assert.deepEqual(rulesOf(activity('commented-out-streak').html), []);
});

test('"point to the picture" is not a points total', () => {
  assert.deepEqual(rulesOf(activity('points-to-the-picture').html), []);
  // And a decorative star awards nothing.
  assert.deepEqual(rulesOf(activity('gold-star-decoration').html), []);
});

test('the mechanics check reads child-facing text, not only code', () => {
  const inTextOnly = `<!doctype html><html lang="en"><body>
    <p>You are on a 5 day streak!</p>
    <script>primer.observe({skill:'s',correct:1,response:'a'});if(correct){}break;</script>
    </body></html>`;
  assert.ok(rulesOf(inTextOnly).includes('engagement_mechanics'));
});

test('a page that adapts and can stop early is not flagged for either', () => {
  const found = rulesOf(activity('good').html);
  assert.ok(!found.includes('no_visible_adaptation'));
  assert.ok(!found.includes('runs_to_a_fixed_length'));
});
