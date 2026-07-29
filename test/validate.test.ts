import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateInterface, explain } from '../src/surface/validate.ts';

const good = `<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Word hunt</title></head>
<body><button id="b">cat</button>
<script>
  var P = window.primer || {observe:function(){},done:function(){},affect:function(){}};
  document.getElementById('b').onclick = function () {
    P.observe({ skill: 'ph_cvc_short_a', correct: 1, item: 'cat', response: 'cat' });
    P.affect('delight', { evidence: 'asked for another' });
    P.done({ summary: 'Read three words.', energy: 'ok' });
  };
</script></body></html>`;

test('a well-formed activity passes cleanly', () => {
  const result = validateInterface(good);
  assert.equal(result.ok, true, explain(result));
  assert.equal(result.errors.length, 0);
  assert.ok(result.stats.observeCalls >= 1, 'the runtime is referenced');
  assert.equal(result.stats.scripts, 1);
});

test('a syntax error is caught before a child sees a blank screen', () => {
  const broken = good.replace('function () {', 'function ( {');
  const result = validateInterface(broken);
  assert.equal(result.ok, false);
  const error = result.errors.find((e) => e.rule === 'javascript_syntax');
  assert.ok(error, 'a script that cannot parse must block the activity');
  assert.match(explain(result), /not saved/);
});

test('an activity that records nothing is refused', () => {
  const silent = `<!doctype html><html><body><script>
    document.body.textContent = 'just a poster, nothing to do';
  </script></body></html>`;
  const result = validateInterface(silent);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.rule === 'reports_nothing'));
});

test('a page that aliases the runtime up front is still recognised as instrumented', () => {
  // This is the defensive shape a real generated activity used. A checker that
  // only matches `.observe(` rejects it and tells the tutor its working page
  // records nothing — worse than not checking at all.
  const aliased = `<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width,initial-scale=1"></head><body><script>
  var P = (typeof window.primer === "object" && window.primer) ? window.primer : {};
  function safe(name) { return typeof P[name] === "function" ? P[name].bind(P) : function () {}; }
  var pObserve = safe("observe"), pAffect = safe("affect"), pDone = safe("done");
  pObserve({ skill: 'ph_cvc_short_e', correct: 1, item: 'bed', response: 'bed' });
  pAffect("pride", { intensity: 0.75 });
  pDone({ summary: 'Built four words.' });
</script></body></html>`;
  const result = validateInterface(aliased);
  assert.equal(result.ok, true, explain(result));
  assert.equal(result.warnings.length, 0, explain(result));
});

test('a commented-out call does not count as instrumentation', () => {
  const commented = `<!doctype html><html><body><script>
    // P.observe({ skill: 'x', correct: 1 });
    /* P.observe(again) */
    document.title = 'nothing happens here';
  </script></body></html>`;
  const result = validateInterface(commented);
  assert.equal(result.ok, false, 'commented-out reporting is not reporting');
  assert.ok(result.errors.some((e) => e.rule === 'reports_nothing'));
});

test('anything loaded from the internet is refused', () => {
  for (const offender of [
    '<script src="https://cdn.example.com/x.js"></script>',
    '<link href="https://fonts.googleapis.com/css?family=Inter" rel="stylesheet">',
    '<img src="//example.com/cat.png">',
  ]) {
    const result = validateInterface(good.replace('<body>', `<body>${offender}`));
    assert.equal(result.ok, false, `${offender} should be refused`);
    assert.ok(result.errors.some((e) => e.rule === 'external_request'));
  }

  const fetching = good.replace('P.done(', 'fetch("https://evil.example.com/x");P.done(');
  assert.equal(validateInterface(fetching).ok, false, 'a remote fetch must be refused');
});

test('inline data URIs and same-origin paths are fine', () => {
  const inline = good.replace(
    '<body>',
    '<body><img src="data:image/svg+xml,%3Csvg/%3E"><img src="/artifacts/x.png">',
  );
  const result = validateInterface(inline);
  assert.equal(result.ok, true, explain(result));
});

test('an empty or fragmentary page is refused', () => {
  assert.equal(validateInterface('').ok, false);
  assert.equal(validateInterface('<div>hello</div>').ok, false);
});

test('a page with no script at all cannot be an activity', () => {
  const result = validateInterface('<!doctype html><html><body><p>Read this.</p></body></html>');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.rule === 'no_script'));
});

test('missing done, affect, or viewport warns but does not block', () => {
  const minimal = `<!doctype html><html><body><script>
    window.primer.observe({ skill: 'x', correct: 1 });
  </script></body></html>`;
  const result = validateInterface(minimal);
  assert.equal(result.ok, true, 'warnings must never block a working activity');
  const rules = result.warnings.map((w) => w.rule);
  assert.ok(rules.includes('never_ends'));
  assert.ok(rules.includes('no_affect'));
  assert.ok(rules.includes('no_viewport'));
});

test('a likely countdown timer is flagged for the adult', () => {
  const timed = good.replace(
    '<script>',
    '<script>var timeLeft=30;setInterval(function(){timeLeft--;},1000);',
  );
  const result = validateInterface(timed);
  assert.equal(result.ok, true, 'a timer is a judgment call, not an error');
  assert.ok(result.warnings.some((w) => w.rule === 'possible_timer'));
});

test('non-JavaScript script blocks are not syntax-checked', () => {
  const withTemplate = good.replace(
    '<script>',
    '<script type="text/template">{{ this is not javascript }}</script><script>',
  );
  const result = validateInterface(withTemplate);
  assert.equal(result.ok, true, explain(result));
});

test('an enormous page is refused', () => {
  const huge = good.replace('<body>', `<body><!--${'x'.repeat(500_000)}-->`);
  const result = validateInterface(huge);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.rule === 'too_large'));
});

test('the explanation tells the tutor what to do next', () => {
  const result = validateInterface('<div>nope</div>');
  const text = explain(result);
  assert.match(text, /was not saved/);
  assert.match(text, /save_interface again/);
});
