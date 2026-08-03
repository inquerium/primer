/**
 * Synthetic learner records, built to order.
 *
 * Every pipeline agent works against these and never against a real family
 * record. That boundary is stated in docs/OPENCLAW.md and it is the reason this
 * directory exists: an agent holding a path to a `.db` file it did not build
 * from a persona here is a mistake or an attack, and has no legitimate task.
 *
 * Each persona is a claim about the model, made in evidence rather than in
 * prose. `stuck-blending` is not a child who is loosely struggling: it is nine
 * attempts and two correct answers, which is the exact shape that makes
 * `nextTargets` return reason 'stuck'. An agent measuring a detector against
 * these needs to know what is true by construction, so every persona carries an
 * `expect` block saying so, and test/fixtures.test.ts holds the corpus to it.
 *
 * That test is the point. A fixture that quietly stops exhibiting the property
 * it is named for does not fail loudly; it makes every agent downstream of it
 * report success against nothing.
 */

import { loadCurriculum } from '../../src/curriculum/load.ts';
import { createLearner, addAccommodation, noteInterest } from '../../src/record/learners.ts';
import { recordObservations, type ObservationInput } from '../../src/record/observations.ts';

/**
 * One fixed instant the whole corpus is written relative to.
 *
 * Personas that depend on elapsed time (`lapsed-summer`, `crammer`) are only
 * meaningful when read at a known "now". Building against `new Date()` makes a
 * fixture whose properties drift with the wall clock, which is how a corpus
 * turns into a flaky test suite nobody trusts.
 */
export const AS_OF = new Date('2026-08-03T12:00:00.000Z');

/** `days` before AS_OF, as an ISO timestamp. */
export function daysAgo(days: number, hourOffset = 0): string {
  return new Date(AS_OF.getTime() - days * 86_400_000 + hourOffset * 3_600_000).toISOString();
}

/** A birth date that lands on exactly `years` old at AS_OF. */
function bornAtAge(years: number): string {
  const d = new Date(AS_OF);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

export interface Persona {
  id: string;
  /** One line, for an agent deciding whether this is the fixture it needs. */
  summary: string;
  /**
   * What is true of this record by construction. An agent measuring a detector
   * scores itself against these, not against its own judgment of the output.
   */
  expect: string[];
  build(): BuiltPersona;
}

export interface BuiltPersona {
  learner_id: string;
  name: string;
  /** Read the record at this instant, or the time-dependent claims do not hold. */
  as_of: Date;
}

/** Write a run of attempts at one skill, spaced across days. */
function attempts(
  learnerId: string,
  skillId: string,
  results: Array<{ correct: number; day: number; item?: string; response?: string; expected?: string }>,
): void {
  const inputs: ObservationInput[] = results.map((r) => ({
    skill_id: skillId,
    kind: 'attempt',
    correct: r.correct,
    latency_ms: r.correct >= 0.6 ? 2400 : 7100,
    item: r.item ?? null,
    response: r.response ?? null,
    expected: r.expected ?? null,
    modality: 'selected',
    source: 'fixture',
    ts: daysAgo(r.day),
  }));
  recordObservations(learnerId, inputs, 'fixture');
}

/** Drive a skill to mastery: eight correct answers across widening gaps. */
function mastered(learnerId: string, skillId: string, startedDaysAgo: number): void {
  const gaps = [0, 1, 3, 6, 10, 15, 21, 28];
  attempts(
    learnerId,
    skillId,
    gaps.map((g) => ({ correct: 1, day: startedDaysAgo - g })),
  );
}

/* ------------------------------------------------------------- the corpus -- */

export const PERSONAS: Persona[] = [
  {
    id: 'cold-start',
    summary: 'Eight years old, nothing on record. The case placement exists for.',
    expect: [
      'learnerContext().placement is non-null and reading is in_progress',
      'no mastery rows exist',
      'nextTargets returns only reason "frontier"',
      'expected_bands comes from age alone: a starting guess, never a verdict',
      'without placement she would be offered rhyme recognition on day one',
    ],
    build() {
      // Age is load-bearing. placement.ts returns null for pk and k children
      // because for them the roots of the graph are the right starting point.
      // The failure placement exists to prevent belongs to the older child who
      // walks in knowing things and would otherwise grind up from pencil grip.
      const learner = createLearner({
        display_name: 'Wren',
        birth_date: bornAtAge(8),
        pronouns: 'they/them',
      });
      noteInterest(learner.id, 'trucks', { source: 'parent' });
      return { learner_id: learner.id, name: learner.display_name, as_of: AS_OF };
    },
  },

  {
    id: 'cold-start-young',
    summary: 'Five years old, nothing on record. Placement is deliberately not offered.',
    expect: [
      'learnerContext().placement is null, because the expected band is k',
      'this is the boundary at placement.ts:230, and it is a decision rather than a gap',
      'the roots of the graph are the right first material for this child',
    ],
    build() {
      const learner = createLearner({
        display_name: 'Bo',
        birth_date: bornAtAge(5),
        pronouns: 'he/him',
      });
      noteInterest(learner.id, 'diggers', { source: 'parent' });
      return { learner_id: learner.id, name: learner.display_name, as_of: AS_OF };
    },
  },

  {
    id: 'stuck-blending',
    summary: 'Six years old, nine attempts at blending three sounds and still failing.',
    expect: [
      'nextTargets includes pa_phoneme_blend_3 with reason "stuck"',
      'that target outranks every lapsed and review_due target in the queue',
      'opportunities >= 6 and p_known < 0.5, which is the condition scheduler.ts tests first',
    ],
    build() {
      const learner = createLearner({
        display_name: 'Ida',
        birth_date: bornAtAge(6),
        pronouns: 'she/her',
      });
      mastered(learner.id, 'pa_phoneme_isolate_initial', 60);
      // Nine attempts, two correct, spread over three weeks. Repetition without
      // movement is the signal: the scheduler must say "try something else"
      // rather than offering the same drill again.
      attempts(learner.id, 'pa_phoneme_blend_3', [
        { correct: 0, day: 21 },
        { correct: 0, day: 19 },
        { correct: 1, day: 16 },
        { correct: 0, day: 14 },
        { correct: 0, day: 11 },
        { correct: 0, day: 9 },
        { correct: 1, day: 6 },
        { correct: 0, day: 4 },
        { correct: 0, day: 2 },
      ]);
      noteInterest(learner.id, 'horses', { source: 'observed' });
      return { learner_id: learner.id, name: learner.display_name, as_of: AS_OF };
    },
  },

  {
    id: 'lapsed-summer',
    summary:
      'Crammed three skills in spring and took the summer off. A fourth was spaced properly and survived it.',
    expect: [
      'the three crammed skills read "lapsed" at AS_OF and surface with reason "lapsed"',
      'ph_cvc_short_o was practiced across widening gaps and is still "mastered" after the same summer',
      'that contrast is the spacing effect, visible in one record',
      'peak_p_known is what separates all four from skills never learned',
      'stabilityFloor keeps the lapsed three above zero, so they are review and not relearning',
    ],
    build() {
      const learner = createLearner({
        display_name: 'Cyrus',
        birth_date: bornAtAge(7),
        pronouns: 'he/him',
      });
      // Six reps on six consecutive days buys a half-life near two weeks. A
      // summer away is then five half-lives, and it is gone.
      for (const skill of ['al_letter_sounds_short_vowels', 'ph_cvc_short_a', 'ph_cvc_short_i']) {
        attempts(
          learner.id,
          skill,
          [0, 1, 2, 3, 4, 5].map((g) => ({ correct: 1, day: 100 - g })),
        );
      }
      // The same number of correct answers, spread. Two months of half-life, and
      // the identical absence leaves it intact. Nothing about the child differs.
      mastered(learner.id, 'ph_cvc_short_o', 110);
      noteInterest(learner.id, 'sharks', { source: 'child' });
      return { learner_id: learner.id, name: learner.display_name, as_of: AS_OF };
    },
  },

  {
    id: 'crammer',
    summary: 'Twenty correct answers in one sitting, and nothing before or since.',
    expect: [
      'half_life_days stays under 30: one sitting is one practice occasion, not twenty',
      'next_due lands within weeks, never months',
      'the same twenty answers spread across widening gaps would earn far more retention',
    ],
    build() {
      const learner = createLearner({
        display_name: 'Nia',
        birth_date: bornAtAge(6),
        pronouns: 'she/her',
      });
      // All on one day, minutes apart. The spacing model exists to stop this
      // buying a three-month interval.
      attempts(
        learner.id,
        'cc_count_to_20',
        Array.from({ length: 20 }, (_, i) => ({ correct: 1, day: 9 - i * 0.002 })),
      );
      return { learner_id: learner.id, name: learner.display_name, as_of: AS_OF };
    },
  },

  {
    id: 'vowel-confuser',
    summary:
      'Reads every short e as short i. The misconception is in the response column, by construction.',
    expect: [
      'every wrong answer on ph_cvc_short_e substitutes the short i word: bed -> bid, pen -> pin',
      'the same substitution appears on pa_phoneme_isolate_medial, so it is a model and not a word gap',
      'ph_cvc_short_i is mastered, which rules out "does not know short i"',
      'no misconception row exists: this corpus is the ground truth a miner must find unaided',
    ],
    build() {
      const learner = createLearner({
        display_name: 'Ada',
        birth_date: bornAtAge(6),
        pronouns: 'she/her',
      });
      mastered(learner.id, 'ph_cvc_short_a', 90);
      mastered(learner.id, 'ph_cvc_short_i', 75);
      mastered(learner.id, 'ph_cvc_short_o', 60);
      mastered(learner.id, 'ph_cvc_short_u', 45);

      // The tell is the response text, not the score. A detector that reads only
      // `correct` cannot tell this child from one who is simply guessing, and
      // that difference is the whole of what a good tutor carries in their head.
      const pairs = [
        ['bed', 'bid'],
        ['pen', 'pin'],
        ['den', 'din'],
        ['bet', 'bit'],
        ['pet', 'pit'],
        ['led', 'lid'],
        ['ten', 'tin'],
        ['beg', 'big'],
      ];
      attempts(
        learner.id,
        'ph_cvc_short_e',
        pairs.map(([expected, said], i) => ({
          correct: 0,
          day: 20 - i * 2,
          item: expected!,
          response: said!,
          expected: expected!,
        })),
      );
      attempts(learner.id, 'pa_phoneme_isolate_medial', [
        { correct: 0, day: 12, item: 'bed', response: 'i', expected: 'e' },
        { correct: 0, day: 9, item: 'net', response: 'i', expected: 'e' },
        { correct: 1, day: 7, item: 'cat', response: 'a', expected: 'a' },
        { correct: 0, day: 5, item: 'leg', response: 'i', expected: 'e' },
        { correct: 1, day: 3, item: 'dog', response: 'o', expected: 'o' },
      ]);
      noteInterest(learner.id, 'Biscuit the dog', { source: 'child', weight: 0.6 });
      return { learner_id: learner.id, name: learner.display_name, as_of: AS_OF };
    },
  },

  {
    id: 'accommodated',
    summary: 'Three standing accommodations. Every generated activity must honor all of them.',
    expect: [
      'learnerContext().accommodations has exactly three active entries',
      'dyslexia_typography, no_timers, and audio_first are all present',
      'an activity containing a countdown timer is a violation, not a warning',
      'nothing in validateInterface currently checks any of this',
    ],
    build() {
      const learner = createLearner({
        display_name: 'Tomas',
        birth_date: bornAtAge(8),
        pronouns: 'he/him',
      });
      addAccommodation(
        learner.id,
        'dyslexia_typography',
        'Sans-serif, at least 18px, extra letter spacing, no italics, left-aligned ragged right.',
      );
      addAccommodation(
        learner.id,
        'no_timers',
        'No countdowns, no clocks, no time pressure of any kind. Timing anything visibly stops him working.',
      );
      addAccommodation(
        learner.id,
        'audio_first',
        'Every instruction is spoken before it is written. He will not ask for it to be repeated.',
      );
      mastered(learner.id, 'ph_cvc_mixed', 40);
      noteInterest(learner.id, 'volcanoes', { source: 'child' });
      return { learner_id: learner.id, name: learner.display_name, as_of: AS_OF };
    },
  },

  {
    id: 'above-band',
    summary: 'Six years old and working two grades up. The expected band is wrong about her.',
    expect: [
      'evidence sits in grade 2 place value while expected_bands from age says k and 1',
      'impliedKnown pushes counting-to-ten style prerequisites down the queue rather than deleting them',
      'those implied skills stay reachable, so a stall downstream still has a route back',
      'a scheduler that treats unobserved as unknown would offer her "Counts to 10"',
    ],
    build() {
      const learner = createLearner({
        display_name: 'Suri',
        birth_date: bornAtAge(6),
        pronouns: 'she/her',
      });
      // Nothing upstream is ever formally assessed. Competence is demonstrated
      // from above, which is exactly the case impliedKnown exists to handle.
      mastered(learner.id, 'pv_teen_numbers', 70);
      mastered(learner.id, 'cc_count_by_10s', 55);
      noteInterest(learner.id, 'space', { source: 'child', weight: 0.7 });
      return { learner_id: learner.id, name: learner.display_name, as_of: AS_OF };
    },
  },
];

export function persona(id: string): Persona {
  const found = PERSONAS.find((p) => p.id === id);
  if (!found) {
    throw new Error(`no persona "${id}". Known: ${PERSONAS.map((p) => p.id).join(', ')}`);
  }
  return found;
}

/**
 * Build one persona into the currently open record.
 *
 * The caller owns the database. Point PRIMER_DB at a temporary file first; this
 * never opens or creates a record on its own, so there is no path by which it
 * can write into one that matters.
 */
export function buildPersona(id: string): BuiltPersona {
  loadCurriculum();
  return persona(id).build();
}

/** Build every persona into one record. Each is an independent learner. */
export function buildAll(): Record<string, BuiltPersona> {
  loadCurriculum();
  const out: Record<string, BuiltPersona> = {};
  for (const p of PERSONAS) out[p.id] = p.build();
  return out;
}
