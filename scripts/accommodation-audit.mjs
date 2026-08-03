#!/usr/bin/env node
/**
 * Prove the accommodation checks actually fire, and report what they cannot see.
 *
 *   node --experimental-strip-types scripts/accommodation-audit.mjs
 *   node --experimental-strip-types scripts/accommodation-audit.mjs --json
 *
 * accommodation-marshal's instrument. Two questions, and the second is the one
 * the lane exists for.
 *
 * 1. Do the checks catch a page that violates them, and leave a compliant page
 *    alone? A check that never fires is decoration, and a check that fires on
 *    good work teaches the tutor to route around it.
 * 2. Which accommodations in use have no mechanical check at all? That set is
 *    the lane's backlog. It shrinking is the only measure of progress here.
 *
 * Coverage is reported honestly and is never rounded up. An accommodation this
 * repository cannot verify is a promise SPEC.md makes and the code does not
 * keep, and saying so plainly is the point.
 */

import { checkAccommodations } from '../src/surface/accommodations.ts';

const asJson = process.argv.includes('--json');

const shell = (body, head = '') => `<!doctype html>
<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1">${head}</head>
<body>${body}<script>primer.observe({skill:'s',correct:1});primer.done({});</script></body></html>`;

const TYPOGRAPHY_OK = `<style>body{font-family:system-ui,sans-serif;font-size:20px;letter-spacing:.05em;text-align:left}</style>`;
const SPEAKS = `<script>speechSynthesis.speak(new SpeechSynthesisUtterance('go'));</script>`;

/**
 * One case per check: a page that must be refused, and one that must not.
 * Both halves matter. A checker with no compliant case is a checker nobody has
 * proved will ever let good work through.
 */
const CASES = [
  {
    kind: 'no_timers',
    violating: shell('<div id="c"></div>', `<script>var timeLeft=30;setInterval(function(){timeLeft--;},1000);</script>`),
    compliant: shell('<p>go</p>', TYPOGRAPHY_OK),
  },
  {
    kind: 'dyslexia_typography',
    violating: shell('<p><em>go</em></p>', `<style>body{font-family:Georgia,serif;font-size:12px}</style>`),
    compliant: shell('<p>go</p>', TYPOGRAPHY_OK),
  },
  {
    kind: 'audio_first',
    violating: shell('<p>Read this.</p>', TYPOGRAPHY_OK),
    compliant: shell('<p>Read this.</p>', TYPOGRAPHY_OK + SPEAKS),
  },
  {
    kind: 'reduced_motion',
    violating: shell('<i class="x"></i>', `<style>@keyframes s{from{opacity:0}}.x{animation:s 2s}</style>`),
    compliant: shell('<i class="x"></i>', `<style>@media (prefers-reduced-motion: no-preference){@keyframes s{from{opacity:0}}.x{animation:s 2s}}</style>`),
  },
];

/**
 * Accommodation kinds seen in the wild. The corpus supplies the ones a persona
 * carries; the rest are kinds a parent might plausibly write, because `kind` is
 * free text and the checker meets whatever an adult types.
 */
const IN_USE = [
  'dyslexia_typography',
  'no_timers',
  'audio_first',
  'reduced_motion',
  'high_contrast',
  'extra_processing_time',
  'needs_movement_breaks',
  'large_targets',
  'no_read_aloud_pressure',
  'single_task_at_a_time',
];

const results = [];
for (const c of CASES) {
  const caught = checkAccommodations(c.violating, [{ kind: c.kind }]).errors;
  const clean = checkAccommodations(c.compliant, [{ kind: c.kind }]).errors;
  results.push({
    kind: c.kind,
    catches_violation: caught.length > 0,
    passes_compliant: clean.length === 0,
    rules: caught.map((e) => e.rule),
    false_refusal: clean.map((e) => e.rule),
  });
}

const coverage = IN_USE.map((kind) => {
  const r = checkAccommodations(shell('<p>go</p>', TYPOGRAPHY_OK), [{ kind }]);
  const unchecked = r.unverifiable.length > 0;
  return { kind, checked: !unchecked, why: unchecked ? r.unverifiable[0].message : null };
});

const broken = results.filter((r) => !r.catches_violation || !r.passes_compliant);
const unchecked = coverage.filter((c) => !c.checked);
const report = {
  checks: results,
  coverage,
  checked: coverage.length - unchecked.length,
  total: coverage.length,
  coverage_ratio: Number(((coverage.length - unchecked.length) / coverage.length).toFixed(2)),
  broken,
  unchecked,
};

if (asJson) {
  console.log(JSON.stringify(report));
} else {
  console.log('\n  accommodation checks\n');
  for (const r of results) {
    const ok = r.catches_violation && r.passes_compliant;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${r.kind.padEnd(24)} ${r.rules.join(', ') || '(caught nothing)'}`);
    if (!r.catches_violation) console.log(`        a violating page was not refused`);
    if (!r.passes_compliant) console.log(`        a compliant page was refused: ${r.false_refusal.join(', ')}`);
  }
  console.log(`\n  coverage ${report.checked}/${report.total} kinds mechanically checked\n`);
  for (const c of unchecked) console.log(`  unchecked  ${c.kind}`);
  console.log(
    unchecked.length
      ? `\n  ${unchecked.length} accommodation kind(s) rest on an adult reading the activity.\n`
      : '\n  every kind in use has a check.\n',
  );
}

process.exit(broken.length ? 1 : 0);
