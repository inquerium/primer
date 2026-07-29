/**
 * Mastery model: Bayesian Knowledge Tracing + a half-life forgetting curve.
 *
 * BKT answers "does she know it right now?"  The half-life answers "will she still
 * know it next Tuesday?"  Neither is the source of truth — both are recomputable
 * from the raw `observation` table at any time, which is the point.
 */

export interface BktParams {
  p_init: number;
  p_learn: number;
  p_guess: number;
  p_slip: number;
}

export interface MasteryState {
  p_known: number;
  opportunities: number;
  correct: number;
  streak: number;
  half_life_days: number;
  last_seen: string | null;
  /** The highest belief ever reached. Only this can distinguish lapsed from never-learned. */
  peak_p_known?: number;
}

export interface Evidence {
  /** 1 correct, 0 wrong, fractions allowed for partial credit. */
  correct: number;
  /** Each hint discounts the evidential value of a correct answer. */
  hint_count?: number;
  latency_ms?: number;
  /** Expected time for a fluent response; over ~3x counts as effortful. */
  fluent_ms?: number;
  at?: Date;
}

export const MASTERY_THRESHOLD = 0.95;
export const TEACHABLE_THRESHOLD = 0.7;
const MIN_HALF_LIFE = 0.25; // 6 hours
const MAX_HALF_LIFE = 365;
const TARGET_RECALL = 0.8;

const clamp = (x: number, lo = 0.001, hi = 0.999) => Math.min(hi, Math.max(lo, x));

/** Discount a raw score by hints used and by effortful (slow) retrieval. */
export function effectiveCorrect(e: Evidence): number {
  let c = Math.min(1, Math.max(0, e.correct));
  if (e.hint_count && e.hint_count > 0) c *= Math.pow(0.6, e.hint_count);
  if (e.latency_ms && e.fluent_ms && e.latency_ms > e.fluent_ms * 3) c *= 0.85;
  return c;
}

/** One BKT posterior update. `c` in [0,1]; fractions blend the two posteriors. */
export function bktUpdate(prior: number, c: number, p: BktParams): number {
  const pr = clamp(prior);
  const postCorrect =
    (pr * (1 - p.p_slip)) / (pr * (1 - p.p_slip) + (1 - pr) * p.p_guess);
  const postWrong = (pr * p.p_slip) / (pr * p.p_slip + (1 - pr) * (1 - p.p_guess));
  const posterior = c * postCorrect + (1 - c) * postWrong;
  // transition: chance of learning it from this very opportunity
  return clamp(posterior + (1 - posterior) * p.p_learn);
}

/** Probability the skill is still retrievable after `days` without practice. */
export function retrievability(
  pKnown: number,
  halfLifeDays: number,
  days: number,
  floor = 0,
): number {
  if (days <= 0) return pKnown;
  const fast = Math.pow(2, -days / Math.max(halfLifeDays, MIN_HALF_LIFE));
  return pKnown * (floor + (1 - floor) * fast);
}

/**
 * The share of a skill that stops decaying.
 *
 * Memory is not one curve. Something practiced correctly a dozen times over weeks
 * becomes partly permanent — a child who could read CVC words last spring has not
 * returned to zero by autumn, whatever a single exponential says. The floor grows
 * with successful repetitions and caps well below certainty.
 */
export function stabilityFloor(state: Pick<MasteryState, 'correct'>): number {
  return Math.min(0.6, 0.07 * state.correct);
}

/** Present-day belief: p_known decayed forward to `at`, with the floor applied. */
export function retention(state: MasteryState, at = new Date()): number {
  if (!state.last_seen) return state.p_known;
  return retrievability(
    state.p_known,
    state.half_life_days,
    daysBetween(new Date(state.last_seen), at),
    stabilityFloor(state),
  );
}

export function daysBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 86_400_000;
}

/**
 * Fold one observation into mastery state.
 * Decays first (time has passed since last practice), then applies evidence.
 */
export function applyEvidence(
  state: MasteryState,
  e: Evidence,
  params: BktParams,
): MasteryState {
  const at = e.at ?? new Date();
  const elapsed = state.last_seen ? daysBetween(new Date(state.last_seen), at) : 0;
  const decayed = retention(state, at);

  const c = effectiveCorrect(e);
  const p_known = bktUpdate(decayed, c, params);

  // Half-life growth is driven by the gap, not the repetition. Eight correct answers
  // on eight consecutive days is cramming: it earns a few weeks of retention, not a
  // year. The same eight spread across widening gaps earns far more. This is the
  // spacing effect, and getting it wrong is how practice apps end up certain a child
  // knows something they last saw in March.
  let hl = state.half_life_days;
  const backdated = state.last_seen ? elapsed < 0 : false;
  if (backdated) {
    // An observation timestamped before the last one we saw says nothing about
    // spacing. Left unguarded the gain denominator goes negative and a skill jumps
    // from "review in two hours" to "review in four months" across a 0.01-day
    // boundary — which is how a backfilled offline session corrupts a schedule.
    hl = state.half_life_days;
  } else if (c >= 0.6) {
    const relativeGap = Math.max(0, elapsed) / Math.max(hl, MIN_HALF_LIFE);
    // Floor of exactly 1: no elapsed time, no growth. Twenty items answered in one
    // sitting are one practice occasion, not twenty. Without this a single
    // enthusiastic session buys a three-month gap, which is precisely the failure
    // the spacing model exists to prevent.
    const gain = 1 + 1.4 * (relativeGap / (0.4 + relativeGap));
    hl = hl * gain * (0.7 + 0.3 * c);
  } else {
    hl = hl * (0.35 + 0.3 * c);
  }
  hl = Math.min(MAX_HALF_LIFE, Math.max(MIN_HALF_LIFE, hl));

  return {
    p_known,
    opportunities: state.opportunities + 1,
    correct: state.correct + (c >= 0.6 ? 1 : 0),
    streak: c >= 0.6 ? state.streak + 1 : 0,
    half_life_days: hl,
    // Backdated evidence must not move the clock backwards for everything after it.
    last_seen: backdated ? state.last_seen : at.toISOString(),
    peak_p_known: Math.max(state.peak_p_known ?? 0, p_known),
  };
}

/** When this should come back around, given the target recall probability. */
export function nextDue(state: MasteryState, targetRecall = TARGET_RECALL): string | null {
  if (!state.last_seen) return null;
  const days = state.half_life_days * Math.log2(1 / targetRecall);
  return new Date(new Date(state.last_seen).getTime() + days * 86_400_000).toISOString();
}

/**
 * Where this skill stands *right now*.
 *
 * Must be computed at read time, never stored. A status written the day a child
 * mastered something still says "mastered" a year later, while the same model's
 * arithmetic puts recall at 0.56 — and that stale word is what a parent reads.
 *
 * `lapsed` means "held it, then lost it", which requires knowing it was ever held.
 * That is what `peak_p_known` is for: without it, a child mid-learning who has had
 * three correct answers among many wrong ones gets reported as having *lost* a
 * skill she never had.
 */
export function statusOf(state: MasteryState, at = new Date()): 'unseen' | 'learning' | 'mastered' | 'lapsed' {
  if (state.opportunities === 0) return 'unseen';
  const nowP = retention(state, at);
  const everHeld = Math.max(state.peak_p_known ?? 0, state.p_known) >= MASTERY_THRESHOLD;

  if (everHeld && state.opportunities >= 4) {
    return nowP >= TEACHABLE_THRESHOLD ? 'mastered' : 'lapsed';
  }
  return 'learning';
}

export const DEFAULT_PARAMS: BktParams = {
  p_init: 0.15,
  p_learn: 0.2,
  p_guess: 0.2,
  p_slip: 0.1,
};
