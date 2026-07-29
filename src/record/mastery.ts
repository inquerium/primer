import { all, one, run, now, parseJson } from '../db/index.ts';
import type { Mastery, Skill } from '../domain/types.ts';
import {
  applyEvidence,
  effectiveCorrect,
  nextDue,
  statusOf,
  retention,
  type BktParams,
  type Evidence,
  type MasteryState,
} from '../domain/bkt.ts';

export function paramsFor(skill: Skill): BktParams {
  return {
    p_init: skill.p_init,
    p_learn: skill.p_learn,
    p_guess: skill.p_guess,
    p_slip: skill.p_slip,
  };
}

export function getMastery(learnerId: string, skillId: string): Mastery | undefined {
  return one<Mastery>(
    `SELECT * FROM mastery WHERE learner_id = ? AND skill_id = ?`,
    learnerId,
    skillId,
  );
}

function blank(skill: Skill): MasteryState {
  return {
    p_known: skill.p_init,
    opportunities: 0,
    correct: 0,
    streak: 0,
    half_life_days: 3,
    last_seen: null,
  };
}

export function toState(m: Mastery): MasteryState {
  return {
    p_known: m.p_known,
    opportunities: m.opportunities,
    correct: m.correct,
    streak: m.streak,
    half_life_days: m.half_life_days,
    last_seen: m.last_seen,
    peak_p_known: (m as Mastery & { peak_p_known?: number }).peak_p_known ?? m.p_known,
  };
}

/**
 * The status as of now, not as of whenever it was last written.
 *
 * The stored column is a convenience for queries; it goes stale the moment time
 * passes, because forgetting happens without any new evidence to trigger a rewrite.
 * Everything user-facing must ask this instead.
 */
export function statusNow(m: Mastery, at = new Date()) {
  return statusOf(toState(m), at);
}

export function upsertMastery(learnerId: string, skill: Skill, state: MasteryState): Mastery {
  const status = statusOf(state);
  const due = nextDue(state);
  run(
    `INSERT INTO mastery
       (learner_id, skill_id, p_known, opportunities, correct, streak, half_life_days,
        last_seen, next_due, status, peak_p_known)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(learner_id, skill_id) DO UPDATE SET
       p_known = excluded.p_known,
       opportunities = excluded.opportunities,
       correct = excluded.correct,
       streak = excluded.streak,
       half_life_days = excluded.half_life_days,
       last_seen = excluded.last_seen,
       next_due = excluded.next_due,
       status = excluded.status,
       peak_p_known = excluded.peak_p_known`,
    learnerId,
    skill.id,
    state.p_known,
    state.opportunities,
    state.correct,
    state.streak,
    state.half_life_days,
    state.last_seen,
    due,
    status,
    Math.max(state.peak_p_known ?? 0, state.p_known),
  );
  return getMastery(learnerId, skill.id)!;
}

/**
 * How fast counts as fluent for this skill, if the curriculum says.
 *
 * `op_fact_fluency_10` defines itself as "about 3 seconds, from memory, without
 * visible counting". Without reading this, a child who takes twenty seconds
 * counting on her fingers scores full marks and is reported as fluent — a false
 * claim about the one skill whose entire definition is speed.
 */
function fluentMs(skill: Skill): number | undefined {
  const probe = parseJson<{ fluent_ms?: number } | null>(skill.probe, null);
  return typeof probe?.fluent_ms === 'number' ? probe.fluent_ms : undefined;
}

/** Fold one piece of evidence into the learner's mastery of one skill. */
export function ingest(learnerId: string, skill: Skill, e: Evidence): Mastery {
  const existing = getMastery(learnerId, skill.id);
  const state = existing ? toState(existing) : blank(skill);
  const evidence: Evidence = { ...e, fluent_ms: e.fluent_ms ?? fluentMs(skill) };
  const updated = upsertMastery(learnerId, skill, applyEvidence(state, evidence, paramsFor(skill)));
  if (effectiveCorrect(evidence) >= 0.6) refreshPrerequisites(learnerId, skill.id, e.at ?? new Date());
  return updated;
}

const REFRESH_DEPTH = 2;
const REFRESH_HALF_LIFE_GAIN = 1.25;

/**
 * Reading a CVC word is practice of letter sounds, whether or not anyone said so.
 *
 * A correct answer refreshes the memory trace of everything the skill is built on:
 * the clock restarts and the interval stretches a little. `p_known` is carried
 * forward **unchanged** — not raised, because success on the harder skill only
 * proves the foundation held rather than improved; and not decayed, because the
 * child just demonstrated the foundation working. Decay is a prediction about
 * memory we cannot see. Watching the skill get used is seeing it, and the
 * prediction loses.
 *
 * Writing the decayed value here instead is a subtle disaster, and this code did
 * it for a while: each use banked whatever decay had accrued and then reset the
 * clock, so a prerequisite exercised constantly converged on zero. A child who had
 * just read ten CVC words correctly sat at p_known 0.0005 on short vowel sounds,
 * and the scheduler would have kept offering her vowel drills forever.
 *
 * Failure propagates nothing: a wrong answer is ambiguous about which layer broke,
 * and punishing the foundations on a guess is how models end up recommending
 * phonemic awareness drills to fluent readers.
 */
export function refreshPrerequisites(
  learnerId: string,
  skillId: string,
  at: Date,
  depth = REFRESH_DEPTH,
): void {
  if (depth <= 0) return;
  const parents = all<{ id: string }>(
    `SELECT from_skill AS id FROM skill_edge WHERE to_skill = ? AND kind IN ('prerequisite','component')`,
    skillId,
  );
  for (const parent of parents) {
    const m = getMastery(learnerId, parent.id);
    if (!m || !m.last_seen) continue; // never assessed — using it proves nothing yet
    if (new Date(m.last_seen) >= at) continue; // already fresher than this evidence
    const state = toState(m);
    const skill = one<Skill>(`SELECT * FROM skill WHERE id = ?`, parent.id);
    if (!skill) continue;
    upsertMastery(learnerId, skill, {
      ...state,
      // p_known deliberately untouched. See the note above — carrying the decayed
      // value here drives constantly-used foundations to zero.
      half_life_days: Math.min(365, state.half_life_days * REFRESH_HALF_LIFE_GAIN),
      last_seen: at.toISOString(),
    });
    refreshPrerequisites(learnerId, parent.id, at, depth - 1);
  }
}

/** Current retrievability, i.e. p_known decayed to right now. */
export function currentP(m: Mastery, at = new Date()): number {
  return retention(toState(m), at);
}

/**
 * Rebuild every mastery row for a learner from raw observations.
 * The cache is disposable; the evidence is not. Run this after changing the model.
 */
export function recompute(learnerId: string): number {
  const skills = new Map(all<Skill>(`SELECT * FROM skill`).map((s) => [s.id, s]));
  const obs = all<{
    skill_id: string | null;
    ts: string;
    correct: number | null;
    hint_count: number;
    latency_ms: number | null;
  }>(
    `SELECT skill_id, ts, correct, hint_count, latency_ms
       FROM observation
      WHERE learner_id = ?
        AND skill_id IS NOT NULL
        AND correct IS NOT NULL
        AND id NOT IN (SELECT supersedes FROM observation WHERE supersedes IS NOT NULL)
      ORDER BY ts ASC, rowid ASC`,
    learnerId,
  );

  // Replayed through the same path live evidence takes, so a rebuilt record and a
  // record that grew in place are guaranteed to agree — including propagation.
  run(`DELETE FROM mastery WHERE learner_id = ?`, learnerId);
  const touched = new Set<string>();
  for (const o of obs) {
    const skill = skills.get(o.skill_id!);
    if (!skill) continue;
    ingest(learnerId, skill, {
      correct: o.correct!,
      hint_count: o.hint_count,
      latency_ms: o.latency_ms ?? undefined,
      at: new Date(o.ts),
    });
    touched.add(skill.id);
  }

  run(
    `INSERT INTO event_log (ts, actor, action, target, payload) VALUES (?, 'cli', 'recompute', ?, ?)`,
    now(),
    learnerId,
    JSON.stringify({ skills: touched.size, observations: obs.length }),
  );
  return touched.size;
}
