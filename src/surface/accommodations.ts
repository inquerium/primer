/**
 * Check a generated activity against the standing instructions for this child.
 *
 * SPEC.md says every generated interface MUST honor every active accommodation,
 * and calls it a hard constraint rather than a hint. Until now it was a hint:
 * `validateInterface` took a string of HTML and never learned who the activity
 * was for, so the only thing standing between a child with a no-timers
 * accommodation and a countdown was the tutor remembering.
 *
 * ## The rule that governs everything here
 *
 * **A check that cannot be performed does not pass.** It reports that it could
 * not be performed, and an adult is told before they approve.
 *
 * This is the difference between a safety net and a decoration. Silent success
 * on an accommodation nobody wrote a check for is worse than having no checker,
 * because a reviewer reading a clean report reasonably concludes the activity
 * was verified. Every kind this file does not know about, and every kind that
 * cannot be established from source text, comes back as `unverifiable` and
 * appears in the parent's review.
 *
 * ## Why some of these block and some do not
 *
 * An error refuses the activity outright and hands the reason back to the tutor
 * to fix and retry, which costs a retry. A warning reaches the adult reviewing
 * the queue. The line is drawn at confidence, not at severity: a countdown timer
 * in a page built for a child who cannot be timed is unambiguous in the source
 * and blocks. Whether the contrast is high enough cannot be established without
 * rendering the page, so it is never claimed either way.
 */

export interface ActiveAccommodation {
  kind: string;
  detail?: string | null;
}

export interface AccommodationFinding {
  kind: string;
  rule: string;
  message: string;
  hint?: string;
}

export interface AccommodationResult {
  errors: AccommodationFinding[];
  warnings: AccommodationFinding[];
  /** Kinds nothing here can establish from source. Never silently passed. */
  unverifiable: AccommodationFinding[];
}

/** Strip comments so a commented-out violation is not a violation. */
function styleText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
}

const has = (re: RegExp, s: string) => re.test(s);

/**
 * A countdown, as distinct from a timer.
 *
 * `setInterval` alone is not a violation: a page that animates a character or
 * polls its own state uses one and times nothing. The violation is a visible
 * clock running against the child, which in practice always pairs a repeating
 * callback with a decreasing named quantity.
 */
const COUNTDOWN_NAMES =
  /\b(countdown|time_?left|timeLeft|seconds_?left|secondsLeft|remaining(Time|Seconds)?|timeRemaining|deadline|expires?(At|In)?)\b/i;

interface Check {
  /** Aliases this check answers to. Accommodation kinds are free text. */
  matches: RegExp;
  /** Null when nothing in source text can establish it. */
  run: ((html: string, style: string) => Omit<AccommodationFinding, 'kind'>[]) | null;
  /** Why it cannot be checked, when it cannot. */
  because?: string;
  blocking: boolean;
}

const CHECKS: Check[] = [
  {
    matches: /timer|time_?limit|no_?rush|extra_?(processing_?)?time|untimed/i,
    blocking: true,
    run: (html, style) => {
      const out: Omit<AccommodationFinding, 'kind'>[] = [];
      const repeating = /\b(setInterval|requestAnimationFrame)\s*\(/.test(style);
      if (repeating && COUNTDOWN_NAMES.test(style)) {
        out.push({
          rule: 'countdown',
          message: 'The page runs a countdown, and this child must not be timed.',
          hint: 'Remove the clock entirely. Not a longer one, not a hidden one. Let the activity end when they are done.',
        });
      }
      if (/<(time|progress)\b[^>]*\bid\s*=\s*["'][^"']*(timer|countdown|remaining)/i.test(html)) {
        out.push({
          rule: 'countdown_element',
          message: 'The page shows an element that displays time running out.',
          hint: 'Remove it. A visible clock is the thing this accommodation exists to prevent.',
        });
      }
      return out;
    },
  },
  {
    matches: /dyslex|typograph|font|readable_?text/i,
    blocking: true,
    run: (html, style) => {
      const out: Omit<AccommodationFinding, 'kind'>[] = [];

      // Anything declared below 16px. A child who needs dyslexia-friendly
      // typography reading 12px text has been given a page that ignores them.
      const small = [...style.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/gi)]
        .map((m) => Number(m[1]))
        .filter((n) => n < 16);
      if (small.length) {
        out.push({
          rule: 'text_too_small',
          message: `Text is set at ${small.sort((a, b) => a - b)[0]}px; this child needs at least 18px.`,
          hint: 'Set a base font-size of 18px or more and scale everything from it.',
        });
      }

      if (/font-style\s*:\s*italic/i.test(style) || /<(em|i)\b/i.test(html)) {
        out.push({
          rule: 'italics',
          message: 'The page uses italics, which this child cannot read comfortably.',
          hint: 'Use weight or colour for emphasis instead of slant.',
        });
      }

      if (/text-align\s*:\s*justify/i.test(style)) {
        out.push({
          rule: 'justified',
          message: 'The text is justified, which opens rivers of white space between words.',
          hint: 'Left-align with a ragged right edge.',
        });
      }

      // A serif stack with no sans fallback anywhere on the page.
      const declaresFont = /font-family\s*:/i.test(style);
      const sans = /font-family[^;}]*\b(sans-serif|system-ui|-apple-system|Arial|Helvetica|Verdana|Tahoma|Segoe|Roboto|Inter|Open\s?Dyslexic)/i.test(style);
      if (declaresFont && !sans) {
        out.push({
          rule: 'serif_only',
          message: 'No sans-serif family is declared anywhere on the page.',
          hint: 'Serif letterforms are harder to tell apart. Name a sans-serif stack.',
        });
      }
      if (!declaresFont) {
        out.push({
          rule: 'no_font_declared',
          message: 'The page declares no font at all, so it inherits whatever the browser defaults to.',
          hint: 'This child has typography requirements. State them rather than hoping.',
        });
      }
      return out;
    },
  },
  {
    // Deliberately not matching "read aloud". This is the one check that
    // demands a page *have* something, and accommodation kinds are free text
    // written by a parent. "no_read_aloud_pressure" means do not make this child
    // read out loud, and an earlier version of this pattern matched it and then
    // refused every page that did not speak: the exact inversion of what the
    // adult asked for. A check that can invert a parent's instruction is worse
    // than no check, so that phrasing now falls through to unverifiable, which
    // is the honest answer for something no amount of HTML reading can settle.
    matches: /audio|spoken|listen|hears?_?first/i,
    blocking: true,
    run: (html, style) => {
      const speaks =
        /speechSynthesis|SpeechSynthesisUtterance/.test(style) ||
        /<audio\b/i.test(html) ||
        /new\s+Audio\s*\(/.test(style) ||
        /primer\s*\.\s*listen|\blisten\b/.test(style);
      return speaks
        ? []
        : [
            {
              rule: 'no_audio',
              message: 'Nothing on this page can be heard, and this child needs instructions spoken.',
              hint: 'Speak every instruction before it is written, with speechSynthesis or inline audio. They will not ask for it to be repeated.',
            },
          ];
    },
  },
  {
    matches: /motion|animat|vestibular/i,
    blocking: true,
    run: (_html, style) => {
      const animates = /@keyframes|animation\s*:|transition\s*:/i.test(style);
      const guarded = /prefers-reduced-motion/i.test(style);
      return animates && !guarded
        ? [
            {
              rule: 'unguarded_motion',
              message: 'The page animates without honoring reduced motion.',
              hint: 'Wrap movement in @media (prefers-reduced-motion: no-preference), or do not move.',
            },
          ]
        : [];
    },
  },
  {
    matches: /contrast|colou?r|vision|low_?vision/i,
    blocking: false,
    run: null,
    because:
      'contrast cannot be established from source text; it needs the page rendered and the ' +
      'computed colours compared',
  },
];

/**
 * Check one activity against one child's standing instructions.
 *
 * Pure. Takes the accommodations rather than a learner id, so nothing in the
 * surface layer needs to reach the record to answer this.
 */
export function checkAccommodations(
  html: string,
  active: ActiveAccommodation[],
): AccommodationResult {
  const errors: AccommodationFinding[] = [];
  const warnings: AccommodationFinding[] = [];
  const unverifiable: AccommodationFinding[] = [];
  const style = styleText(html);

  for (const a of active) {
    const check = CHECKS.find((c) => c.matches.test(a.kind));

    if (!check) {
      // The important branch. An accommodation nobody wrote a check for is not
      // satisfied, it is unexamined, and the adult approving this has to know
      // which of the two they are looking at.
      unverifiable.push({
        kind: a.kind,
        rule: 'no_check',
        message: `Nothing here can verify "${a.kind}", so it has not been checked.`,
        hint: a.detail ? `What it requires: ${a.detail}` : 'Read the activity against this yourself.',
      });
      continue;
    }

    if (!check.run) {
      unverifiable.push({
        kind: a.kind,
        rule: 'not_mechanisable',
        message: `"${a.kind}" was not checked: ${check.because}.`,
        hint: a.detail ? `What it requires: ${a.detail}` : undefined,
      });
      continue;
    }

    for (const finding of check.run(html, style)) {
      (check.blocking ? errors : warnings).push({ kind: a.kind, ...finding });
    }
  }

  return { errors, warnings, unverifiable };
}

/** A short, plain account for the tutor to act on. */
export function explainAccommodations(result: AccommodationResult): string {
  const lines: string[] = [];
  for (const e of result.errors) {
    lines.push(`  - [${e.kind}] ${e.message}${e.hint ? ` ${e.hint}` : ''}`);
  }
  for (const w of result.warnings) {
    lines.push(`  - [${w.kind}] ${w.message}${w.hint ? ` ${w.hint}` : ''}`);
  }
  return lines.join('\n');
}
