import { all, one, run, id, now, logEvent, parseJson } from '../db/index.ts';
import { settings } from '../agent/config.ts';

export type ActivityStatus =
  | 'pending_review'
  | 'ready'
  | 'delivered'
  | 'done'
  | 'skipped'
  | 'rejected';

export interface PlannedActivity {
  id: string;
  learner_id: string;
  interface_id: string | null;
  title: string;
  rationale: string | null;
  target_skills: string | null;
  position: number;
  status: ActivityStatus;
  planned_for: string | null;
  created_by: string;
  created_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_note: string | null;
  delivered_at: string | null;
  completed_at: string | null;
}

export interface PlanInput {
  interface_id: string;
  title: string;
  rationale?: string;
  target_skills?: string[];
  planned_for?: string;
}

/**
 * Add something to what the child will meet next.
 *
 * Whether it lands as `ready` or `pending_review` is not the tutor's call — it
 * is the install's `review_required` setting. An autonomous system that could
 * decide for itself whether its own output needs review isn't reviewed.
 */
export function planActivity(learnerId: string, input: PlanInput, by = 'tutor:claude'): PlannedActivity {
  const rowId = id('act');
  const next = one<{ n: number | null }>(
    `SELECT max(position) AS n FROM planned_activity
      WHERE learner_id = ? AND status IN ('pending_review', 'ready')`,
    learnerId,
  );
  const status: ActivityStatus = settings().review_required ? 'pending_review' : 'ready';

  run(
    `INSERT INTO planned_activity
       (id, learner_id, interface_id, title, rationale, target_skills, position, status,
        planned_for, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    rowId,
    learnerId,
    input.interface_id,
    input.title,
    input.rationale ?? null,
    input.target_skills ? JSON.stringify(input.target_skills) : null,
    (next?.n ?? 0) + 1,
    status,
    input.planned_for ?? null,
    by,
    now(),
  );
  logEvent(by, 'plan_activity', rowId, { title: input.title, status });
  return getActivity(rowId)!;
}

export function getActivity(activityId: string): PlannedActivity | undefined {
  return one<PlannedActivity>(`SELECT * FROM planned_activity WHERE id = ?`, activityId);
}

export function queue(learnerId: string, statuses: ActivityStatus[] = ['pending_review', 'ready']): PlannedActivity[] {
  const placeholders = statuses.map(() => '?').join(',');
  return all<PlannedActivity>(
    `SELECT * FROM planned_activity
      WHERE learner_id = ? AND status IN (${placeholders})
      ORDER BY position, created_at`,
    learnerId,
    ...statuses,
  );
}

/** How many activities are actually approved and waiting. Drives the scheduler. */
export function readyCount(learnerId: string): number {
  return (
    one<{ n: number }>(
      `SELECT count(*) AS n FROM planned_activity WHERE learner_id = ? AND status = 'ready'`,
      learnerId,
    )?.n ?? 0
  );
}

export function pendingReview(learnerId?: string): PlannedActivity[] {
  return learnerId
    ? all<PlannedActivity>(
        `SELECT * FROM planned_activity WHERE learner_id = ? AND status = 'pending_review'
          ORDER BY created_at`,
        learnerId,
      )
    : all<PlannedActivity>(
        `SELECT * FROM planned_activity WHERE status = 'pending_review' ORDER BY created_at`,
      );
}

export function approve(activityId: string, by = 'parent', note?: string): PlannedActivity | undefined {
  run(
    `UPDATE planned_activity
        SET status = 'ready', reviewed_by = ?, reviewed_at = ?, review_note = coalesce(?, review_note)
      WHERE id = ? AND status = 'pending_review'`,
    by,
    now(),
    note ?? null,
    activityId,
  );
  logEvent(by, 'approve_activity', activityId, { note });
  return getActivity(activityId);
}

export function reject(activityId: string, by = 'parent', note?: string): PlannedActivity | undefined {
  run(
    `UPDATE planned_activity
        SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, review_note = coalesce(?, review_note)
      WHERE id = ?`,
    by,
    now(),
    note ?? null,
    activityId,
  );
  // A rejection is a teaching signal about the tutor, not the child. The note is
  // read back into the next planning run so the same mistake is not repeated.
  logEvent(by, 'reject_activity', activityId, { note });
  return getActivity(activityId);
}

/**
 * Put back anything that was opened but never finished.
 *
 * A child who opens an activity and wanders off should find it again, not lose it.
 * Only touches activities that produced no evidence at all — if they did some of it,
 * the record has that and there is no point making them redo it.
 */
export function restoreAbandoned(learnerId: string, olderThanHours = 0.5): number {
  const abandoned = all<{ id: string }>(
    `SELECT a.id FROM planned_activity a
      WHERE a.learner_id = ? AND a.status = 'delivered'
        AND a.delivered_at < datetime('now', ?)
        AND NOT EXISTS (SELECT 1 FROM observation o WHERE o.source = a.interface_id)`,
    learnerId,
    `-${olderThanHours} hours`,
  );
  for (const row of abandoned) {
    run(`UPDATE planned_activity SET status = 'ready', delivered_at = NULL WHERE id = ?`, row.id);
  }
  if (abandoned.length) logEvent('cli', 'restore_abandoned', learnerId, { count: abandoned.length });
  return abandoned.length;
}

/**
 * What the child's app should open: whatever they are in the middle of, otherwise
 * the next approved thing.
 *
 * A child who closes the app and comes back must find their activity again. Serving
 * only `ready` items means the moment one is handed over it vanishes — close the tab,
 * reopen, and you are told there is nothing for you while the thing you were doing
 * sits marked "delivered" forever.
 */
export function nextReady(learnerId: string, resumeWithinHours = 12): PlannedActivity | undefined {
  const inProgress = one<PlannedActivity>(
    `SELECT * FROM planned_activity
      WHERE learner_id = ? AND status = 'delivered'
        AND delivered_at > datetime('now', ?)
      ORDER BY delivered_at DESC LIMIT 1`,
    learnerId,
    `-${resumeWithinHours} hours`,
  );
  if (inProgress) return inProgress;

  return one<PlannedActivity>(
    `SELECT * FROM planned_activity WHERE learner_id = ? AND status = 'ready'
      ORDER BY position, created_at LIMIT 1`,
    learnerId,
  );
}

export function markDelivered(activityId: string): void {
  run(
    `UPDATE planned_activity SET status = 'delivered', delivered_at = ?
      WHERE id = ? AND status = 'ready'`,
    now(),
    activityId,
  );
}

export function markDone(activityId: string): void {
  run(
    `UPDATE planned_activity SET status = 'done', completed_at = ?
      WHERE id = ? AND status IN ('delivered', 'ready')`,
    now(),
    activityId,
  );
}

/** Close out whatever was delivered from a given interface. */
export function completeByInterface(interfaceId: string): void {
  run(
    `UPDATE planned_activity SET status = 'done', completed_at = ?
      WHERE interface_id = ? AND status IN ('delivered', 'ready')`,
    now(),
    interfaceId,
  );
}

/**
 * Recent rejections and review notes, for the tutor to read before planning again.
 * Feedback the adult gave is worthless if the next run does not see it.
 */
export function recentReviewFeedback(learnerId: string, limit = 8) {
  return all<{ title: string; status: string; review_note: string | null; reviewed_at: string | null }>(
    `SELECT title, status, review_note, reviewed_at FROM planned_activity
      WHERE learner_id = ? AND review_note IS NOT NULL
      ORDER BY reviewed_at DESC LIMIT ?`,
    learnerId,
    limit,
  );
}

export function describe(a: PlannedActivity) {
  return {
    id: a.id,
    title: a.title,
    status: a.status,
    rationale: a.rationale,
    interface_id: a.interface_id,
    target_skills: parseJson<string[]>(a.target_skills, []),
    created_at: a.created_at,
    review_note: a.review_note,
  };
}
