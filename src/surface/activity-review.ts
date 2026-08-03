/**
 * Read a generated activity and find the reason it will fail a child.
 *
 * `validateInterface` asks whether the page works: does it parse, does it stay
 * offline, does it report anything at all. This asks a different question, and a
 * page can pass every mechanical check and still fail it. Does what this page
 * does to a six-year-old match what this project says it will do.
 *
 * ## Two of these are hard rules that nothing enforced
 *
 * `CLAUDE.md` rule 5 forbids streaks, coins, leaderboards, and countdown timers
 * for children. `test/invariants.test.ts` pins that both prompts *say* so, and
 * its own comment calls prompt text "the soft layer above the structural
 * enforcement". For engagement mechanics there was no structural layer
 * underneath. The tutor was asked not to, and that was all.
 *
 * The second is quieter and costs more. An activity that records `correct`
 * without recording what the child actually said makes every misconception in
 * that session permanently undiscoverable. `src/domain/misconceptions.ts` reads
 * `response` against `expected`; with `correct` alone the evidence is a column
 * of zeroes, and no later model, however good, can recover what was thrown away.
 * SPEC.md's whole claim is that you can always recompute with a better model.
 * That claim is false for any session recorded this way.
 *
 * ## Refuse versus flag
 *
 * A refusal blocks the save and is handed back to the tutor to fix. A flag
 * reaches the adult reviewing the queue.
 *
 * The line is not severity, and it is not confidence either. It is this:
 *
 * **Refuse only when the cheapest way to satisfy the check is also the correct
 * fix.**
 *
 * A refusal is a demand made of a model that will satisfy it the cheapest way it
 * can find. For a streak counter the cheapest fix is deleting the streak
 * counter, which is exactly what rule 5 wants, so refusing works.
 *
 * For a missing `response` the cheapest fix is passing `response: "x"`. That
 * satisfies the check, and it is far worse than the thing the check exists to
 * prevent: an empty column can at least be recognised as empty, whereas a column
 * of plausible fabrications will be mined for misconceptions and will yield
 * them. So this one flags, loudly, and an adult decides. A gate that can be
 * cheaply faked does not protect the data. It corrupts it and reports success.
 */

export interface ActivityFinding {
  rule: string;
  message: string;
  hint?: string;
  /** The text that triggered it, so a human can check the call. */
  evidence?: string;
}

export interface ActivityReview {
  refusals: ActivityFinding[];
  flags: ActivityFinding[];
}

/** Script bodies, comments stripped, so a commented-out violation is not one. */
function scripts(html: string): string {
  const out: string[] = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(html))) {
    if (/\bsrc\s*=/i.test(m[1] ?? '')) continue;
    out.push(m[2] ?? '');
  }
  return out
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
}

/** Visible text plus the attributes a child would hear or read. */
function childFacing(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ');
}

/**
 * Extrinsic motivation, as it actually appears in generated pages.
 *
 * Deliberately not matching bare "points" or "stars". A page that says "point to
 * the picture" or draws a star as decoration is doing neither of the things rule
 * 5 forbids, and a checker that refuses those teaches the tutor that the rule is
 * noise. Every pattern here needs an accumulator or a ranking to fire.
 */
const MECHANICS: Array<{ re: RegExp; what: string }> = [
  { re: /\bstreaks?\b/i, what: 'a streak' },
  { re: /\bcoins?\b/i, what: 'coins' },
  { re: /\bleaderboards?\b/i, what: 'a leaderboard' },
  { re: /\bbadges?\b/i, what: 'badges' },
  { re: /\btroph(y|ies)\b/i, what: 'a trophy' },
  { re: /\bhigh[\s_-]?scores?\b/i, what: 'a high score' },
  { re: /\bcombo\b/i, what: 'a combo counter' },
  { re: /\bxp\b/i, what: 'experience points' },
  { re: /\b(earn|award|collect|unlock)(ed|s|ing)?\s+(a\s+|an\s+|\d+\s+)?(star|point|gem|token|sticker|reward)s?\b/i, what: 'a reward to collect' },
  { re: /\b(points?|stars?|gems?)\s*(:|=|\+=)\s*\d|\b(points?|stars?|gems?)\s*\+\+/i, what: 'a running points total' },
];

export function reviewActivity(html: string): ActivityReview {
  const refusals: ActivityFinding[] = [];
  const flags: ActivityFinding[] = [];
  const code = scripts(html);
  const text = childFacing(html);
  const both = `${code}\n${text}`;

  /* ------------------------------------------------- hard rule 5, enforced -- */

  for (const m of MECHANICS) {
    const hit = both.match(m.re);
    if (!hit) continue;
    refusals.push({
      rule: 'engagement_mechanics',
      message: `The activity uses ${m.what}, which this project does not put in front of children.`,
      hint:
        'Rule 5 in CLAUDE.md. Extrinsic motivation is an implementer choice this project has ' +
        'declined to make. Remove it. The work has to be worth doing on its own.',
      evidence: hit[0],
    });
    break; // one refusal is enough to send it back
  }

  /* --------------------------------------- evidence that can be reasoned on -- */

  // Aliasing is normal and good defensive code in a generated page, so this
  // looks for the concept anywhere in the script rather than for a call shape.
  // It errs toward accepting, the same way validate.ts does, because refusing a
  // page that does record responses is worse than missing one that does not.
  const observes = /\bobserve\b/.test(code);
  const recordsResponse = /\bresponse\b/.test(code);
  if (observes && !recordsResponse) {
    flags.push({
      rule: 'no_response_recorded',
      message: 'Attempts are recorded without what the child actually said or chose.',
      hint:
        'Pass `response` to primer.observe on every attempt, and `expected` with it. Correctness ' +
        'alone cannot be reasoned about later: a wrong answer with no response text is a zero in ' +
        'a column, and no misconception can ever be found in it. A better model later still has ' +
        'nothing to read. Some activities honestly have no text response, where the child taps a ' +
        'picture or reads aloud into a recording; record what they chose, or the artifact id.',
    });
  }

  /* ------------------------------------------------------------ judgments -- */

  // Flags, not refusals. Each is a real failure mode and none of them is
  // something a regex should be certain about.

  const branchesOnCorrectness =
    /\bif\s*\([^)]*\b(correct|right|wrong|isRight|ok|matched?)\b/i.test(code) ||
    /\b(correct|wrong|misses|errors|streakWrong)\b\s*(>=|>|<|===|==)/i.test(code);
  if (!branchesOnCorrectness) {
    flags.push({
      rule: 'no_visible_adaptation',
      message: 'Nothing in the page appears to change depending on how the child is doing.',
      hint:
        'The tutor will not be there. If they miss the same pattern twice it has to drop to ' +
        'something easier, and if they are flying it has to stretch. That logic can only be in ' +
        'the page.',
    });
  }

  const canEndEarly =
    /\b(end|finish|stop|done|wrapUp|bailOut)\b[\s\S]{0,80}\b(if|when)\b/i.test(code) ||
    /\bif\s*\([^)]*\b(frustrat|tired|misses|wrongInARow|consecutive)\b/i.test(code) ||
    /\bbreak\b/.test(code);
  if (!canEndEarly) {
    flags.push({
      rule: 'runs_to_a_fixed_length',
      message: 'The activity looks like it runs a set number of items whatever happens.',
      hint: 'It has to be able to stop early when it senses frustration, and to end on a win.',
    });
  }

  const PUNISHING = /\b(wrong!|incorrect|you failed|that'?s wrong|nope!|try harder|bad job)\b/i;
  const punishing = text.match(PUNISHING);
  if (punishing) {
    flags.push({
      rule: 'punishing_language',
      message: `The page says "${punishing[0]}" to a child.`,
      hint: 'Say what the right answer is and move on. A six-year-old reads this as a verdict on themselves.',
      evidence: punishing[0],
    });
  }

  return { refusals, flags };
}

/** A short, plain account for the tutor to act on. */
export function explainActivity(review: ActivityReview): string {
  const lines: string[] = [];
  for (const r of review.refusals) lines.push(`  - ${r.message}${r.hint ? ` ${r.hint}` : ''}`);
  for (const f of review.flags) lines.push(`  - ${f.message}${f.hint ? ` ${f.hint}` : ''}`);
  return lines.join('\n');
}
