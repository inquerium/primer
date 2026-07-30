import { all, parseJson } from '../db/index.ts';
import type {
  Domain,
  GeneratedInterface,
  Misconception,
  Session,
  Target,
} from '../domain/types.ts';
import { nextTargets } from '../domain/scheduler.ts';
import {
  bandLabel,
  expectedBands,
  placementStatus,
  type PlacementStatus,
} from '../domain/placement.ts';
import { accommodations, ageYears, interests, resolveLearner } from './learners.ts';

export interface ContextOptions {
  domains?: Domain[];
  targetCount?: number;
  at?: Date;
}

/**
 * Everything a tutor needs to decide what to do with this child in the next
 * twenty minutes. One call, no follow-ups. This is the whole point of the record:
 * the tutor should never have to go fishing.
 */
export function learnerContext(ref: string, opts: ContextOptions = {}) {
  const learner = resolveLearner(ref);
  const at = opts.at ?? new Date();
  const lid = learner.id;

  const targets = nextTargets(lid, {
    domains: opts.domains,
    limit: opts.targetCount ?? 8,
    at,
  });

  const misconceptions = all<Misconception>(
    `SELECT * FROM misconception WHERE learner_id = ? AND status != 'resolved'
      ORDER BY status, evidence_count DESC LIMIT 12`,
    lid,
  );

  const recentSessions = all<Session>(
    `SELECT * FROM session WHERE learner_id = ? ORDER BY started_at DESC LIMIT 5`,
    lid,
  );

  const affectRecent = all<{ signal: string; n: number; avg: number }>(
    `SELECT signal, count(*) AS n, avg(intensity) AS avg
       FROM affect
      WHERE learner_id = ? AND ts > datetime('now', '-14 days')
      GROUP BY signal ORDER BY n DESC`,
    lid,
  );

  const provenInterfaces = all<GeneratedInterface>(
    `SELECT * FROM interface
      WHERE learner_id = ? AND outcome_score IS NOT NULL
      ORDER BY outcome_score DESC, times_used DESC LIMIT 5`,
    lid,
  );

  const recentInterfaces = all<GeneratedInterface>(
    `SELECT * FROM interface WHERE learner_id = ? ORDER BY created_at DESC LIMIT 3`,
    lid,
  );

  const progress = all<{ domain: string; strand: string; mastered: number; learning: number; total: number }>(
    `SELECT s.domain, s.strand,
            sum(CASE WHEN m.status = 'mastered' THEN 1 ELSE 0 END) AS mastered,
            sum(CASE WHEN m.status = 'learning' THEN 1 ELSE 0 END) AS learning,
            count(s.id) AS total
       FROM skill s
       LEFT JOIN mastery m ON m.skill_id = s.id AND m.learner_id = ?
      GROUP BY s.domain, s.strand
      ORDER BY s.domain, s.strand`,
    lid,
  );

  const cadence = all<{ sessions: number }>(
    `SELECT count(*) AS sessions FROM session
      WHERE learner_id = ? AND started_at > datetime('now', '-7 days')`,
    lid,
  )[0] ?? { sessions: 0 };

  const notes = all<{ author_role: string; text: string; created_at: string }>(
    `SELECT author_role, text, created_at FROM note WHERE learner_id = ?
      ORDER BY created_at DESC LIMIT 5`,
    lid,
  );

  const goals = all<{ id: string; text: string; set_by: string; target_date: string | null }>(
    `SELECT id, text, set_by, target_date FROM goal WHERE learner_id = ? AND status = 'open'`,
    lid,
  );

  const topInterests = interests(lid, at).slice(0, 8);

  const age = ageYears(learner, at);
  const placement = placementStatus(lid, at);

  return {
    learner: {
      id: learner.id,
      name: learner.display_name,
      age_years: age,
      /** Where children this age typically work. A starting guess for the tutor,
       *  never a comparison to put in front of anyone. */
      expected_bands: age == null ? null : expectedBands(age),
      pronouns: learner.pronouns,
      locale: learner.locale,
    },
    /** Hard constraints. Every generated interface must satisfy all of these. */
    accommodations: accommodations(lid).map((a) => ({ kind: a.kind, detail: a.detail })),
    interests: topInterests.map((i) => ({ topic: i.topic, strength: i.current, note: i.note })),
    goals,
    targets: targets.map(describeTarget),
    misconceptions: misconceptions.map((m) => ({
      id: m.id,
      pattern: m.pattern,
      skill_id: m.skill_id,
      example: m.example,
      seen: m.evidence_count,
      status: m.status,
      tried: m.strategy,
    })),
    affect_last_14d: affectRecent,
    cadence: { sessions_last_7d: cadence.sessions },
    progress,
    recent_sessions: recentSessions.map((s) => ({
      id: s.id,
      started_at: s.started_at,
      mode: s.mode,
      energy: s.energy,
      summary: s.summary,
      target_skills: parseJson<string[]>(s.target_skills, []),
    })),
    interfaces: {
      proven: provenInterfaces.map(describeInterface),
      recent: recentInterfaces.map(describeInterface),
    },
    notes,
    /** Non-null only while a cold start is being placed. See src/domain/placement.ts. */
    placement,
    guidance: guidance(
      targets,
      misconceptions,
      affectRecent,
      topInterests.map((i) => i.topic),
      subjectPronoun(learner.pronouns),
      placement,
    ),
  };
}

/** Use the pronouns the record holds. Where none were recorded, they/them. */
function subjectPronoun(pronouns: string | null): { subject: string; verb: string } {
  const first = (pronouns ?? '').split(/[\/\s,]+/)[0]?.toLowerCase();
  if (first === 'she') return { subject: 'she', verb: 'is' };
  if (first === 'he') return { subject: 'he', verb: 'is' };
  return { subject: 'they', verb: 'are' };
}

function describeTarget(t: Target) {
  return {
    skill_id: t.skill.id,
    name: t.skill.name,
    domain: t.skill.domain,
    strand: t.skill.strand,
    description: t.skill.description,
    probe: parseJson<Record<string, unknown> | null>(t.skill.probe, null),
    p_known: t.p_known,
    status: t.status,
    reason: t.reason,
    priority: t.priority,
    attempts_so_far: t.opportunities,
    last_seen: t.last_seen,
  };
}

function describeInterface(i: GeneratedInterface) {
  return {
    id: i.id,
    title: i.title,
    kind: i.kind,
    created_at: i.created_at,
    times_used: i.times_used,
    outcome_score: i.outcome_score,
    outcome_note: i.outcome_note,
    target_skills: parseJson<string[]>(i.target_skills, []),
    spec: parseJson<Record<string, unknown> | null>(i.spec, null),
  };
}

/**
 * Plain-language hints derived from the record. Not rules the tutor must obey —
 * observations it would otherwise have to re-derive every session.
 */
function guidance(
  targets: Target[],
  misconceptions: Misconception[],
  affect: Array<{ signal: string; n: number; avg: number }>,
  topics: string[],
  pronoun: { subject: string; verb: string },
  placement: PlacementStatus | null,
): string[] {
  const out: string[] = [];

  const placing = placement
    ? (Object.entries(placement.domains) as Array<[string, { status: string }]>)
        .filter(([, d]) => d.status === 'in_progress')
        .map(([domain]) => domain)
    : [];
  if (placement && placing.length) {
    const bands = placement.expected.bands.map(bandLabel).join(' or ');
    out.push(
      `Little is on record for ${placing.join(', ')} yet. At this age children are typically ` +
        `working around ${bands} material — a starting guess, not a verdict. Before teaching ` +
        `anything new, run one short assess-mode session: one playful activity probing the ` +
        `skills listed under placement, 2–3 quick items each, recorded with kind 'probe', ` +
        `mixed across strands, no teaching. End early and warmly if it is hard. The record ` +
        `will find the real starting line either way.`,
    );
  }

  const stuck = targets.filter((t) => t.reason === 'stuck');
  if (stuck.length) {
    out.push(
      `Stuck on ${stuck.map((t) => t.skill.name).join(', ')} — many attempts, little movement. ` +
        `Repeating the same drill will not work. Change modality or drop to a prerequisite.`,
    );
  }

  const lapsed = targets.filter((t) => t.reason === 'lapsed');
  if (lapsed.length) {
    out.push(`${lapsed.length} skill(s) have slipped since last practice. Quick wins — lead with these.`);
  }

  const frustration = affect.find((a) => a.signal === 'frustration');
  const delight = affect.find((a) => a.signal === 'delight');
  if (frustration && frustration.n >= 3 && (!delight || frustration.n > delight.n)) {
    out.push(
      `Frustration has outweighed delight over the last two weeks. Open with something already ` +
        `solid, keep the new material to one idea, and end before energy runs out.`,
    );
  }

  const active = misconceptions.filter((m) => m.status === 'active');
  if (active.length) {
    out.push(
      `Active misconceptions to work against, not around: ` +
        active.map((m) => `"${m.pattern}"`).join('; ') + '.',
    );
  }

  if (topics.length) {
    out.push(
      `Build items and stories out of what ${pronoun.subject} ${pronoun.verb} actually into: ` +
        `${topics.slice(0, 5).join(', ')}.`,
    );
  }

  if (!targets.length) {
    out.push(`No targets. Either the curriculum is not loaded, or everything is mastered — assess to find out.`);
  }

  return out;
}
