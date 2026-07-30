import { all, run, now, logEvent } from '../db/index.ts';

/**
 * Fit each skill's BKT parameters to what actually happened, instead of leaving
 * them at the defaults.
 *
 * The shipped defaults (guess 0.20, slip 0.10, learn 0.20) are a reasonable prior
 * and nothing more. They are the same for "names the letter B" and "subtracts
 * across a zero", which cannot be right: a two-choice question has a guess rate
 * near 0.5, and a fluent child still slips on long multiplication far more often
 * than on their own name.
 *
 * The estimators here are the standard empirical ones, and they are deliberately
 * conservative:
 *
 *   p_guess  accuracy on a learner's *first* attempt at a skill, before anyone has
 *            taught it. Whatever they get right then, they got right without knowing.
 *   p_slip   error rate *after* a learner has demonstrated the skill (streak >= 3).
 *            Someone who knows it and still misses is slipping.
 *   p_learn  the rate at which a learner's first correct answer arrives, per
 *            opportunity spent not knowing it.
 *
 * Every one of these needs a real sample. With one child and a few hundred
 * observations, nothing here will have enough, and this will say so rather than
 * fitting noise. That refusal is the feature: a fitted-looking number computed
 * from eleven attempts is worse than an honest prior.
 */

export interface SkillFit {
  skill_id: string;
  name: string;
  samples: { first_attempts: number; post_mastery: number; learning_windows: number };
  current: { p_guess: number; p_slip: number; p_learn: number };
  fitted: { p_guess: number; p_slip: number; p_learn: number } | null;
  enough_data: boolean;
  why_not?: string;
}

export interface FitOptions {
  /** Minimum observations of each kind before a parameter is trusted. */
  minSamples?: number;
  apply?: boolean;
  actor?: string;
}

/**
 * What one install can contribute toward fitting parameters for the whole
 * community, without exposing anything about a specific child.
 *
 * These are exactly the six integers `fitParameters` reduces the evidence table
 * to before it computes anything — no item text, no responses, no timestamps, no
 * learner identity. Aggregating these across many installs is a fundamentally
 * smaller and safer thing than aggregating evidence, and it is the only thing
 * this file ever exports.
 */
export interface SkillContribution {
  skill_id: string;
  first_attempts: number;
  first_correct: number;
  post_mastery: number;
  post_mastery_wrong: number;
  learning_windows: number;
  opportunities_before_first_correct: number;
}

export interface Contribution {
  contribution_format: 1;
  skills: SkillContribution[];
}

const FLOOR = 0.02;
/**
 * A guess rate above a half means a wrong answer is *evidence of knowing*, which
 * is nonsense. Past this point BKT stops being identifiable and the model can
 * drive a child who has never once been right to "mastered" — I have watched it
 * happen with 200 consecutive wrong answers.
 */
const GUESS_CEILING = 0.5;
const SLIP_CEILING = 0.3;
/** How long a correct run must be before we call it learning rather than luck. */
const LEARNED_STREAK = 3;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

interface Tally {
  firstAttempts: number;
  firstCorrect: number;
  postMastery: number;
  postMasteryWrong: number;
  learningWindows: number;
  opportunitiesBeforeFirstCorrect: number;
}
const blankTally = (): Tally => ({
  firstAttempts: 0,
  firstCorrect: 0,
  postMastery: 0,
  postMasteryWrong: 0,
  learningWindows: 0,
  opportunitiesBeforeFirstCorrect: 0,
});

/**
 * One pass over the evidence, ordered per learner per skill, so we can tell a
 * first attempt from a post-mastery one. Reduces to the six counts every
 * downstream consumer here actually needs — the raw rows never leave this
 * function, including `learner_id` and `ts`, which exist only to order and
 * segment this pass.
 */
function computeTallies(): Map<string, Tally> {
  const rows = all<{
    learner_id: string;
    skill_id: string;
    correct: number;
    ts: string;
  }>(
    `SELECT learner_id, skill_id, correct, ts FROM observation
      WHERE skill_id IS NOT NULL AND correct IS NOT NULL
        AND id NOT IN (SELECT supersedes FROM observation WHERE supersedes IS NOT NULL)
      ORDER BY learner_id, skill_id, ts ASC, rowid ASC`,
  );

  const tally = new Map<string, Tally>();

  let currentKey = '';
  let streak = 0;
  let seenCorrect = false;
  let attemptsBeforeCorrect = 0;

  for (const row of rows) {
    const key = `${row.learner_id}|${row.skill_id}`;
    const t = tally.get(row.skill_id) ?? blankTally();
    tally.set(row.skill_id, t);

    if (key !== currentKey) {
      // New (learner, skill) pair — this row is a genuine first attempt.
      currentKey = key;
      streak = 0;
      seenCorrect = false;
      attemptsBeforeCorrect = 0;
      t.firstAttempts += 1;
      if (row.correct >= 0.6) t.firstCorrect += 1;
    }

    const right = row.correct >= 0.6;

    if (streak >= 3) {
      // They have shown they know it. Anything wrong now is a slip.
      t.postMastery += 1;
      if (!right) t.postMasteryWrong += 1;
    }

    if (!seenCorrect) {
      attemptsBeforeCorrect += 1;
      // "Learned" means the start of a run that held, not one lucky answer. Taking
      // the first isolated correct as the moment of learning makes this estimator
      // track the guess rate instead of the learning rate — measured 3x too high
      // on an easy item and 5x on a two-choice one.
      if (right && streak + 1 >= LEARNED_STREAK) {
        seenCorrect = true;
        t.learningWindows += 1;
        t.opportunitiesBeforeFirstCorrect += attemptsBeforeCorrect;
      }
    }

    streak = right ? streak + 1 : 0;
  }

  return tally;
}

/**
 * Everything a family can hand to the community to help fit priors for
 * everyone, and nothing else: six integer counts per skill this install has
 * ever touched. No learner id, no item text, no responses, no timestamps — the
 * tally pass that produces these never returns anything else, by construction.
 *
 * This never writes anything and never talks to a network. It is a local file,
 * same as `primer export` — what happens to it after that is a human decision,
 * not this function's.
 */
export function exportContribution(): Contribution {
  const tally = computeTallies();
  const skills: SkillContribution[] = [];
  for (const [skillId, t] of tally) {
    if (t.firstAttempts === 0) continue; // nothing touched, nothing to contribute
    skills.push({
      skill_id: skillId,
      first_attempts: t.firstAttempts,
      first_correct: t.firstCorrect,
      post_mastery: t.postMastery,
      post_mastery_wrong: t.postMasteryWrong,
      learning_windows: t.learningWindows,
      opportunities_before_first_correct: t.opportunitiesBeforeFirstCorrect,
    });
  }
  skills.sort((a, b) => a.skill_id.localeCompare(b.skill_id));
  return { contribution_format: 1, skills };
}

export function fitParameters(opts: FitOptions = {}): {
  fitted: SkillFit[];
  skipped: SkillFit[];
  applied: boolean;
  min_samples: number;
} {
  const minSamples = opts.minSamples ?? 30;

  const skills = all<{
    id: string;
    name: string;
    p_guess: number;
    p_slip: number;
    p_learn: number;
  }>(`SELECT id, name, p_guess, p_slip, p_learn FROM skill`);

  const tally = computeTallies();

  const fitted: SkillFit[] = [];
  const skipped: SkillFit[] = [];

  for (const skill of skills) {
    const t = tally.get(skill.id) ?? blankTally();
    const samples = {
      first_attempts: t.firstAttempts,
      post_mastery: t.postMastery,
      learning_windows: t.learningWindows,
    };
    const current = { p_guess: skill.p_guess, p_slip: skill.p_slip, p_learn: skill.p_learn };

    const shortfall: string[] = [];
    if (t.firstAttempts < minSamples) shortfall.push(`${t.firstAttempts}/${minSamples} first attempts`);
    if (t.postMastery < minSamples) shortfall.push(`${t.postMastery}/${minSamples} attempts after mastery`);
    if (t.learningWindows < minSamples) shortfall.push(`${t.learningWindows}/${minSamples} learning windows`);

    if (shortfall.length) {
      skipped.push({
        skill_id: skill.id,
        name: skill.name,
        samples,
        current,
        fitted: null,
        enough_data: false,
        why_not: shortfall.join(', '),
      });
      continue;
    }

    const next = {
      p_guess: clamp(t.firstCorrect / t.firstAttempts, FLOOR, GUESS_CEILING),
      p_slip: clamp(t.postMasteryWrong / t.postMastery, FLOOR, SLIP_CEILING),
      p_learn: clamp(t.learningWindows / t.opportunitiesBeforeFirstCorrect, 0.05, 0.5),
    };

    // BKT is only identifiable while guess + slip stays below one. Past that a
    // wrong answer raises belief and the model will tell a parent their child has
    // mastered something she has never once got right. Refuse rather than write it.
    if (next.p_guess + next.p_slip >= 0.95) {
      skipped.push({
        skill_id: skill.id,
        name: skill.name,
        samples,
        current,
        fitted: null,
        enough_data: false,
        why_not:
          `the numbers come out incoherent (guess ${next.p_guess.toFixed(2)} + slip ` +
          `${next.p_slip.toFixed(2)}); the prior is safer than this`,
      });
      continue;
    }

    fitted.push({
      skill_id: skill.id,
      name: skill.name,
      samples,
      current,
      fitted: {
        p_guess: Number(next.p_guess.toFixed(3)),
        p_slip: Number(next.p_slip.toFixed(3)),
        p_learn: Number(next.p_learn.toFixed(3)),
      },
      enough_data: true,
    });
  }

  if (opts.apply && fitted.length) {
    for (const f of fitted) {
      run(
        `UPDATE skill SET p_guess = ?, p_slip = ?, p_learn = ? WHERE id = ?`,
        f.fitted!.p_guess,
        f.fitted!.p_slip,
        f.fitted!.p_learn,
        f.skill_id,
      );
    }
    logEvent(opts.actor ?? 'cli', 'fit_parameters', null, {
      skills: fitted.length,
      min_samples: minSamples,
      at: now(),
    });
  }

  return { fitted, skipped, applied: Boolean(opts.apply && fitted.length), min_samples: minSamples };
}
