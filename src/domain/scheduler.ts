import { all } from '../db/index.ts';
import type { Mastery, Skill, SkillEdge, Target, Domain } from './types.ts';
import { MASTERY_THRESHOLD, TEACHABLE_THRESHOLD, retention, statusOf, daysBetween } from './bkt.ts';
import { toState } from '../record/mastery.ts';

export interface TargetOptions {
  domains?: Domain[];
  limit?: number;
  /** Include spaced-repetition reviews that have come due. Default true. */
  includeReview?: boolean;
  at?: Date;
}

interface Loaded {
  skills: Skill[];
  byId: Map<string, Skill>;
  prereqs: Map<string, string[]>;
  mastery: Map<string, Mastery>;
}

function load(learnerId: string): Loaded {
  const skills = all<Skill>(`SELECT * FROM skill ORDER BY domain, strand, ordinal`);
  const edges = all<SkillEdge>(`SELECT * FROM skill_edge WHERE kind = 'prerequisite'`);
  const mastery = all<Mastery>(`SELECT * FROM mastery WHERE learner_id = ?`, learnerId);

  const prereqs = new Map<string, string[]>();
  for (const e of edges) {
    const list = prereqs.get(e.to_skill) ?? [];
    list.push(e.from_skill);
    prereqs.set(e.to_skill, list);
  }
  return {
    skills,
    byId: new Map(skills.map((s) => [s.id, s])),
    prereqs,
    mastery: new Map(mastery.map((m) => [m.skill_id, m])),
  };
}

function pNow(skill: Skill, m: Mastery | undefined, at: Date): number {
  if (!m) return skill.p_init;
  return retention(m, at);
}

/**
 * What to work on next, and why.
 *
 * Four kinds of pull, in priority order:
 *   lapsed      — was known, has slipped. Cheapest win available.
 *   review_due  — spaced repetition says now, before it slips.
 *   stuck       — many attempts, still low. Signals "try a different approach",
 *                 which is the tutor's job, not the scheduler's.
 *   frontier    — prerequisites are solid, this is the next teachable thing.
 */
export function nextTargets(learnerId: string, opts: TargetOptions = {}): Target[] {
  const at = opts.at ?? new Date();
  const limit = opts.limit ?? 8;
  const includeReview = opts.includeReview ?? true;
  const { skills, byId, prereqs, mastery } = load(learnerId);
  const implied = impliedKnown(prereqs, mastery, at);

  const out: Target[] = [];

  for (const skill of skills) {
    if (opts.domains && !opts.domains.includes(skill.domain)) continue;

    const m = mastery.get(skill.id);
    // Soft, not silent. An implied-known skill is pushed to the back rather than
    // deleted from the world, so a child who stalls downstream still has a route
    // back to the foundation instead of being walled off from it forever.
    const impliedPenalty = !m && implied.has(skill.id) ? 0.45 : 0;

    const p = pNow(skill, m, at);
    const parents = prereqs.get(skill.id) ?? [];

    const blocked: string[] = [];
    let readiness = 1;
    for (const parentId of parents) {
      const parentSkill = byId.get(parentId);
      // An implied-known parent must not block its own children — that would
      // wall off the graph behind a skill nobody will ever formally assess.
      const pp = implied.has(parentId)
        ? TEACHABLE_THRESHOLD
        : parentSkill
          ? pNow(parentSkill, mastery.get(parentId), at)
          : 0;
      readiness = Math.min(readiness, pp);
      if (pp < TEACHABLE_THRESHOLD) blocked.push(parentId);
    }

    // Computed now, never read from the stored column: a status written months ago
    // still says "mastered" while this model's own arithmetic says the child has
    // probably forgotten it.
    const status = m ? statusOf(toState(m), at) : 'unseen';
    const opportunities = m?.opportunities ?? 0;

    let reason: Target['reason'] | null = null;
    let priority = 0;

    // A skill seen twice in March that has decayed to nothing was never learned.
    // Calling that a "review" and putting it at the top of the queue is how a child
    // ends up re-drilling the same abandoned material forever instead of moving.
    const neverLanded = p < 0.25 && opportunities < 5;
    const reviewDue = Boolean(includeReview && m?.next_due && new Date(m.next_due) <= at);

    if (opportunities >= 6 && p < 0.5 && status !== 'lapsed') {
      // Checked before everything else. A failing skill's interval collapses to
      // hours, so if `review_due` is tested first this signal is visible for about
      // two hours after the session and then vanishes — meaning the tutor is told
      // "try something different" essentially never, since the next run is the next
      // day. A child failing repeatedly is the most important thing in the queue.
      //
      // But stuck means never landed, not held and then forgotten. Six tries is an
      // ordinary number to learn something, so without the lapsed guard a child who
      // mastered a skill in spring and took the summer off comes back reported as
      // stuck: the tutor is told to change modality or drop to a prerequisite, when
      // the right move is a two-minute review of something she used to know. The
      // record already holds the distinction in `peak_p_known`, which is the only
      // thing that can tell "lost it" from "never had it", and `statusOf` is where
      // that reading lives.
      reason = 'stuck';
      priority = 0.95;
    } else if (m && status === 'lapsed') {
      // Was genuinely known. Restoring it is the cheapest win available, and the
      // more of it survives, the cheaper it is.
      reason = 'lapsed';
      priority = 0.8 + 0.2 * p;
    } else if (reviewDue && !neverLanded && p < MASTERY_THRESHOLD) {
      // A review is worth most while recall is still probable but slipping.
      // Near zero it is not a review, it is relearning, and it costs the same as
      // new material.
      reason = 'review_due';
      priority = 0.5 + 0.4 * p;
    } else if (blocked.length === 0 && p < MASTERY_THRESHOLD) {
      reason = 'frontier';
      // prefer the earliest teachable thing in each strand, weighted by how
      // solid its foundations are and how close it already is to clicking
      priority = 0.35 + 0.25 * readiness + 0.2 * p - Math.min(0.15, skill.ordinal / 400);
    }

    if (!reason) continue;

    out.push({
      skill,
      p_known: Number(p.toFixed(3)),
      status,
      reason,
      priority: Number(Math.max(0, priority - impliedPenalty).toFixed(3)),
      opportunities,
      last_seen: m?.last_seen ?? null,
      blocked_by: blocked,
    });
  }

  out.sort((a, b) => b.priority - a.priority);

  // Spread across strands so a session never becomes eight vowel-team drills.
  const perStrand = new Map<string, number>();
  const spread: Target[] = [];
  const overflow: Target[] = [];
  for (const t of out) {
    const key = `${t.skill.domain}:${t.skill.strand}`;
    const n = perStrand.get(key) ?? 0;
    if (n < 2) {
      perStrand.set(key, n + 1);
      spread.push(t);
    } else {
      overflow.push(t);
    }
  }
  return [...spread, ...overflow].slice(0, limit);
}

/**
 * Skills nobody has assessed but the child has clearly demonstrated by doing
 * something built on top of them.
 *
 * A child adding within twenty has not been formally observed counting to ten,
 * and never will be. Without this, the scheduler cheerfully offers "Counts to 10"
 * to a child doing two-digit place value, because unobserved reads as unknown.
 * Absence of evidence is not evidence of absence when the evidence is upstream.
 */
function impliedKnown(
  prereqs: Map<string, string[]>,
  mastery: Map<string, Mastery>,
  at: Date,
): Set<string> {
  // Competence, not exposure. Gating this on a lifetime count of two correct
  // answers was a quiet disaster: a child getting 10% of CVC words right — which is
  // a child whose letter sounds or blending are broken — had two lucky guesses, and
  // that permanently hid letter sounds, blending and phoneme isolation from her.
  // She would be drilled on CVC words forever while the real gap stayed invisible,
  // and the parent report showed those skills as "not started".
  const demonstrated = [...mastery.values()]
    .filter((m) => retention(m, at) >= TEACHABLE_THRESHOLD && m.correct >= 2)
    .map((m) => m.skill_id);
  const implied = new Set<string>();
  const queue = [...demonstrated];
  while (queue.length) {
    const current = queue.pop()!;
    for (const parent of prereqs.get(current) ?? []) {
      if (implied.has(parent)) continue;
      implied.add(parent);
      queue.push(parent);
    }
  }
  // Anything actually assessed keeps its real state — evidence beats inference.
  for (const id of mastery.keys()) implied.delete(id);
  return implied;
}

/** Skills that are teachable but not yet started — the leading edge. */
export function frontier(learnerId: string, domains?: Domain[]): Target[] {
  return nextTargets(learnerId, { domains, includeReview: false, limit: 200 }).filter(
    (t) => t.reason === 'frontier',
  );
}
