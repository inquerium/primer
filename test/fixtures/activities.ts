/**
 * Generated activities, with their defects declared.
 *
 * The persona corpus is evidence about children. This is evidence about the
 * things built for them: what a good one looks like, and what each way of being
 * bad looks like in source.
 *
 * Same discipline as `personas.ts`. Every sample states what is wrong with it by
 * construction, and `scripts/activity-audit.mjs` scores the reviewer against
 * that rather than against anyone's impression of the output. The compliant
 * sample matters as much as the broken ones: a reviewer nobody has proved will
 * pass good work is a reviewer the tutor learns to route around.
 *
 * These are hand-written in the shape real generated activities take, including
 * the defensive runtime aliasing a real one used. They are not transcripts of
 * model output, and nothing here should be read as evidence about how often a
 * real tutor makes these mistakes.
 */

export interface ActivitySample {
  id: string;
  summary: string;
  /** Rules `reviewActivity` must return. Empty means it must return none. */
  expect: string[];
  html: string;
}

const TYPOGRAPHY = `<style>
  body { font-family: system-ui, sans-serif; font-size: 20px; letter-spacing: .04em;
         text-align: left; max-width: 34rem; margin: 2rem auto; }
  button { font-size: 1.1em; padding: .6em 1em; margin: .3em; }
</style>`;

const shell = (title: string, body: string, script: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>${TYPOGRAPHY}</head>
<body>${body}<script>
var P = (typeof window.primer === "object" && window.primer) ? window.primer : {};
function safe(n){ return typeof P[n] === "function" ? P[n].bind(P) : function(){}; }
var pObserve = safe("observe"), pAffect = safe("affect"), pDone = safe("done");
${script}
</script></body></html>`;

/** The shape a good one takes: adapts, ends early, records what was said. */
const GOOD_SCRIPT = `
var items = [
  { word: 'bed', other: 'bid' }, { word: 'pen', other: 'pin' },
  { word: 'net', other: 'nit' }, { word: 'leg', other: 'lig' }
];
var i = 0, wrongInARow = 0, easier = false;
function ask() {
  if (i >= items.length) { finish('Worked through them all.'); return; }
  var it = items[i];
  document.getElementById('prompt').textContent = easier
    ? 'Biscuit sleeps in a ' + it.word.toUpperCase()
    : 'Which one says "' + it.word + '"?';
  render(it);
}
function answer(it, choice) {
  var correct = choice === it.word ? 1 : 0;
  pObserve({ skill: 'ph_cvc_short_e', correct: correct, item: it.word,
             response: choice, expected: it.word, modality: 'selected' });
  if (correct) { wrongInARow = 0; i++; }
  else {
    wrongInARow++;
    // Two misses on the same pattern and the page drops to something easier,
    // without comment. The tutor is not here to do it.
    if (wrongInARow >= 2) { easier = true; pAffect('frustration', { intensity: .6,
      evidence: 'two misses in a row on the same vowel' }); }
    if (wrongInARow >= 3) { finish('Stopped early; this was hard today.'); return; }
  }
  ask();
}
function finish(summary) { pAffect('flow', { intensity: .5 }); pDone({ summary: summary }); }
function render(it) {
  var box = document.getElementById('choices'); box.innerHTML = '';
  [it.word, it.other].forEach(function (c) {
    var b = document.createElement('button');
    b.textContent = c; b.onclick = function () { answer(it, c); }; box.appendChild(b);
  });
}
ask();`;

export const ACTIVITIES: ActivitySample[] = [
  {
    id: 'good',
    summary: 'Adapts on two misses, stops on three, records the actual choice.',
    expect: [],
    html: shell('Short e with Biscuit', `<h1>Biscuit's words</h1>
      <p id="prompt"></p><div id="choices"></div>`, GOOD_SCRIPT),
  },

  {
    id: 'streak-counter',
    summary: 'Keeps a streak and shows it. Rule 5.',
    expect: ['engagement_mechanics'],
    html: shell('Streaks', `<h1>Words</h1><p id="prompt"></p>
      <p>Streak: <span id="streak">0</span></p><div id="choices"></div>`,
      GOOD_SCRIPT.replace(
        'if (correct) { wrongInARow = 0; i++; }',
        `if (correct) { wrongInARow = 0; i++; streak++; document.getElementById('streak').textContent = streak; }`,
      ).replace('var i = 0,', 'var streak = 0; var i = 0,'),
    ),
  },

  {
    id: 'coins',
    summary: 'Awards coins for correct answers. Rule 5.',
    expect: ['engagement_mechanics'],
    html: shell('Coins', `<h1>Words</h1><p id="prompt"></p>
      <p>You have <span id="coins">0</span> coins!</p><div id="choices"></div>`,
      GOOD_SCRIPT.replace(
        'if (correct) { wrongInARow = 0; i++; }',
        `if (correct) { wrongInARow = 0; i++; coins += 5; document.getElementById('coins').textContent = coins; }`,
      ).replace('var i = 0,', 'var coins = 0; var i = 0,'),
    ),
  },

  {
    id: 'no-response-text',
    summary: 'Records correctness and nothing else, so no misconception can ever be found.',
    expect: ['no_response_recorded'],
    html: shell('Silent evidence', `<h1>Words</h1><p id="prompt"></p><div id="choices"></div>`,
      GOOD_SCRIPT.replace(
        `pObserve({ skill: 'ph_cvc_short_e', correct: correct, item: it.word,
             response: choice, expected: it.word, modality: 'selected' });`,
        `pObserve({ skill: 'ph_cvc_short_e', correct: correct });`,
      ),
    ),
  },

  {
    id: 'no-adaptation',
    summary: 'Marches through a fixed list whatever the child does.',
    expect: ['no_visible_adaptation', 'runs_to_a_fixed_length'],
    html: shell('Fixed drill', `<h1>Words</h1><p id="prompt"></p><div id="choices"></div>`, `
var words = ['bed','pen','net','leg','ten','peg','wet','hen'];
words.forEach(function (w) {
  var typed = window.prompt('Type ' + w);
  pObserve({ skill: 'ph_cvc_short_e', correct: typed === w ? 1 : 0, item: w,
             response: typed, expected: w });
});
pDone({ summary: 'Did all eight.' });`),
  },

  {
    id: 'punishing',
    summary: 'Tells a six-year-old they are wrong, in those words.',
    expect: ['punishing_language'],
    html: shell('Harsh', `<h1>Words</h1><p id="prompt"></p>
      <p id="feedback">Wrong! Try harder.</p><div id="choices"></div>`, GOOD_SCRIPT),
  },

  {
    id: 'commented-out-streak',
    summary: 'Mentions a streak only in a comment. Must not be refused.',
    expect: [],
    html: shell('Clean', `<h1>Words</h1><p id="prompt"></p><div id="choices"></div>`,
      `// Deliberately no streak counter here: rule 5.\n${GOOD_SCRIPT}`),
  },

  {
    id: 'points-to-the-picture',
    summary: 'Says "point to the picture". Not a points total, and must not be refused.',
    expect: [],
    html: shell('Pointing', `<h1>Words</h1>
      <p>Point to the picture that starts with the same sound.</p>
      <p id="prompt"></p><div id="choices"></div>`, GOOD_SCRIPT),
  },

  {
    id: 'gold-star-decoration',
    summary: 'Draws a star as decoration without awarding anything. Must not be refused.',
    expect: [],
    html: shell('Decorated', `<h1>Words <span aria-hidden="true">★</span></h1>
      <p id="prompt"></p><div id="choices"></div>`, GOOD_SCRIPT),
  },
];

export const activity = (id: string): ActivitySample => {
  const found = ACTIVITIES.find((a) => a.id === id);
  if (!found) throw new Error(`no activity "${id}". Known: ${ACTIVITIES.map((a) => a.id).join(', ')}`);
  return found;
};
