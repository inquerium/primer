/** Open Learner Record — type surface. Mirrors src/db/schema.sql. */

export type Domain = 'reading' | 'writing' | 'math';
export type GradeBand = 'pk' | 'k' | '1' | '2' | '3';
export type MasteryStatus = 'unseen' | 'learning' | 'mastered' | 'lapsed';
export type EdgeKind = 'prerequisite' | 'component' | 'extends';
export type ObservationKind =
  | 'attempt'
  | 'probe'
  | 'self_report'
  | 'tutor_judgment'
  | 'artifact_review';
export type Modality = 'spoken' | 'typed' | 'drawn' | 'selected' | 'manipulated';
export type AffectSignal =
  | 'frustration'
  | 'delight'
  | 'flow'
  | 'fatigue'
  | 'boredom'
  | 'pride';
export type SessionMode = 'play' | 'practice' | 'assess' | 'story' | 'free';

export interface Learner {
  id: string;
  display_name: string;
  birth_date: string | null;
  locale: string;
  timezone: string | null;
  pronouns: string | null;
  created_at: string;
  archived_at: string | null;
}

export interface Skill {
  id: string;
  domain: Domain;
  strand: string;
  name: string;
  description: string | null;
  grade_band: GradeBand | null;
  ordinal: number;
  probe: string | null;
  tags: string | null;
  p_init: number;
  p_learn: number;
  p_guess: number;
  p_slip: number;
}

export interface SkillEdge {
  from_skill: string;
  to_skill: string;
  kind: EdgeKind;
}

export interface Mastery {
  learner_id: string;
  skill_id: string;
  p_known: number;
  opportunities: number;
  correct: number;
  streak: number;
  half_life_days: number;
  last_seen: string | null;
  next_due: string | null;
  status: MasteryStatus;
}

export interface Observation {
  id: string;
  learner_id: string;
  skill_id: string | null;
  session_id: string | null;
  ts: string;
  kind: ObservationKind;
  correct: number | null;
  latency_ms: number | null;
  hint_count: number;
  item: string | null;
  response: string | null;
  expected: string | null;
  modality: Modality | null;
  source: string | null;
  supersedes: string | null;
  meta: string | null;
}

export interface Misconception {
  id: string;
  learner_id: string;
  skill_id: string | null;
  pattern: string;
  example: string | null;
  evidence_count: number;
  first_seen: string;
  last_seen: string;
  status: 'active' | 'fading' | 'resolved';
  strategy: string | null;
}

export interface Interest {
  id: string;
  learner_id: string;
  topic: string;
  weight: number;
  source: string | null;
  last_seen: string;
  note: string | null;
}

export interface Accommodation {
  id: string;
  learner_id: string;
  kind: string;
  detail: string;
  active: number;
  set_by: string | null;
  created_at: string;
}

export interface Session {
  id: string;
  learner_id: string;
  started_at: string;
  ended_at: string | null;
  mode: SessionMode | null;
  target_skills: string | null;
  interface_id: string | null;
  summary: string | null;
  energy: string | null;
}

export interface GeneratedInterface {
  id: string;
  learner_id: string;
  title: string;
  kind: string | null;
  path: string;
  spec: string | null;
  target_skills: string | null;
  created_at: string;
  times_used: number;
  outcome_score: number | null;
  outcome_note: string | null;
}

/** A skill the tutor should consider teaching right now, with the reason why. */
export interface Target {
  skill: Skill;
  p_known: number;
  status: MasteryStatus;
  reason: 'frontier' | 'review_due' | 'lapsed' | 'stuck' | 'goal';
  priority: number;
  opportunities: number;
  last_seen: string | null;
  blocked_by: string[];
}
