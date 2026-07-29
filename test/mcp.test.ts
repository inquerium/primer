import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const home = mkdtempSync(join(tmpdir(), 'primer-mcp-'));
const client = new Client({ name: 'primer-test', version: '0' });

before(async () => {
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: ['--experimental-strip-types', join(import.meta.dirname, '..', 'src', 'cli.ts'), 'mcp'],
      env: {
        ...process.env,
        PRIMER_HOME: home,
        PRIMER_DB: join(home, 'record.db'),
        PRIMER_PORT: '7741',
      },
    }),
  );
});

after(async () => {
  await client.close();
  rmSync(home, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content[0]?.text ?? '';
  if (res.isError) throw new Error(text);
  return JSON.parse(text);
}

test('the server advertises its tools and the tutor prompt', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const expected of [
    'learner_context',
    'record_observations',
    'save_interface',
    'note_misconception',
    'progress_report',
    'export_record',
  ]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const contextTool = tools.find((t) => t.name === 'learner_context')!;
  assert.ok(contextTool.description!.length > 200, 'the main tool must explain itself properly');

  const { prompts } = await client.listPrompts();
  assert.deepEqual(prompts.map((p) => p.name), ['tutor']);
  const prompt = await client.getPrompt({ name: 'tutor' });
  assert.ok((prompt.messages[0]!.content as { text: string }).text.includes('Read the whole child'));
});

test('a whole tutoring loop runs over the protocol', async () => {
  const learner = await call('create_learner', { display_name: 'Wire Child', pronouns: 'he/him' });
  assert.ok(learner.id.startsWith('lrn_'));

  await call('add_accommodation', {
    learner: 'Wire Child',
    kind: 'no_timers',
    detail: 'No countdown timers.',
  });
  await call('note_interest', { learner: 'Wire Child', topic: 'trains' });

  const context = await call('learner_context', { learner: 'Wire Child' });
  assert.equal(context.learner.name, 'Wire Child');
  assert.ok(context.targets.length > 0, 'a brand-new child still gets somewhere to start');
  assert.equal(context.accommodations[0].kind, 'no_timers');

  const session = await call('start_session', { learner: 'Wire Child', mode: 'practice' });

  const target = context.targets[0];
  const recorded = await call('record_observations', {
    learner: 'Wire Child',
    session_id: session.id,
    observations: [
      { skill_id: target.skill_id, correct: 1, item: 'first try', response: 'right', latency_ms: 1500 },
      { skill_id: target.skill_id, correct: 0, item: 'second try', response: 'wrong', latency_ms: 9000 },
    ],
  });
  assert.equal(recorded.length, 2);
  assert.ok(recorded[0].p_known > 0);

  const evidence = await call('evidence_for', { learner: 'Wire Child', skill_id: target.skill_id });
  assert.equal(evidence.observations.length, 2);
  assert.equal(evidence.observations[0].response, 'wrong');

  const activityHtml = `<!doctype html><html lang="en"><head>
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Train yard</title></head>
<body><h1>All aboard</h1><button id="go">train</button><script>
  document.getElementById('go').onclick = function () {
    window.primer.observe({ skill: '${target.skill_id}', correct: 1, item: 'train', response: 'train' });
    window.primer.affect('delight', { evidence: 'wanted another' });
    window.primer.done({ summary: 'One round.', energy: 'ok' });
  };
</script></body></html>`;

  const saved = await call('save_interface', {
    learner: 'Wire Child',
    title: 'Train yard sound match',
    kind: 'game',
    target_skills: [target.skill_id],
    html: activityHtml,
    spec: { uses_interest: 'trains', honors: ['no_timers'] },
  });
  assert.equal(saved.saved, true, JSON.stringify(saved.problems ?? saved));
  assert.match(saved.url, /^http:\/\/127\.0\.0\.1:7741\/i\/ifc_/);

  // And an activity that would show a child a blank screen never gets saved.
  const rejected = await call('save_interface', {
    learner: 'Wire Child',
    title: 'Broken',
    html: '<!doctype html><html><body><script>function ( {</script></body></html>',
  });
  assert.equal(rejected.saved, false, 'a script that cannot parse must be refused');
  assert.ok(rejected.message.includes('not saved'));

  const page = await fetch(saved.url);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('All aboard'));
  assert.ok(html.includes('/runtime.js'), 'the served page must carry the runtime');

  await call('note_misconception', {
    learner: 'Wire Child',
    pattern: 'Says the letter name instead of the sound',
    skill_id: target.skill_id,
  });
  await call('note_affect', { learner: 'Wire Child', signal: 'delight', evidence: 'wanted another go' });
  await call('end_session', { session_id: session.id, summary: 'Good first go.', energy: 'ok' });

  const after = await call('learner_context', { learner: 'Wire Child' });
  assert.equal(after.misconceptions.length, 1);
  assert.equal(after.interfaces.recent.length, 1);
  // Opening the interface started its own session, so find the one we closed.
  const closed = after.recent_sessions.find((s: { id: string }) => s.id === session.id);
  assert.ok(closed.summary.includes('Good first go'));

  const report = await call('progress_report', { learner: 'Wire Child' });
  assert.equal(report.totals.observations, 2);

  const dump = await call('export_record', { learner: 'Wire Child' });
  assert.equal(dump.observation.length, 2);
  assert.equal(dump.interface.length, 1);
});

test('an unknown learner fails loudly instead of inventing one', async () => {
  await assert.rejects(() => call('learner_context', { learner: 'Nobody At All' }), /Known learners/);
});
