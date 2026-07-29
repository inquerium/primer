import { all, one, run, id, now, logEvent } from '../db/index.ts';
import { resolveLearner } from '../record/learners.ts';
import { readyCount } from '../record/queue.ts';
import { AUTONOMOUS_PROMPT } from './prompt.ts';
import { settings, budget, costOf, type TokenUsage } from './config.ts';
import { runClaudeCode } from './claude-code.ts';

const MAX_TURNS = 30;

export interface RunOptions {
  trigger?: 'session_ended' | 'scheduled' | 'manual' | 'backlog_empty';
  /** Port the spawned MCP server's surface should use. */
  surfacePort?: number;
  /** Dollar ceiling for this single run. Defaults to what is left today. */
  maxBudgetUsd?: number;
  dryRun?: boolean;
  signal?: AbortSignal;
}

export interface RunResult {
  run_id: string;
  status: 'ok' | 'error' | 'skipped' | 'over_budget';
  summary: string;
  activities_planned: number;
  cost_usd: number;
  turns: number;
  usage: TokenUsage;
}

function emptyUsage(): TokenUsage {
  return { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0 };
}

/**
 * One autonomous planning cycle for one child.
 *
 * The child is never in this loop. This wakes Claude Code, hands it the record
 * through primer's MCP server, and lets it read, decide, build, and queue. What
 * it cost is written down before this returns, because a system that runs
 * unattended for years has to be answerable for any given day.
 */
export async function runTutor(learnerRef: string, opts: RunOptions = {}): Promise<RunResult> {
  const learner = resolveLearner(learnerRef);
  const config = settings();
  const trigger = opts.trigger ?? 'manual';
  const runId = id('run');
  let usage = emptyUsage();

  const finish = (
    status: RunResult['status'],
    summary: string,
    extra: { turns?: number; activities?: number; error?: string; cost?: number } = {},
  ): RunResult => {
    const cost = Number((extra.cost ?? 0).toFixed(6));
    run(
      `UPDATE agent_run SET ended_at = ?, status = ?, summary = ?, error = ?, turns = ?,
              activities = ?, input_tokens = ?, output_tokens = ?,
              cache_read_tokens = ?, cache_write_tokens = ?, cost_usd = ?
        WHERE id = ?`,
      now(),
      status,
      summary,
      extra.error ?? null,
      extra.turns ?? 0,
      extra.activities ?? 0,
      usage.input_tokens,
      usage.output_tokens,
      usage.cache_read_tokens,
      usage.cache_write_tokens,
      cost,
      runId,
    );
    return {
      run_id: runId,
      status,
      summary,
      activities_planned: extra.activities ?? 0,
      cost_usd: cost,
      turns: extra.turns ?? 0,
      usage,
    };
  };

  run(
    `INSERT INTO agent_run (id, learner_id, trigger, started_at, status, model)
     VALUES (?, ?, ?, ?, 'running', ?)`,
    runId,
    learner.id,
    trigger,
    now(),
    config.model,
  );
  logEvent('tutor:claude', 'agent_run_start', runId, { learner: learner.id, trigger });

  const spend = budget();
  if (spend.exhausted) {
    return finish(
      'over_budget',
      `Budget reached: $${spend.spent_today.toFixed(2)} today of $${spend.daily_budget.toFixed(2)}, ` +
        `$${spend.spent_this_month.toFixed(2)} this month of $${spend.monthly_budget.toFixed(2)}. No run.`,
    );
  }

  const waiting = readyCount(learner.id);
  if (waiting >= config.queue_target && trigger !== 'manual') {
    return finish('skipped', `${waiting} activities already approved and waiting. Nothing to do.`);
  }

  if (opts.dryRun) {
    return finish('skipped', `Dry run. Would plan for ${learner.display_name}.`);
  }

  const before = countActivities(learner.id);
  const ceiling = Math.max(
    0.05,
    opts.maxBudgetUsd ?? Math.min(spend.remaining_today, spend.remaining_this_month),
  );

  const result = await runClaudeCode({
    systemPrompt: AUTONOMOUS_PROMPT,
    prompt:
      `Plan the next session for ${learner.display_name}.\n\n` +
      `Their learner id is ${learner.id} — pass it as the "learner" argument to every primer tool.\n` +
      `Trigger: ${trigger}. Activities already approved and waiting: ${waiting}.\n\n` +
      `Start with learner_context and queue_status.`,
    model: config.model,
    effort: config.effort,
    maxBudgetUsd: ceiling,
    maxTurns: MAX_TURNS,
    surfacePort: opts.surfacePort,
    signal: opts.signal,
  });

  usage = result.usage;
  const planned = countActivities(learner.id) - before;

  // On a Claude Code subscription there is no marginal charge, so the reported
  // cost is zero. Fall back to a token estimate so the daily ceiling still works
  // as a usage guardrail rather than silently never triggering.
  const cost =
    result.cost_usd > 0 ? result.cost_usd : costOf(config.model, result.usage);

  if (!result.ok) {
    return finish('error', result.text, {
      turns: result.turns,
      activities: planned,
      error: result.failure ?? 'error',
      cost,
    });
  }

  if (result.denials?.length) {
    // A denial means the tutor reached for something outside its allowlist. Worth
    // seeing rather than silently swallowing — it is either a prompt problem or a
    // sign the allowlist is too tight for the job.
    logEvent('tutor:claude', 'tool_denied', runId, result.denials);
  }

  logEvent('tutor:claude', 'agent_run_end', runId, { planned, turns: result.turns });
  return finish('ok', result.text || `${planned} activities queued.`, {
    turns: result.turns,
    activities: planned,
    cost,
  });
}

function countActivities(learnerId: string): number {
  return (
    one<{ n: number }>(
      `SELECT count(*) AS n FROM planned_activity WHERE learner_id = ?`,
      learnerId,
    )?.n ?? 0
  );
}

export function recentRuns(learnerId?: string, limit = 15) {
  return learnerId
    ? all(
        `SELECT * FROM agent_run WHERE learner_id = ? ORDER BY started_at DESC LIMIT ?`,
        learnerId,
        limit,
      )
    : all(`SELECT * FROM agent_run ORDER BY started_at DESC LIMIT ?`, limit);
}
