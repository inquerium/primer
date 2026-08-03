#!/usr/bin/env node
/**
 * Reconcile the roster in automation/corps.mjs against the running gateway.
 *
 *   node scripts/corps.mjs doctor    preflight: can this pipeline run at all
 *   node scripts/corps.mjs status    what the roster wants vs what is running
 *   node scripts/corps.mjs apply     make the running jobs match, with a diff first
 *   node scripts/corps.mjs apply --yes   skip the confirmation
 *
 * What this does not do, on purpose: create agents, set tool policy, or touch
 * exec policy. Those grant authority, and authority is granted by a person at a
 * terminal who knows they are doing it. `status` prints the exact commands.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { CORPS, MAINTAINER, desiredJobsByName } from '../automation/corps.mjs';

const run = promisify(execFile);
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * OpenClaw refuses Node 23 and the npm global bin is often off PATH, which is
 * the first thing that stops this working on a fresh shell. Resolve it here so
 * nobody has to remember.
 */
const PATH = [
  '/opt/homebrew/opt/node@24/bin',
  join(process.env.HOME ?? '', '.npm-global/bin'),
  process.env.PATH ?? '',
].join(':');

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

async function oc(args, opts = {}) {
  const { stdout } = await run('openclaw', args, {
    env: { ...process.env, PATH },
    maxBuffer: 32 * 1024 * 1024,
    ...opts,
  });
  return stdout;
}

const DURATION = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
function everyMs(spec) {
  const m = /^(\d+)([smhd])$/.exec(spec);
  if (!m) throw new Error(`bad duration "${spec}"`);
  return Number(m[1]) * DURATION[m[2]];
}
const humanMs = (ms) => {
  for (const [unit, size] of [['d', 864e5], ['h', 36e5], ['m', 6e4]]) {
    if (ms % size === 0 && ms >= size) return `${ms / size}${unit}`;
  }
  return `${Math.round(ms / 1000)}s`;
};

/* ------------------------------------------------------------------ doctor -- */

async function doctor() {
  const checks = [];
  const ok = (name, detail) => checks.push({ state: 'ok', name, detail });
  const bad = (name, detail, fix) => checks.push({ state: 'bad', name, detail, fix });
  const warn = (name, detail, fix) => checks.push({ state: 'warn', name, detail, fix });

  try {
    const v = (await oc(['--version'])).trim();
    ok('openclaw', v);
  } catch (err) {
    bad('openclaw', String(err.message).split('\n')[0], 'npm install -g openclaw@latest');
    report(checks);
    return 1;
  }

  // gateway status exits 0 even when the port is dead, so probe the socket.
  const listening = await new Promise((res) => {
    import('node:net').then(({ createConnection }) => {
      const s = createConnection({ port: 18789, host: '127.0.0.1' })
        .on('connect', () => (s.destroy(), res(true)))
        .on('error', () => res(false));
      setTimeout(() => (s.destroy(), res(false)), 2000);
    });
  });
  listening
    ? ok('gateway', 'listening on 127.0.0.1:18789')
    : bad('gateway', 'not listening', 'openclaw gateway start');

  try {
    const cfg = JSON.parse(await oc(['config', 'get', 'cron', '--json']).catch(() => '{}'));
    const cron = cfg?.value ?? cfg ?? {};
    cron.enabled ? ok('cron.enabled', 'true') : bad('cron.enabled', 'false', "openclaw config set cron.enabled true --strict-json");
    cron?.triggers?.enabled
      ? ok('cron.triggers.enabled', 'true (watchers may run headlessly)')
      : bad('cron.triggers.enabled', 'false; watcher scripts will never fire',
          "openclaw config set cron.triggers.enabled true --strict-json");
    cron?.failureDestination
      ? ok('cron.failureDestination', JSON.stringify(cron.failureDestination))
      : warn('cron.failureDestination', 'unset; failed runs alert nobody',
          `openclaw config set cron.failureDestination '${JSON.stringify(MAINTAINER)}' --strict-json`);
  } catch {
    warn('cron config', 'could not read', 'openclaw config get cron');
  }

  // Every engineering lane works against the corpus. No corpus, no lane.
  existsSync(join(REPO, 'test/fixtures/personas.ts'))
    ? ok('fixtures', 'test/fixtures/personas.ts present')
    : bad('fixtures', 'missing; every engineering lane has nothing to work against',
        'see docs/CORPS.md, stand-up step 1');

  try {
    await run('gh', ['auth', 'status'], { env: { ...process.env, PATH } });
    ok('gh', 'authenticated');
  } catch {
    bad('gh', 'not authenticated; no lane can open a pull request', 'gh auth login');
  }

  const missingScripts = [];
  for (const agent of CORPS) {
    for (const job of agent.jobs) {
      if (job.triggerScript && !existsSync(join(REPO, job.triggerScript))) {
        missingScripts.push(`${job.name} -> ${job.triggerScript}`);
      }
    }
  }
  missingScripts.length
    ? bad('watcher scripts', missingScripts.join(', '), 'write them, or empty that lane\'s jobs[]')
    : ok('watcher scripts', 'all roster trigger scripts exist');

  return report(checks);
}

function report(checks) {
  console.log(c.bold('\npreflight\n'));
  for (const ch of checks) {
    const mark = ch.state === 'ok' ? c.green('ok  ') : ch.state === 'warn' ? c.yellow('warn') : c.red('FAIL');
    console.log(`  ${mark}  ${ch.name.padEnd(26)} ${c.dim(ch.detail)}`);
    if (ch.fix && ch.state !== 'ok') console.log(`        ${c.dim('fix:')} ${ch.fix}`);
  }
  const failed = checks.filter((ch) => ch.state === 'bad').length;
  console.log(failed ? c.red(`\n${failed} blocking\n`) : c.green('\nready\n'));
  return failed ? 1 : 0;
}

/* ------------------------------------------------------------------ status -- */

async function liveJobs() {
  const parsed = JSON.parse(await oc(['cron', 'list', '--json']));
  return parsed.jobs ?? [];
}

async function liveAgents() {
  const out = await oc(['agents', 'list']);
  return new Set([...out.matchAll(/^- (\S+)/gm)].map((m) => m[1]));
}

/** What differs between what the roster wants and what is registered. */
function diffJob(want, live) {
  const drift = [];
  if (live.agentId !== want.agentId) drift.push(`agent ${live.agentId} -> ${want.agentId}`);
  const wantMs = everyMs(want.every);
  if (live.schedule?.everyMs !== wantMs) {
    drift.push(`every ${humanMs(live.schedule?.everyMs ?? 0)} -> ${want.every}`);
  }
  const liveTimeout = live.timeoutSeconds ?? null;
  if (liveTimeout !== want.timeoutSeconds) {
    drift.push(`timeout ${liveTimeout ?? 'none'} -> ${want.timeoutSeconds}s`);
  }
  const announces = live.delivery?.mode === 'announce';
  if (announces !== Boolean(want.announce)) {
    drift.push(
      want.announce
        ? 'does not announce -> should'
        : `announces to ${live.delivery?.channel}:${live.delivery?.to} -> should not (only the adjutant announces)`,
    );
  }
  return drift;
}

async function status() {
  const want = desiredJobsByName();
  const live = await liveJobs();
  const liveByName = new Map(live.map((j) => [j.name, j]));
  const agents = await liveAgents();

  console.log(c.bold('\nagents\n'));
  const missingAgents = [];
  for (const a of [...CORPS].sort((x, y) => x.standUp - y.standUp)) {
    const there = agents.has(a.id);
    if (!there) missingAgents.push(a);
    const mark = there ? c.green('ok  ') : a.jobs.length ? c.red('FAIL') : c.dim('  - ');
    const when = a.standUp === 0 ? 'running' : `stand-up ${a.standUp}`;
    console.log(`  ${mark}  ${a.id.padEnd(23)} ${c.dim(a.agentClass.padEnd(12) + when)}`);
  }

  console.log(c.bold('\njobs\n'));
  let drifted = 0;
  let missing = 0;
  for (const [name, w] of want) {
    const l = liveByName.get(name);
    if (!l) {
      missing++;
      console.log(`  ${c.yellow('add ')}  ${name.padEnd(30)} ${c.dim(`${w.agentId} every ${w.every}`)}`);
      continue;
    }
    const drift = diffJob(w, l);
    if (!drift.length) {
      console.log(`  ${c.green('ok  ')}  ${name.padEnd(30)} ${c.dim(l.id.slice(0, 8))}`);
    } else {
      drifted++;
      console.log(`  ${c.yellow('edit')}  ${name.padEnd(30)} ${c.dim(l.id.slice(0, 8))}`);
      for (const d of drift) console.log(`        ${c.yellow(d)}`);
    }
  }

  const unmanaged = live.filter((j) => !want.has(j.name) && CORPS.some((a) => a.id === j.agentId));
  if (unmanaged.length) {
    console.log(c.bold('\nrunning but not in the roster\n'));
    for (const j of unmanaged) {
      console.log(`  ${c.yellow('????')}  ${j.name.padEnd(30)} ${c.dim(`${j.agentId} ${j.id.slice(0, 8)}`)}`);
    }
    console.log(c.dim('\n  Add them to automation/corps.mjs or remove them. A job nobody declared'));
    console.log(c.dim('  is a job nobody reviews.'));
  }

  if (missingAgents.length) {
    console.log(c.bold('\noperator commands\n'));
    console.log(c.dim('  Creating agents and setting tool policy grant authority, so they are'));
    console.log(c.dim('  not something this script does for you. Run these yourself:\n'));
    for (const a of missingAgents) {
      console.log(`  openclaw agents add ${a.id} --workspace ${REPO} --non-interactive`);
    }
    console.log(c.dim('\n  Then set each deny-list in ~/.openclaw/openclaw.json under agents.list.'));
    console.log(c.dim('  Per-agent allow-lists resolve to zero callable tools on this version;'));
    console.log(c.dim('  express every restriction as a deny-list.\n'));
    for (const a of missingAgents) {
      console.log(`  ${a.id.padEnd(23)} deny: ${JSON.stringify(a.deny)}`);
    }
  }

  console.log('');
  console.log(
    `  ${missing} to add, ${drifted} drifted, ${unmanaged.length} undeclared, ${missingAgents.length} agents missing`,
  );
  console.log('');
  return missing + drifted ? 1 : 0;
}

/* ------------------------------------------------------------------- apply -- */

async function apply(argv) {
  const want = desiredJobsByName();
  const live = await liveJobs();
  const liveByName = new Map(live.map((j) => [j.name, j]));
  const agents = await liveAgents();

  const plan = [];
  for (const [name, w] of want) {
    if (!agents.has(w.agentId)) {
      console.log(c.red(`  skip  ${name}: agent "${w.agentId}" does not exist yet`));
      continue;
    }
    const l = liveByName.get(name);
    if (!l) plan.push({ kind: 'add', want: w });
    else {
      const drift = diffJob(w, l);
      if (drift.length) plan.push({ kind: 'edit', want: w, live: l, drift });
    }
  }

  if (!plan.length) {
    console.log(c.green('\n  nothing to do; the gateway matches the roster\n'));
    return 0;
  }

  console.log(c.bold('\nplan\n'));
  for (const step of plan) {
    console.log(`  ${step.kind === 'add' ? c.yellow('add ') : c.yellow('edit')}  ${step.want.name}`);
    for (const d of step.drift ?? []) console.log(`        ${c.dim(d)}`);
  }
  console.log('');

  if (!argv.includes('--yes')) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question('  apply? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (answer !== 'y' && answer !== 'yes') {
      console.log(c.dim('\n  nothing changed\n'));
      return 0;
    }
  }

  for (const step of plan) {
    const w = step.want;
    const args =
      step.kind === 'add'
        ? ['cron', 'add', '--name', w.name, '--agent', w.agentId, '--every', w.every,
           '--session', 'isolated', '--declaration-key', `corps:${w.name}`]
        : ['cron', 'edit', step.live.id];

    args.push('--tools', w.tools.join(','), '--timeout-seconds', String(w.timeoutSeconds));
    if (w.triggerScript) args.push('--trigger-script', join(REPO, w.triggerScript));
    if (w.message) args.push('--message', w.message);
    // Only the adjutant announces. Everything else returns its deliverable to the
    // run record and lets the adjutant decide whether a person sees it.
    if (w.announce) args.push('--announce', '--channel', MAINTAINER.channel, '--to', MAINTAINER.to);

    try {
      await oc(args);
      console.log(`  ${c.green('done')}  ${step.kind} ${w.name}`);
    } catch (err) {
      console.log(`  ${c.red('FAIL')}  ${step.kind} ${w.name}: ${String(err.message).split('\n')[0]}`);
    }
  }

  console.log(c.dim('\n  Editing a job does not re-run it. Verify with:'));
  console.log(c.dim('    openclaw cron list\n'));
  return 0;
}

/* -------------------------------------------------------------------- main -- */

const [, , command = 'status', ...argv] = process.argv;
const commands = { doctor, status, apply: () => apply(argv) };

if (!commands[command]) {
  console.error(`usage: corps.mjs [doctor|status|apply] [--yes]`);
  process.exit(2);
}
process.exit((await commands[command]()) ?? 0);
