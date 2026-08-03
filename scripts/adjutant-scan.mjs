#!/usr/bin/env node
/**
 * Read what the corps did, name the shape of each deliverable, and say what a
 * person actually has to look at.
 *
 *   node scripts/adjutant-scan.mjs               last 24 hours, human readable
 *   node scripts/adjutant-scan.mjs --json        the same, for the watcher
 *   node scripts/adjutant-scan.mjs --hours 168   a week
 *
 * The adjutant's watcher calls this through `exec` rather than classifying
 * inline. Watcher scripts cannot import, and a second copy of the shape gate
 * would drift from automation/deliverable.mjs within a month. One source of
 * truth, reached over a process boundary, is worth the process boundary.
 *
 * This reads run history and nothing else. It cannot start a run, edit a job,
 * or touch the repository.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { classify, ESCALATABLE, ESCALATION } from '../automation/deliverable.mjs';
import { CORPS } from '../automation/corps.mjs';

const run = promisify(execFile);
const PATH = [
  '/opt/homebrew/opt/node@24/bin',
  join(process.env.HOME ?? '', '.npm-global/bin'),
  process.env.PATH ?? '',
].join(':');

const oc = async (args) =>
  (await run('openclaw', args, { env: { ...process.env, PATH }, maxBuffer: 64 * 1024 * 1024 })).stdout;

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const hours = Number(argv[argv.indexOf('--hours') + 1]) || 24;

/**
 * `cron runs` prints JSON without needing a flag, and prints one object per
 * invocation. Parse defensively: a gateway that answers with anything else is
 * a breakage the watcher needs to see, not an exception that kills the scan.
 */
function parseRuns(stdout) {
  try {
    const parsed = JSON.parse(stdout);
    return Array.isArray(parsed?.entries) ? parsed.entries : [];
  } catch {
    return null;
  }
}

const KNOWN = new Set(CORPS.map((a) => a.id));

async function scan() {
  const since = Date.now() - hours * 3600_000;
  const jobsOut = await oc(['cron', 'list', '--json']);
  const jobs = JSON.parse(jobsOut).jobs ?? [];

  const rows = [];
  const broken = [];

  for (const job of jobs) {
    // Other people's jobs live on this gateway too. The adjutant reports on the
    // corps and stays out of everything else.
    if (!KNOWN.has(job.agentId)) continue;

    const entries = parseRuns(await oc(['cron', 'runs', '--id', job.id, '--limit', '50']).catch(() => ''));
    if (entries === null) {
      broken.push({ jobId: job.id, name: job.name, why: 'run history did not parse' });
      continue;
    }

    for (const e of entries) {
      if (e.action !== 'finished' || e.ts < since) continue;
      const verdict = classify(e.summary, e);
      rows.push({
        ts: e.ts,
        at: new Date(e.ts).toISOString(),
        jobId: job.id,
        job: job.name,
        agentId: job.agentId,
        status: e.status,
        durationMs: e.durationMs ?? null,
        outputTokens: e.usage?.output_tokens ?? null,
        shape: verdict.shape,
        escalates: verdict.escalates,
        why: verdict.reasons[0] ?? null,
        excerpt: String(e.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 400),
      });
    }
  }

  rows.sort((a, b) => b.ts - a.ts);

  const counts = {};
  for (const r of rows) counts[r.shape] = (counts[r.shape] ?? 0) + 1;

  // What a person must look at. Everything else is the adjutant's problem.
  const forHuman = rows.filter((r) => ESCALATABLE.has(r.shape));
  const alarms = rows.filter((r) => r.shape === 'alarm');

  // Per-lane conduct. A lane is judged on the runs that answered; a lane whose
  // runs are not completing has a machine problem and no conduct to assess.
  const byAgent = new Map();
  for (const r of rows) {
    const row = byAgent.get(r.agentId) ?? { agentId: r.agentId, runs: 0, failed: 0, escalated: 0, malformed: 0 };
    row.runs += 1;
    if (r.shape === 'failed') row.failed += 1;
    if (ESCALATION.has(r.shape)) row.escalated += 1;
    if (r.shape === 'malformed') row.malformed += 1;
    byAgent.set(r.agentId, row);
  }
  const lanes = [...byAgent.values()].map((r) => {
    const answered = r.runs - r.failed;
    const failure_rate = Number((r.failed / r.runs).toFixed(2));
    const escalation_rate = answered ? Number((r.escalated / answered).toFixed(2)) : 0;
    const malformed_rate = answered ? Number((r.malformed / answered).toFixed(2)) : 0;
    return {
      ...r,
      answered,
      failure_rate,
      escalation_rate,
      malformed_rate,
      verdict:
        failure_rate > 0.3
          ? 'the runs are not completing; this is the machine, not the lane'
          : escalation_rate > 0.33
            ? 'the task is too big or the capability is missing'
            : malformed_rate > 0.2
              ? 'the charter is not landing; the lane keeps asking instead of acting'
              : 'healthy',
    };
  });

  return {
    window_hours: hours,
    since: new Date(since).toISOString(),
    total: rows.length,
    counts,
    alarms: alarms.length,
    for_human: forHuman.length,
    unhealthy_lanes: lanes.filter((l) => l.verdict !== 'healthy'),
    lanes,
    escalations: forHuman,
    broken,
    rows,
  };
}

const result = await scan();

if (asJson) {
  console.log(JSON.stringify(result));
} else {
  const { counts, lanes, escalations, broken, total, window_hours } = result;
  console.log(`\n  last ${window_hours}h: ${total} finished runs`);
  console.log(`  ${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join('  ') || 'nothing ran'}\n`);

  if (broken.length) {
    for (const b of broken) console.log(`  BROKEN  ${b.name}: ${b.why}`);
    console.log('');
  }

  for (const l of lanes) {
    const flag = l.verdict === 'healthy' ? '   ' : ' ! ';
    console.log(
      `${flag} ${l.agentId.padEnd(22)} ${String(l.runs).padStart(3)} runs  ` +
        `fail ${l.failure_rate}  esc ${l.escalation_rate}  malformed ${l.malformed_rate}`,
    );
    if (l.verdict !== 'healthy') console.log(`      ${l.verdict}`);
  }

  if (escalations.length) {
    console.log(`\n  for you (${escalations.length}):\n`);
    for (const e of escalations) {
      console.log(`  ${e.shape.toUpperCase()}  ${e.agentId}  ${e.at.slice(0, 16)}`);
      console.log(`    ${e.excerpt.slice(0, 200)}\n`);
    }
  } else {
    console.log('\n  nothing needs you.\n');
  }
}
