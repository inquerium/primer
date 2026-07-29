import { one, run } from './db/index.ts';
import type { Learner } from './domain/types.ts';
import { createLearner, addAccommodation, noteInterest } from './record/learners.ts';
import {
  recordObservations,
  startSession,
  endSession,
  noteAffect,
  noteMisconception,
  type ObservationInput,
} from './record/observations.ts';

/** Deterministic pseudo-randomness so the demo record is reproducible. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const CVC_A = ['cat', 'map', 'sad', 'bag', 'ran', 'hat', 'tap'];
const CVC_I = ['sit', 'pig', 'him', 'lid', 'win', 'big'];
const CVC_E = ['bed', 'hen', 'wet', 'leg', 'ten', 'pen'];

/**
 * A believable eight-week history for one child, so the record is worth reading
 * the moment it is installed. Ada is strong in math, behind in decoding, and
 * confuses short e with short i — a real and extremely common pattern.
 */
export function seedDemo(name = 'Ada'): { learner: Learner; observations: number; sessions: number } {
  const existing = one<Learner>(`SELECT * FROM learner WHERE display_name = ?`, name);
  if (existing) {
    return { learner: existing, observations: 0, sessions: 0 };
  }

  const rand = rng(20260727);
  const learner = createLearner({
    display_name: name,
    birth_date: isoDaysAgo(6 * 365 + 40),
    pronouns: 'she/her',
  });

  addAccommodation(learner.id, 'no_timers', 'No countdown timers of any kind — they shut her down.', 'parent');
  addAccommodation(
    learner.id,
    'typography',
    'Large text, generous line spacing, one line of print at a time when decoding.',
    'specialist',
  );

  noteInterest(learner.id, 'dinosaurs', { source: 'observed', note: 'Especially anything with a name she can say.' });
  noteInterest(learner.id, 'her dog Biscuit', { source: 'parent', note: 'Brown, elderly, features in every story she tells.' });
  noteInterest(learner.id, 'building things', { source: 'self_report' });
  noteInterest(learner.id, 'space', { source: 'observed', weight: 0.2 });

  let observations = 0;
  let sessions = 0;

  const push = (dayAgo: number, mode: any, rows: ObservationInput[], summary: string, energy: string) => {
    const session = startSession(learner.id, { mode });
    recordObservations(
      learner.id,
      rows.map((r) => ({ ...r, session_id: session.id, ts: isoDaysAgo(dayAgo) })),
    );
    endSession(session.id, { summary, energy });
    // Backdate the session itself so the history reads as eight weeks, not one day.
    run(
      `UPDATE session SET started_at = ?, ended_at = ? WHERE id = ?`,
      isoDaysAgo(dayAgo),
      isoDaysAgo(dayAgo - 0.015),
      session.id,
    );
    observations += rows.length;
    sessions += 1;
  };

  const attempt = (skill: string, item: string, ok: boolean, response?: string): ObservationInput => ({
    skill_id: skill,
    correct: ok ? 1 : 0,
    item,
    response: response ?? (ok ? item : ''),
    expected: item,
    modality: 'spoken',
    latency_ms: Math.round(1200 + rand() * 3500),
  });

  const arithmetic = (skill: string, a: number, b: number, op: '+' | '-', ok: boolean): ObservationInput => {
    const answer = op === '+' ? a + b : a - b;
    return {
      skill_id: skill,
      correct: ok ? 1 : 0,
      item: `${a} ${op} ${b}`,
      response: String(ok ? answer : answer + (rand() > 0.5 ? 1 : -1)),
      expected: String(answer),
      modality: 'typed',
      latency_ms: Math.round(900 + rand() * 2600),
    };
  };

  // --- week 1: baseline. Phonological awareness solid, decoding just starting.
  push(
    54,
    'assess',
    [
      attempt('pa_rhyme_recognize', 'cat / hat', true),
      attempt('pa_rhyme_recognize', 'dog / cup', true),
      attempt('pa_phoneme_blend_3', '/s/ /u/ /n/', true),
      attempt('pa_phoneme_blend_3', '/m/ /a/ /p/', true),
      attempt('pa_phoneme_segment_3', 'cat', true),
      attempt('pa_phoneme_segment_3', 'fish', false, '/f/ /i/ /s/ /h/'),
      attempt('al_letter_sounds_consonants', 'm', true),
      attempt('al_letter_sounds_consonants', 'g', true),
      attempt('al_letter_sounds_short_vowels', 'a', true),
      attempt('al_letter_sounds_short_vowels', 'e', false, '/i/'),
      arithmetic('op_add_within_10', 4, 3, '+', true),
      arithmetic('op_add_within_10', 6, 2, '+', true),
      arithmetic('op_sub_within_10', 9, 4, '-', true),
    ],
    'First look. Hears sounds well — blending is genuinely strong. Letter sounds solid except e. Math is ahead of reading by a fair margin.',
    'ok',
  );

  // --- weeks 2-4: short a and i land, short e does not.
  for (const [dayAgo, list, vowel] of [
    [47, CVC_A, 'a'],
    [44, CVC_A, 'a'],
    [40, CVC_I, 'i'],
    [37, CVC_I, 'i'],
  ] as const) {
    const skill = vowel === 'a' ? 'ph_cvc_short_a' : 'ph_cvc_short_i';
    push(
      dayAgo,
      'practice',
      list.slice(0, 5).map((w) => attempt(skill, w, rand() > 0.2)),
      `Short ${vowel} words. Getting steadier — sounding out rather than guessing from the first letter.`,
      'ok',
    );
  }

  push(
    33,
    'practice',
    [
      ...CVC_A.slice(0, 3).map((w) => attempt('ph_cvc_short_a', w, true)),
      ...CVC_I.slice(0, 3).map((w) => attempt('ph_cvc_short_i', w, true)),
      arithmetic('op_add_within_20', 8, 5, '+', true),
      arithmetic('op_make_ten', 9, 4, '+', true),
    ],
    'Short a and i are basically automatic now. Used dinosaur names as a warm-up and she read for twice as long as usual.',
    'high',
  );
  noteAffect(learner.id, 'delight', {
    intensity: 0.8,
    evidence: 'Asked to keep going twice after the last word.',
    ts: isoDaysAgo(33),
  });

  // --- weeks 5-7: short e collides with short i. The core story of this record.
  for (const dayAgo of [26, 22, 18, 13]) {
    const rows = CVC_E.slice(0, 5).map((w) => {
      const ok = rand() > 0.65;
      return attempt('ph_cvc_short_e', w, ok, ok ? w : w.replace('e', 'i'));
    });
    push(
      dayAgo,
      'practice',
      rows,
      'Short e again. Reads bed as bid, pen as pin. She is not guessing — she is applying /i/ consistently, which means it is a rule in her head, not carelessness.',
      dayAgo <= 18 ? 'low' : 'ok',
    );
    if (dayAgo <= 18) {
      noteAffect(learner.id, 'frustration', {
        intensity: 0.7,
        evidence: 'Pushed the page away after the third correction.',
        ts: isoDaysAgo(dayAgo),
      });
    }
  }

  noteMisconception(learner.id, 'Reads short e as short i (bed → bid, pen → pin)', {
    skill_id: 'ph_cvc_short_e',
    example: 'Read "ten" as "tin" three times in one session without hesitating.',
    strategy:
      'Minimal pairs side by side (pin/pen) helped for about a minute, then faded. Not yet solved. ' +
      'Try mouth position — /e/ is open, /i/ is tight — and let her feel it before she sees the word.',
  });

  // --- math keeps moving while reading is stuck. Worth seeing in the record.
  push(
    11,
    'play',
    [
      arithmetic('op_add_within_20', 7, 8, '+', true),
      arithmetic('op_add_within_20', 9, 6, '+', true),
      arithmetic('op_doubles', 7, 7, '+', true),
      arithmetic('op_near_doubles', 6, 7, '+', true),
      arithmetic('op_sub_within_20', 15, 7, '-', false),
      arithmetic('op_sub_within_20', 13, 6, '-', true),
      { skill_id: 'pv_tens_ones', correct: 1, item: '47', response: '4 tens, 7 ones', modality: 'spoken' },
      { skill_id: 'pv_tens_ones', correct: 1, item: '82', response: '8 tens, 2 ones', modality: 'spoken' },
    ],
    'Counted dinosaurs into groups of ten. Doubles are instant now. Subtraction across ten still needs fingers, which is fine.',
    'high',
  );
  noteAffect(learner.id, 'flow', {
    intensity: 0.9,
    evidence: 'Twenty minutes without looking up.',
    ts: isoDaysAgo(11),
  });

  // --- last week: writing enters, and a small win on e.
  push(
    5,
    'story',
    [
      { skill_id: 'en_cvc_short_vowels', correct: 1, item: 'dictate: cat', response: 'cat', modality: 'typed' },
      { skill_id: 'en_cvc_short_vowels', correct: 0, item: 'dictate: bed', response: 'bid', modality: 'typed' },
      {
        skill_id: 'co_single_sentence',
        correct: 1,
        item: 'Write one sentence about Biscuit.',
        response: 'My dog is big and he naps a lot.',
        modality: 'typed',
      },
      { skill_id: 'cv_capital_start', correct: 1, item: 'sentence start', response: 'M', modality: 'typed' },
      { skill_id: 'cv_end_punctuation', correct: 1, item: 'sentence end', response: '.', modality: 'typed' },
      attempt('ph_cvc_short_e', 'hen', true),
      attempt('ph_cvc_short_e', 'wet', false, 'wit'),
    ],
    'Wrote a whole sentence about the dog unprompted and read it back correctly. The e/i swap shows up in spelling too, which confirms it is one problem and not two.',
    'ok',
  );
  noteAffect(learner.id, 'pride', {
    intensity: 0.9,
    evidence: 'Read her own sentence out loud to her father twice.',
    ts: isoDaysAgo(5),
  });

  return { learner, observations, sessions };
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString();
}
