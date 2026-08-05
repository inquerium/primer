/**
 * Accommodations, as a hard constraint rather than a hint.
 *
 * SPEC.md has always said every generated interface must honor every active
 * accommodation. Until these checks existed, the only thing enforcing it was the
 * tutor remembering, because the validator took a string of HTML and never
 * learned who the activity was for.
 *
 * The case that matters most in this file is the last one. An accommodation
 * nobody wrote a check for must not come back clean, because a reviewer reading
 * a clean report reasonably concludes the activity was verified.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { checkAccommodations } from '../src/surface/accommodations.ts';
import { validateInterface, explain } from '../src/surface/validate.ts';

const page = (body: string, head = '') => `<!doctype html>
<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head>
<body>${body}<script>primer.observe({skill:'s',correct:1});primer.affect('flow');primer.done({});</script></body></html>`;

const GOOD_TYPOGRAPHY = `<style>
  body { font-family: system-ui, sans-serif; font-size: 20px; letter-spacing: 0.05em; text-align: left; }
</style>`;

const rules = (r: { errors: Array<{ rule: string }> }) => r.errors.map((e) => e.rule);

/* --------------------------------------------------------------- no timers -- */

test('a countdown is refused for a child who must not be timed', () => {
  const html = page(
    '<div id="clock"></div>',
    `<script>var timeLeft=30;setInterval(function(){timeLeft--;},1000);</script>`,
  );
  const r = checkAccommodations(html, [{ kind: 'no_timers' }]);
  assert.ok(rules(r).includes('countdown'), `expected a countdown finding, got ${JSON.stringify(rules(r))}`);
});

test('a repeating callback that times nothing is not a countdown', () => {
  // A page that animates a character or polls its own state uses setInterval and
  // times nobody. Refusing it would teach the tutor that motion is forbidden.
  const html = page(
    '<div id="bounce"></div>',
    `<script>setInterval(function(){wiggle(document.getElementById('bounce'));},400);</script>`,
  );
  const r = checkAccommodations(html, [{ kind: 'no_timers' }]);
  assert.deepEqual(r.errors, []);
});

/* -------------------------------------------------------------- typography -- */

test('text below the readable floor is refused', () => {
  const html = page('<p>cat</p>', `<style>body{font-family:sans-serif;font-size:12px}</style>`);
  const r = checkAccommodations(html, [{ kind: 'dyslexia_typography' }]);
  assert.ok(rules(r).includes('text_too_small'));
});

test('italics and justified text are refused', () => {
  const html = page(
    '<p><em>cat</em></p>',
    `<style>body{font-family:sans-serif;font-size:20px;text-align:justify}</style>`,
  );
  const r = checkAccommodations(html, [{ kind: 'dyslexia_typography' }]);
  assert.ok(rules(r).includes('italics'));
  assert.ok(rules(r).includes('justified'));
});

test('a page that declares no font at all is refused rather than assumed fine', () => {
  const r = checkAccommodations(page('<p>cat</p>'), [{ kind: 'dyslexia_typography' }]);
  assert.ok(rules(r).includes('no_font_declared'));
});

test('a page built for this child passes', () => {
  const r = checkAccommodations(page('<p>cat</p>', GOOD_TYPOGRAPHY), [{ kind: 'dyslexia_typography' }]);
  assert.deepEqual(r.errors, [], `expected a clean pass, got ${JSON.stringify(rules(r))}`);
});

/* ------------------------------------------------------------- audio first -- */

test('a silent page is refused for a child who needs instructions spoken', () => {
  const r = checkAccommodations(page('<p>Read this.</p>', GOOD_TYPOGRAPHY), [{ kind: 'audio_first' }]);
  assert.ok(rules(r).includes('no_audio'));
});

test('a page that speaks passes', () => {
  const html = page(
    '<p>Read this.</p>',
    `${GOOD_TYPOGRAPHY}<script>speechSynthesis.speak(new SpeechSynthesisUtterance('Read this'));</script>`,
  );
  const r = checkAccommodations(html, [{ kind: 'audio_first' }]);
  assert.deepEqual(r.errors, []);
});

/* ----------------------------------------------------------------- motion -- */

test('unguarded animation is refused, guarded animation is not', () => {
  const moving = `<style>@keyframes spin{from{transform:rotate(0)}}.x{animation:spin 2s}</style>`;
  const guarded = `<style>@media (prefers-reduced-motion: no-preference){@keyframes spin{from{transform:rotate(0)}}.x{animation:spin 2s}}</style>`;
  assert.ok(rules(checkAccommodations(page('<i></i>', moving), [{ kind: 'reduced_motion' }])).includes('unguarded_motion'));
  assert.deepEqual(checkAccommodations(page('<b></b>', guarded), [{ kind: 'reduced_motion' }]).errors, []);
});

/* ---------------------------------------------- the branch that matters most -- */

test('an accommodation nobody wrote a check for does not come back clean', () => {
  const r = checkAccommodations(page('<p>cat</p>', GOOD_TYPOGRAPHY), [
    { kind: 'needs_movement_breaks', detail: 'Stand-up break every five minutes.' },
  ]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.unverifiable.length, 1, 'an unchecked accommodation must be reported as unchecked');
  assert.match(r.unverifiable[0]!.message, /has not been checked/);
  // The detail is what an adult needs in order to do the check by hand.
  assert.match(r.unverifiable[0]!.hint ?? '', /Stand-up break/);
});

test('contrast is never claimed either way, because it cannot be read from source', () => {
  const r = checkAccommodations(page('<p>cat</p>', GOOD_TYPOGRAPHY), [{ kind: 'high_contrast' }]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.unverifiable.length, 1);
  assert.match(r.unverifiable[0]!.message, /needs the page rendered/);
});

/* ------------------------------------------------------------- integration -- */

test('the validator blocks a violating activity only when it knows the child', () => {
  const html = page(
    '<p>go</p>',
    `<style>body{font-family:sans-serif;font-size:11px}</style>`,
  );

  // No accommodations passed: the caller said nothing, so nothing is claimed.
  const blind = validateInterface(html);
  assert.equal(blind.ok, true);
  assert.deepEqual(blind.unverifiable, []);

  const knowing = validateInterface(html, { accommodations: [{ kind: 'dyslexia_typography' }] });
  assert.equal(knowing.ok, false, 'a hard constraint must block the save');
  assert.ok(knowing.errors.some((e) => e.rule === 'accommodation:text_too_small'));
});

test('the explanation separates what was checked from what was not', () => {
  const result = validateInterface(page('<p>cat</p>', GOOD_TYPOGRAPHY), {
    accommodations: [{ kind: 'high_contrast' }, { kind: 'dyslexia_typography' }],
  });
  assert.equal(result.ok, true);
  const text = explain(result);
  assert.match(text, /Not checked, and an adult has to look/);
  assert.match(text, /high_contrast|contrast/);
});

test('every active accommodation is considered, not just the first', () => {
  const html = page('<p>go</p>', `<style>body{font-family:sans-serif;font-size:11px}</style>`);
  const r = checkAccommodations(html, [
    { kind: 'dyslexia_typography' },
    { kind: 'audio_first' },
    { kind: 'no_timers' },
  ]);
  const kinds = new Set(r.errors.map((e) => e.kind));
  assert.ok(kinds.has('dyslexia_typography'));
  assert.ok(kinds.has('audio_first'), 'a silent page fails audio_first even while failing typography');
});

test('a negated accommodation is never inverted into a requirement', () => {
  // Caught by scripts/accommodation-audit.mjs on its first run. "Do not pressure
  // this child to read out loud" matched the audio check, which then refused
  // every page that did not speak. A checker that can invert a parent's
  // instruction is worse than no checker, so this one abstains.
  const r = checkAccommodations(page('<p>cat</p>', GOOD_TYPOGRAPHY), [
    { kind: 'no_read_aloud_pressure', detail: 'Never ask him to read out loud in front of anyone.' },
  ]);
  assert.deepEqual(r.errors, [], 'a page that does not speak must not be refused here');
  assert.equal(r.unverifiable.length, 1, 'and it must be reported as unchecked rather than passed');
});

test('a child who needs audio still gets the check', () => {
  const r = checkAccommodations(page('<p>cat</p>', GOOD_TYPOGRAPHY), [{ kind: 'audio_first' }]);
  assert.ok(r.errors.some((e) => e.rule === 'no_audio'));
});
