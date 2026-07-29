import { one } from '../db/index.ts';
import { listLearners } from '../record/learners.ts';
import { readyCount } from '../record/queue.ts';
import { settings, budget } from './config.ts';
import { runTutor, type RunOptions, type RunResult } from './tutor.ts';

export type Trigger = NonNullable<RunOptions['trigger']>;

export interface Decision {
  learner_id: string;
  name: string;
  trigger: Trigger | null;
  reason: string;
}

/**
 * Should the tutor wake up for this child?
 *
 * Deliberately conservative. The failure mode of an always-on tutor is not that
 * it runs too rarely — it is that it burns money generating a backlog nobody
 * opens. Every branch here is a reason to run; the default is not to.
 */
export function decide(learnerId: string, at = new Date()): Decision {
  const config = settings();
  const learner = one<{ display_name: string }>(
    `SELECT display_name FROM learner WHERE id = ?`,
    learnerId,
  );
  const name = learner?.display_name ?? learnerId;
  const no = (reason: string): Decision => ({ learner_id: learnerId, name, trigger: null, reason });

  const last = one<{ started_at: string; status: string }>(
    `SELECT started_at, status FROM agent_run WHERE learner_id = ?
      ORDER BY started_at DESC LIMIT 1`,
    learnerId,
  );
  if (last) {
    const hours = (at.getTime() - new Date(last.started_at).getTime()) / 3_600_000;
    if (hours < config.min_hours_between_runs) {
      return no(`last run ${hours.toFixed(1)}h ago, minimum is ${config.min_hours_between_runs}h`);
    }
  }

  const ready = readyCount(learnerId);
  if (ready >= config.queue_target) {
    return no(`${ready} activities already waiting (target ${config.queue_target})`);
  }

  // A session that ended after the last planning run is the strongest signal
  // there is: something just happened that the plan should account for.
  const session = one<{ ended_at: string }>(
    `SELECT ended_at FROM session
      WHERE learner_id = ? AND ended_at IS NOT NULL
      ORDER BY ended_at DESC LIMIT 1`,
    learnerId,
  );
  if (session && (!last || new Date(session.ended_at) > new Date(last.started_at))) {
    return { learner_id: learnerId, name, trigger: 'session_ended', reason: 'a session ended since the last run' };
  }

  if (ready === 0) {
    return { learner_id: learnerId, name, trigger: 'backlog_empty', reason: 'nothing is waiting for them' };
  }

  return no(`${ready} waiting, nothing new since the last run`);
}

export interface TickResult {
  checked: number;
  ran: RunResult[];
  skipped: Decision[];
  budget_exhausted: boolean;
}

/** One pass over every learner. Safe to call as often as you like. */
export async function tick(opts: { surfacePort?: number } = {}): Promise<TickResult> {
  const learners = listLearners();
  const ran: RunResult[] = [];
  const skipped: Decision[] = [];

  for (const learner of learners) {
    if (budget().exhausted) {
      return { checked: learners.length, ran, skipped, budget_exhausted: true };
    }
    const decision = decide(learner.id);
    if (!decision.trigger) {
      skipped.push(decision);
      continue;
    }
    ran.push(
      await runTutor(learner.id, { trigger: decision.trigger, surfacePort: opts.surfacePort }),
    );
  }

  return { checked: learners.length, ran, skipped, budget_exhausted: false };
}

export interface WatchHandle {
  stop: () => void;
}

/**
 * Run `tick` forever. This is the whole daemon.
 *
 * Interval is a floor, not a promise — `decide` still gates every child, so a
 * fast interval mostly produces cheap no-ops rather than spend.
 */
export function watch(
  opts: { intervalMinutes?: number; surfacePort?: number; onTick?: (r: TickResult) => void } = {},
): WatchHandle {
  const interval = Math.max(1, opts.intervalMinutes ?? 30) * 60_000;
  let running = false;
  let stopped = false;

  const pass = async () => {
    if (running || stopped) return;
    running = true;
    try {
      const result = await tick({ surfacePort: opts.surfacePort });
      opts.onTick?.(result);
    } catch (err) {
      process.stderr.write(`primer: tick failed — ${(err as Error).message}\n`);
    } finally {
      running = false;
    }
  };

  void pass();
  const timer = setInterval(() => void pass(), interval);
  timer.unref?.();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
