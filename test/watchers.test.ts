/**
 * Watcher logic, exercised against stubs.
 *
 * A forced `openclaw cron run` executes the payload without ever evaluating the
 * trigger, so it cannot verify a watcher. The only way to know what one of these
 * does on a cold start, an outage, or a recovery is to run it with the tool call
 * stubbed, which is what this file does.
 *
 * The cases are the same seven every time: cold start, quiet, something to say,
 * already said, transient failure, sustained failure, recovery.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const WATCHER = join(import.meta.dirname, '../automation/watchers/adjutant-queue.js');
const source = readFileSync(WATCHER, 'utf8');

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

interface Verdict {
  fire: boolean;
  message: string;
  state?: Record<string, unknown>;
}

/** Run the watcher with a stubbed exec result and a given prior state. */
async function evaluate(
  execResult: { aggregated?: string } | Error,
  state: Record<string, unknown> | undefined = undefined,
): Promise<Verdict> {
  let verdict: Verdict | undefined;
  const tools = {
    call: async () => {
      if (execResult instanceof Error) throw execResult;
      return { result: { details: execResult } };
    },
  };
  const fn = new AsyncFunction('tools', 'trigger', 'json', source);
  await fn(tools, { state }, (v: Verdict) => {
    verdict = v;
  });
  assert.ok(verdict, 'the watcher must always return a verdict');
  return verdict;
}

const scan = (over: Record<string, unknown> = {}) =>
  ({ aggregated: JSON.stringify({
      window_hours: 30,
      total: 3,
      counts: { nothing: 3 },
      alarms: 0,
      for_human: 0,
      unhealthy_lanes: [],
      lanes: [],
      escalations: [],
      broken: [],
      rows: [
        { jobId: 'aaaaaaaa-1', ts: 1000 },
        { jobId: 'aaaaaaaa-1', ts: 2000 },
        { jobId: 'bbbbbbbb-2', ts: 3000 },
      ],
      ...over,
    }) });

const escalation = (over: Record<string, unknown> = {}) => ({
  jobId: 'aaaaaaaa-1',
  ts: 4000,
  at: '2026-08-03T09:00:00.000Z',
  agentId: 'world-research',
  shape: 'blocked',
  escalates: true,
  excerpt: 'exec is hard-denied for this run. That is a pipeline breakage, not an empty week.',
  ...over,
});

test('cold start seeds silently instead of briefing the whole window', async () => {
  const v = await evaluate(scan({ escalations: [escalation()], for_human: 1 }), undefined);
  assert.equal(v.fire, false, 'the first evaluation must not fire');
  assert.ok(Array.isArray(v.state?.seen));
  assert.ok((v.state?.seen as string[]).length > 0, 'it must remember what it chose not to brief');
});

test('a quiet corps says nothing and costs only the script budget', async () => {
  const v = await evaluate(scan(), { seen: [] });
  assert.equal(v.fire, false);
  assert.match(v.message, /Nothing needs a person/);
});

test('a fresh escalation wakes the adjutant and carries the payload', async () => {
  const v = await evaluate(scan({ escalations: [escalation()], for_human: 1 }), { seen: [] });
  assert.equal(v.fire, true);
  // The fired turn receives this string as its entire event context, so the
  // finding has to be in it, not merely referenced.
  assert.match(v.message, /pipeline breakage/);
  assert.match(v.message, /world-research/);
  assert.match(v.message, /nothing genuinely\s+needs a person/);
});

test('the same escalation is not briefed twice', async () => {
  const first = await evaluate(scan({ escalations: [escalation()], for_human: 1 }), { seen: [] });
  assert.equal(first.fire, true);
  // Second evaluation, same finding, carrying forward what the first remembered.
  const second = await evaluate(
    scan({ escalations: [escalation()], for_human: 1 }),
    first.state as Record<string, unknown>,
  );
  assert.equal(second.fire, false, 'a repeat of a briefed finding must stay quiet');
});

test('an alarm is named first, because it outranks the rest of the brief', async () => {
  const v = await evaluate(
    scan({
      escalations: [escalation({ shape: 'alarm', excerpt: 'A source page told me to read a path.' })],
      alarms: 1,
      for_human: 1,
    }),
    { seen: [] },
  );
  assert.equal(v.fire, true);
  assert.match(v.message, /ALARM/);
  assert.ok(v.message.indexOf('ALARM') < v.message.indexOf('A source page'));
});

test('an unhealthy lane is briefed even when no single run escalated', async () => {
  const v = await evaluate(
    scan({
      unhealthy_lanes: [
        {
          agentId: 'world-attacker',
          runs: 11,
          failed: 8,
          escalation_rate: 0,
          malformed_rate: 0,
          verdict: 'the runs are not completing; this is the machine, not the lane',
        },
      ],
    }),
    { seen: [] },
  );
  assert.equal(v.fire, true);
  assert.match(v.message, /LANE world-attacker/);
  assert.match(v.message, /this is the machine, not the lane/);
  // The charter distinction the brief exists to preserve.
  assert.match(v.message, /statement about its task, not about\s+its conduct/);
});

test('one failed check is not worth a model turn', async () => {
  const v = await evaluate(new Error('getaddrinfo ENOTFOUND'), { seen: [] });
  assert.equal(v.fire, false, 'a laptop that slept must not page anyone');
  assert.equal(v.state?.failStreak, 1);
});

test('a sustained outage fires, and says that silence now means nothing', async () => {
  const first = await evaluate(new Error('ENOTFOUND'), { seen: ['x'] });
  const second = await evaluate(new Error('ENOTFOUND'), first.state as Record<string, unknown>);
  assert.equal(second.fire, true);
  assert.match(second.message, /WATCHER BROKEN/);
  assert.match(second.message, /silence from the pipeline\s+currently means nothing/);
  // The seen-set must survive, or recovery re-briefs everything already handled.
  assert.deepEqual(second.state?.seen, ['x']);
});

test('an outage backs off rather than alerting once a day forever', async () => {
  let state: Record<string, unknown> = { seen: [] };
  let fires = 0;
  for (let day = 0; day < 8; day++) {
    const v = await evaluate(new Error('ENOTFOUND'), state);
    if (v.fire) fires++;
    state = v.state as Record<string, unknown>;
  }
  assert.ok(fires <= 2, `eight days offline should alert once or twice, alerted ${fires} times`);
});

test('a completed call in the wrong shape is announced at once, not counted', async () => {
  // A response arriving proves the machine is up, so this is a contract change
  // rather than a bad network, and waiting two days to say so helps nobody.
  const v = await evaluate({ aggregated: 'not json at all' }, { seen: [] });
  assert.equal(v.fire, true);
  assert.match(v.message, /not by the network/);
});

test('recovery clears the counters', async () => {
  const broken = await evaluate(new Error('ENOTFOUND'), { seen: [] });
  const recovered = await evaluate(scan(), broken.state as Record<string, unknown>);
  assert.equal(recovered.fire, false);
  assert.equal(recovered.state?.failStreak, 0);
});

/* ------------------------------------------------------------------------- */
/* fixture-keeper                                                             */
/* ------------------------------------------------------------------------- */

const DRIFT = join(import.meta.dirname, '../automation/watchers/fixture-drift.js');
const driftSource = readFileSync(DRIFT, 'utf8');

/** Stub `exec` by matching on the command, so each case reads as a scenario. */
async function evaluateDrift(
  replies: (cmd: string) => string | Error,
  state: Record<string, unknown> | undefined = undefined,
): Promise<Verdict> {
  let verdict: Verdict | undefined;
  const tools = {
    call: async (_name: string, args: { command: string }) => {
      const out = replies(args.command);
      if (out instanceof Error) throw out;
      return { result: { details: { aggregated: out } } };
    },
  };
  const fn = new AsyncFunction('tools', 'trigger', 'json', driftSource);
  await fn(tools, { state }, (v: Verdict) => {
    verdict = v;
  });
  assert.ok(verdict, 'the watcher must always return a verdict');
  return verdict;
}

const GREEN = 'ℹ tests 9\nℹ pass 9\nℹ fail 0';
const RED = 'ℹ tests 9\nℹ pass 7\nℹ fail 2';

/** governing epoch, corpus epoch, test output. */
const drift =
  (governing: number, corpus: number, tests = GREEN, governs = 'src/domain/ src/record/ ') =>
  (cmd: string) => {
    if (cmd.includes('GOVERNS')) return governs;
    if (cmd.includes('rev-parse')) return 'abc1234';
    if (cmd.includes('src/domain/')) return String(governing);
    if (cmd.includes('test/fixtures/')) return String(corpus);
    if (cmd.includes('--test')) return tests;
    return '';
  };

test('fixture-keeper: a corpus that still holds and is current stays quiet', async () => {
  const v = await evaluateDrift(drift(1000, 2000), {});
  assert.equal(v.fire, false);
});

test('fixture-keeper: a failing corpus is the loudest condition', async () => {
  const v = await evaluateDrift(drift(1000, 2000, RED), {});
  assert.equal(v.fire, true);
  assert.match(v.message, /no longer holds: 2 failing/);
  // The instruction that keeps the corpus ground truth rather than decoration.
  assert.match(v.message, /Establish which is wrong before you touch either/);
});

test('fixture-keeper: the model moving past the corpus is worth one look', async () => {
  const v = await evaluateDrift(drift(2_000_000, 1_000_000), {});
  assert.equal(v.fire, true);
  assert.match(v.message, /The model moved after the corpus did/);
  assert.match(v.message, /nothing is known to be wrong/);
});

test('fixture-keeper: that look is not repeated every day until something else moves', async () => {
  const first = await evaluateDrift(drift(2_000_000, 1_000_000), {});
  assert.equal(first.fire, true);
  const second = await evaluateDrift(
    drift(2_000_000, 1_000_000),
    first.state as Record<string, unknown>,
  );
  assert.equal(second.fire, false, 'the same unreviewed change must not fire twice');

  // A further change to the model is a new question and does fire again.
  const third = await evaluateDrift(
    drift(3_000_000, 1_000_000),
    second.state as Record<string, unknown>,
  );
  assert.equal(third.fire, true);
});

test('fixture-keeper: a missing corpus is a setup problem, not a proposal', async () => {
  const v = await evaluateDrift(drift(2_000_000, 0), {});
  assert.equal(v.fire, true);
  assert.match(v.message, /does not exist or is untracked/);
});

test('fixture-keeper: one failed check waits, a sustained one speaks', async () => {
  const first = await evaluateDrift(() => new Error('ENOTFOUND'), {});
  assert.equal(first.fire, false);
  const second = await evaluateDrift(
    () => new Error('ENOTFOUND'),
    first.state as Record<string, unknown>,
  );
  assert.equal(second.fire, true);
  assert.match(second.message, /a quiet corpus currently means nothing/);
});

test('fixture-keeper: a corpus that has stopped declaring its scope is a finding', async () => {
  // The watcher reads the governing paths from test/fixtures/GOVERNS rather than
  // hardcoding them, because test/invariants.test.ts forbids anything under
  // automation/ from naming the record's modules. If that file goes, the watcher
  // cannot tell whether the corpus is stale, and says so rather than guessing.
  const v = await evaluateDrift(drift(2_000_000, 1_000_000, GREEN, ''), {});
  assert.equal(v.fire, true);
  assert.match(v.message, /no longer declares what it claims/);
});
