import { rmSync } from 'node:fs';
import { all, one, run, id, now, logEvent, tx } from '../db/index.ts';
import type { Learner, Accommodation, Interest } from '../domain/types.ts';

export function createLearner(input: {
  display_name: string;
  birth_date?: string;
  locale?: string;
  timezone?: string;
  pronouns?: string;
}): Learner {
  const learnerId = id('lrn');
  run(
    `INSERT INTO learner (id, display_name, birth_date, locale, timezone, pronouns, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    learnerId,
    input.display_name,
    input.birth_date ?? null,
    input.locale ?? 'en-US',
    input.timezone ?? null,
    input.pronouns ?? null,
    now(),
  );
  logEvent('cli', 'create_learner', learnerId, { display_name: input.display_name });
  return getLearner(learnerId)!;
}

export function getLearner(learnerId: string): Learner | undefined {
  return one<Learner>(`SELECT * FROM learner WHERE id = ?`, learnerId);
}

export interface ForgetResult {
  learner: string;
  artifacts: number;
  interfaces: number;
  files_left_behind: string[];
}

/**
 * Erase a child from the record — rows *and* the files those rows point at.
 *
 * Deleting the learner row cascades through every table, which is what makes it
 * easy to believe the job is done. It is not: a child's voice recordings live in
 * `~/.primer/artifacts` and the generated activities in `~/.primer/interfaces`,
 * and a foreign key has no opinion about either. Cascading alone leaves the most
 * private thing here — audio of a six-year-old reading aloud — sitting on disk
 * with nothing left in the database that even names it.
 *
 * Files first, then rows. If a file cannot be removed, the path is returned so the
 * caller can say so out loud rather than reporting a clean deletion that was not.
 */
export function forgetLearner(learnerId: string): ForgetResult {
  const learner = getLearner(learnerId);
  if (!learner) throw new Error(`no such learner: ${learnerId}`);

  const paths = [
    ...all<{ path: string }>(`SELECT path FROM artifact WHERE learner_id = ?`, learnerId),
    ...all<{ path: string }>(`SELECT path FROM interface WHERE learner_id = ?`, learnerId),
  ];
  const artifacts = all<{ n: number }>(
    `SELECT count(*) AS n FROM artifact WHERE learner_id = ?`,
    learnerId,
  )[0]!.n;
  const interfaces = paths.length - artifacts;

  const stubborn: string[] = [];
  for (const { path } of paths) {
    if (!path) continue;
    try {
      rmSync(path, { force: true });
    } catch {
      stubborn.push(path);
    }
  }

  tx(() => run(`DELETE FROM learner WHERE id = ?`, learnerId));
  // Deliberately after the delete and deliberately without the name: the event log
  // survives, and it should not become the last place a deleted child is recorded.
  logEvent('cli', 'delete_learner', learnerId, { artifacts, interfaces });

  return { learner: learner.display_name, artifacts, interfaces, files_left_behind: stubborn };
}

export function listLearners(): Learner[] {
  return all<Learner>(`SELECT * FROM learner WHERE archived_at IS NULL ORDER BY created_at`);
}

/** Accept an id or a display name — tutors and humans both call this. */
export function resolveLearner(ref: string): Learner {
  const byId = getLearner(ref);
  if (byId) return byId;
  const byName = one<Learner>(
    `SELECT * FROM learner WHERE archived_at IS NULL AND lower(display_name) = lower(?)`,
    ref,
  );
  if (byName) return byName;
  const known = listLearners().map((l) => `${l.display_name} (${l.id})`).join(', ') || 'none yet';
  throw new Error(`No learner matching "${ref}". Known learners: ${known}`);
}

/** Age in years, or null if no birth date was recorded. */
export function ageYears(l: Learner, at = new Date()): number | null {
  if (!l.birth_date) return null;
  const born = new Date(l.birth_date);
  return Number(((at.getTime() - born.getTime()) / (365.2425 * 86_400_000)).toFixed(1));
}

/* --------------------------------------------------------- accommodations -- */

export function addAccommodation(
  learnerId: string,
  kind: string,
  detail: string,
  setBy = 'parent',
): Accommodation {
  const rowId = id('acc');
  run(
    `INSERT INTO accommodation (id, learner_id, kind, detail, active, set_by, created_at)
     VALUES (?, ?, ?, ?, 1, ?, ?)`,
    rowId,
    learnerId,
    kind,
    detail,
    setBy,
    now(),
  );
  logEvent(setBy, 'add_accommodation', learnerId, { kind, detail });
  return one<Accommodation>(`SELECT * FROM accommodation WHERE id = ?`, rowId)!;
}

export function accommodations(learnerId: string): Accommodation[] {
  return all<Accommodation>(
    `SELECT * FROM accommodation WHERE learner_id = ? AND active = 1 ORDER BY created_at`,
    learnerId,
  );
}

/* --------------------------------------------------------------- interests -- */

/** Interests reinforce on repeat mention and decay when unmentioned. */
export function noteInterest(
  learnerId: string,
  topic: string,
  opts: { weight?: number; source?: string; note?: string } = {},
): Interest {
  const bump = opts.weight ?? 0.35;
  const existing = one<Interest>(
    `SELECT * FROM interest WHERE learner_id = ? AND lower(topic) = lower(?)`,
    learnerId,
    topic,
  );
  if (existing) {
    run(
      `UPDATE interest SET weight = min(3.0, weight + ?), last_seen = ?, note = coalesce(?, note)
        WHERE id = ?`,
      bump,
      now(),
      opts.note ?? null,
      existing.id,
    );
    return one<Interest>(`SELECT * FROM interest WHERE id = ?`, existing.id)!;
  }
  const rowId = id('int');
  run(
    `INSERT INTO interest (id, learner_id, topic, weight, source, last_seen, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    rowId,
    learnerId,
    topic,
    opts.weight ?? 1.0,
    opts.source ?? 'observed',
    now(),
    opts.note ?? null,
  );
  logEvent('tutor:claude', 'note_interest', learnerId, { topic });
  return one<Interest>(`SELECT * FROM interest WHERE id = ?`, rowId)!;
}

/** Weight decayed by 30-day half-life, so last spring's obsession fades. */
export function interests(learnerId: string, at = new Date()): Array<Interest & { current: number }> {
  return all<Interest>(`SELECT * FROM interest WHERE learner_id = ?`, learnerId)
    .map((i) => {
      const days = (at.getTime() - new Date(i.last_seen).getTime()) / 86_400_000;
      return { ...i, current: Number((i.weight * Math.pow(2, -days / 30)).toFixed(3)) };
    })
    .filter((i) => i.current > 0.08)
    .sort((a, b) => b.current - a.current);
}
