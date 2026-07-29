import { all, one, run, id, now, tx, logEvent } from '../db/index.ts';
import type { Observation, Skill, Session, SessionMode, AffectSignal } from '../domain/types.ts';
import { ingest } from './mastery.ts';

export interface ObservationInput {
  skill_id?: string | null;
  session_id?: string | null;
  kind?: Observation['kind'];
  correct?: number | null;
  latency_ms?: number | null;
  hint_count?: number;
  item?: string | null;
  response?: string | null;
  expected?: string | null;
  modality?: Observation['modality'];
  source?: string | null;
  supersedes?: string | null;
  ts?: string;
  meta?: unknown;
}

export interface RecordResult {
  observation_id: string;
  skill_id: string | null;
  p_known: number | null;
  status: string | null;
  next_due: string | null;
}

/**
 * Write evidence and update the mastery cache in one transaction.
 * Observations are append-only: to correct one, write a new one with `supersedes`.
 */
export function recordObservations(
  learnerId: string,
  inputs: ObservationInput[],
  actor = 'tutor:claude',
): RecordResult[] {
  return tx(() => {
    const results: RecordResult[] = [];
    for (const input of inputs) {
      const obsId = id('obs');
      const ts = input.ts ?? now();
      run(
        `INSERT INTO observation
           (id, learner_id, skill_id, session_id, ts, kind, correct, latency_ms, hint_count,
            item, response, expected, modality, source, supersedes, meta)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        obsId,
        learnerId,
        input.skill_id ?? null,
        input.session_id ?? null,
        ts,
        input.kind ?? 'attempt',
        input.correct ?? null,
        input.latency_ms ?? null,
        input.hint_count ?? 0,
        input.item ?? null,
        input.response ?? null,
        input.expected ?? null,
        input.modality ?? null,
        input.source ?? null,
        input.supersedes ?? null,
        input.meta === undefined ? null : JSON.stringify(input.meta),
      );

      let p: number | null = null;
      let status: string | null = null;
      let due: string | null = null;

      if (input.skill_id && input.correct !== null && input.correct !== undefined) {
        const skill = one<Skill>(`SELECT * FROM skill WHERE id = ?`, input.skill_id);
        if (!skill) throw new Error(`Unknown skill "${input.skill_id}"`);
        const m = ingest(learnerId, skill, {
          correct: input.correct,
          hint_count: input.hint_count ?? 0,
          latency_ms: input.latency_ms ?? undefined,
          at: new Date(ts),
        });
        p = Number(m.p_known.toFixed(3));
        status = m.status;
        due = m.next_due;
      }

      results.push({
        observation_id: obsId,
        skill_id: input.skill_id ?? null,
        p_known: p,
        status,
        next_due: due,
      });
    }
    logEvent(actor, 'record_observations', learnerId, { count: inputs.length });
    return results;
  });
}

/** Raw evidence behind a mastery estimate — the "why does it think that" answer. */
export function evidenceFor(learnerId: string, skillId: string, limit = 25): Observation[] {
  return all<Observation>(
    // rowid breaks ties: several attempts inside one interface land on the same
    // millisecond, and "what did they do last" has to stay answerable.
    `SELECT * FROM observation
      WHERE learner_id = ? AND skill_id = ?
      ORDER BY ts DESC, rowid DESC LIMIT ?`,
    learnerId,
    skillId,
    limit,
  );
}

/* ---------------------------------------------------------------- sessions -- */

export function startSession(
  learnerId: string,
  opts: { mode?: SessionMode; target_skills?: string[]; interface_id?: string } = {},
): Session {
  const sessionId = id('ses');
  run(
    `INSERT INTO session (id, learner_id, started_at, mode, target_skills, interface_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId,
    learnerId,
    now(),
    opts.mode ?? 'practice',
    opts.target_skills ? JSON.stringify(opts.target_skills) : null,
    opts.interface_id ?? null,
  );
  logEvent('tutor:claude', 'start_session', sessionId, opts);
  return one<Session>(`SELECT * FROM session WHERE id = ?`, sessionId)!;
}

/**
 * Continue the session already open for this activity, or start one.
 *
 * A child who refreshes, or whose tablet reloads the page, is still in the same
 * sitting. Minting a session per page load turns one twenty-minute go at reading
 * into eight sessions of nothing, which is exactly the number a parent reads off
 * the progress page.
 */
export function resumeOrStartSession(
  learnerId: string,
  interfaceId: string,
  withinMinutes = 90,
): Session {
  const open = one<Session>(
    `SELECT * FROM session
      WHERE learner_id = ? AND interface_id = ? AND ended_at IS NULL
        AND started_at > datetime('now', ?)
      ORDER BY started_at DESC LIMIT 1`,
    learnerId,
    interfaceId,
    `-${withinMinutes} minutes`,
  );
  if (open) return open;
  return startSession(learnerId, { mode: 'practice', interface_id: interfaceId });
}

export function endSession(
  sessionId: string,
  opts: { summary?: string; energy?: string } = {},
): Session | undefined {
  run(
    `UPDATE session SET ended_at = ?, summary = coalesce(?, summary), energy = coalesce(?, energy)
      WHERE id = ?`,
    now(),
    opts.summary ?? null,
    opts.energy ?? null,
    sessionId,
  );
  logEvent('tutor:claude', 'end_session', sessionId, opts);
  return one<Session>(`SELECT * FROM session WHERE id = ?`, sessionId);
}

/**
 * Close sessions nobody ever ended.
 *
 * A child who wanders off, or closes the tab, leaves a session open forever. Left
 * alone these quietly inflate "minutes spent" on the progress page and make the
 * last-session summary useless. Ending them honestly — marked as abandoned rather
 * than finished — is better than pretending they are still running.
 */
export function closeStaleSessions(olderThanHours = 3): number {
  const stale = all<{ id: string }>(
    `SELECT id FROM session
      WHERE ended_at IS NULL AND started_at < datetime('now', ?)`,
    `-${olderThanHours} hours`,
  );
  for (const row of stale) {
    run(
      `UPDATE session SET ended_at = ?, summary = coalesce(summary, ?), energy = coalesce(energy, 'unknown')
        WHERE id = ?`,
      now(),
      'Not finished — the activity was closed or left open.',
      row.id,
    );
  }
  return stale.length;
}

/* ------------------------------------------------------------------ affect -- */

export function noteAffect(
  learnerId: string,
  signal: AffectSignal,
  opts: { intensity?: number; evidence?: string; session_id?: string; ts?: string } = {},
): void {
  run(
    `INSERT INTO affect (id, learner_id, session_id, ts, signal, intensity, evidence)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id('aff'),
    learnerId,
    opts.session_id ?? null,
    opts.ts ?? now(),
    signal,
    opts.intensity ?? 0.5,
    opts.evidence ?? null,
  );
}

/* ---------------------------------------------------------- misconceptions -- */

export function noteMisconception(
  learnerId: string,
  pattern: string,
  opts: { skill_id?: string; example?: string; strategy?: string } = {},
): { id: string; evidence_count: number; new: boolean } {
  const existing = one<{ id: string; evidence_count: number }>(
    `SELECT id, evidence_count FROM misconception
      WHERE learner_id = ? AND lower(pattern) = lower(?) AND status != 'resolved'`,
    learnerId,
    pattern,
  );
  if (existing) {
    run(
      `UPDATE misconception
          SET evidence_count = evidence_count + 1,
              last_seen = ?,
              status = 'active',
              strategy = coalesce(?, strategy),
              example = coalesce(?, example)
        WHERE id = ?`,
      now(),
      opts.strategy ?? null,
      opts.example ?? null,
      existing.id,
    );
    return { id: existing.id, evidence_count: existing.evidence_count + 1, new: false };
  }
  const rowId = id('msc');
  run(
    `INSERT INTO misconception
       (id, learner_id, skill_id, pattern, example, evidence_count, first_seen, last_seen, status, strategy)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, 'active', ?)`,
    rowId,
    learnerId,
    opts.skill_id ?? null,
    pattern,
    opts.example ?? null,
    now(),
    now(),
    opts.strategy ?? null,
  );
  logEvent('tutor:claude', 'note_misconception', learnerId, { pattern });
  return { id: rowId, evidence_count: 1, new: true };
}

export function resolveMisconception(
  misconceptionId: string,
  status: 'fading' | 'resolved',
  strategy?: string,
): void {
  run(
    `UPDATE misconception SET status = ?, last_seen = ?, strategy = coalesce(?, strategy) WHERE id = ?`,
    status,
    now(),
    strategy ?? null,
    misconceptionId,
  );
  logEvent('tutor:claude', 'resolve_misconception', misconceptionId, { status });
}
