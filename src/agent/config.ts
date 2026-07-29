import { all, one, run, now, logEvent } from '../db/index.ts';

export interface Settings {
  review_required: boolean;
  daily_budget_usd: number;
  monthly_budget_usd: number;
  queue_target: number;
  model: string;
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  min_hours_between_runs: number;
  /** Off unless an adult turns it on. Recording a child is never a default. */
  audio_capture: boolean;
  /** 0 keeps recordings forever. Anything else prunes on a schedule. */
  artifact_retention_days: number;
}

const DEFAULTS: Settings = {
  review_required: true,
  daily_budget_usd: 1.0,
  monthly_budget_usd: 15.0,
  queue_target: 3,
  model: 'claude-opus-5',
  effort: 'high',
  min_hours_between_runs: 4,
  audio_capture: false,
  artifact_retention_days: 0,
};

export function settings(): Settings {
  const rows = all<{ key: string; value: string }>(`SELECT key, value FROM setting`);
  const raw = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const num = (k: keyof Settings, d: number) =>
    raw[k] !== undefined && raw[k] !== '' && !Number.isNaN(Number(raw[k])) ? Number(raw[k]) : d;

  return {
    review_required: raw['review_required'] !== undefined
      ? raw['review_required'] === 'true'
      : DEFAULTS.review_required,
    daily_budget_usd: num('daily_budget_usd', DEFAULTS.daily_budget_usd),
    monthly_budget_usd: num('monthly_budget_usd', DEFAULTS.monthly_budget_usd),
    queue_target: num('queue_target', DEFAULTS.queue_target),
    model: process.env.PRIMER_MODEL || raw['model'] || DEFAULTS.model,
    effort: (process.env.PRIMER_EFFORT || raw['effort'] || DEFAULTS.effort) as Settings['effort'],
    min_hours_between_runs: num('min_hours_between_runs', DEFAULTS.min_hours_between_runs),
    audio_capture: raw['audio_capture'] === 'true',
    artifact_retention_days: num('artifact_retention_days', DEFAULTS.artifact_retention_days),
  };
}

export function setSetting(key: keyof Settings, value: string, by = 'cli'): void {
  run(
    `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key,
    value,
    now(),
    by,
  );
  // Turning off the review gate is exactly the kind of change a parent should be
  // able to find later, so every setting change lands in the audit log.
  logEvent(by, 'set_setting', key, { value });
}

/**
 * What the child's own device turned out to be capable of.
 *
 * Browsers only hand out the microphone and service workers in a secure context —
 * HTTPS or localhost. A tablet on `http://192.168.x.x` is neither, so recording is
 * not merely off, it is unavailable, and the API for it does not exist to be
 * called. Storing what the device reported lets the parent page say so plainly.
 */
export function setDeviceCapabilities(
  learnerId: string,
  capabilities: Record<string, unknown>,
  note?: string,
): void {
  run(
    `INSERT INTO setting (key, value, updated_at, updated_by) VALUES (?, ?, ?, 'device')
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    `device_caps:${learnerId}`,
    JSON.stringify({ ...capabilities, note, seen_at: now() }),
    now(),
  );
}

export function deviceCapabilities(learnerId: string): Record<string, unknown> | null {
  const row = one<{ value: string }>(
    `SELECT value FROM setting WHERE key = ?`,
    `device_caps:${learnerId}`,
  );
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ cost -- */

/** USD per million tokens. Cache reads are ~0.1x input; writes ~1.25x. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
}

export function costOf(model: string, usage: TokenUsage): number {
  const price = PRICING[model] ?? PRICING['claude-opus-5']!;
  const dollars =
    (usage.input_tokens * price.input +
      usage.cache_read_tokens * price.input * 0.1 +
      usage.cache_write_tokens * price.input * 1.25 +
      usage.output_tokens * price.output) /
    1_000_000;
  return Number(dollars.toFixed(6));
}

export interface BudgetState {
  spent_today: number;
  spent_this_month: number;
  daily_budget: number;
  monthly_budget: number;
  remaining_today: number;
  remaining_this_month: number;
  exhausted: boolean;
}

/**
 * A tutor that runs on its own, forever, needs a hard ceiling that a parent sets
 * once and never thinks about again. Checked before every run and after every
 * turn — not just at the start, because a single long run can overshoot.
 */
export function budget(): BudgetState {
  const s = settings();
  const day = one<{ spent: number | null }>(
    `SELECT sum(cost_usd) AS spent FROM agent_run WHERE started_at > datetime('now', '-1 day')`,
  );
  const month = one<{ spent: number | null }>(
    `SELECT sum(cost_usd) AS spent FROM agent_run WHERE started_at > datetime('now', '-30 days')`,
  );
  const spentToday = Number((day?.spent ?? 0).toFixed(4));
  const spentMonth = Number((month?.spent ?? 0).toFixed(4));
  const remainingToday = Number((s.daily_budget_usd - spentToday).toFixed(4));
  const remainingMonth = Number((s.monthly_budget_usd - spentMonth).toFixed(4));

  return {
    spent_today: spentToday,
    spent_this_month: spentMonth,
    daily_budget: s.daily_budget_usd,
    monthly_budget: s.monthly_budget_usd,
    remaining_today: remainingToday,
    remaining_this_month: remainingMonth,
    exhausted: remainingToday <= 0 || remainingMonth <= 0,
  };
}
