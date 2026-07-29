import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-auto-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');
delete process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_AUTH_TOKEN;

const { db, closeDb, all, run, id, now } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { recordObservations, startSession, endSession } = await import('../src/record/observations.ts');
const { saveInterface } = await import('../src/surface/store.ts');
const { createSurfaceServer } = await import('../src/surface/server.ts');
const queue = await import('../src/record/queue.ts');
const { settings, setSetting, budget, costOf } = await import('../src/agent/config.ts');
const { decide } = await import('../src/agent/daemon.ts');
const { runTutor } = await import('../src/agent/tutor.ts');
const { exportRecord, importRecord } = await import('../src/record/report.ts');

const surface = createSurfaceServer(7752);
let learnerId = '';

before(async () => {
  db();
  loadCurriculum();
  learnerId = createLearner({ display_name: 'Queue Child' }).id;
  await surface.listen();
});

after(async () => {
  await surface.close();
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

function makeInterface(title = 'Dino counting') {
  return saveInterface(learnerId, {
    title,
    html: `<!doctype html><html><head></head><body><h1>${title}</h1></body></html>`,
    kind: 'game',
    target_skills: ['cc_count_to_10'],
  }).id;
}

test('the migration runner applies each file once and records it', () => {
  const applied = all<{ name: string }>(`SELECT name FROM applied_migration ORDER BY name`);
  assert.ok(
    applied.some((m) => m.name === '002_autonomy.sql'),
    'the autonomy migration should be recorded as applied',
  );

  // Re-opening the record re-runs migrate(); nothing may be applied twice.
  closeDb();
  db();
  const again = all<{ name: string }>(`SELECT name FROM applied_migration`);
  assert.equal(again.length, applied.length);
  assert.ok(all(`SELECT * FROM planned_activity LIMIT 1`) !== undefined);
});

test('settings ship with the review gate on', () => {
  assert.equal(settings().review_required, true, 'an autonomous system defaults to supervised');
  assert.equal(settings().model, 'claude-opus-5');
});

test('a generated activity waits for an adult before any child can reach it', async () => {
  const ifaceId = makeInterface();
  const activity = queue.planActivity(learnerId, {
    interface_id: ifaceId,
    title: 'Dino counting',
    rationale: 'Counting to ten has never been directly assessed and she loves dinosaurs.',
    target_skills: ['cc_count_to_10'],
  });

  assert.equal(activity.status, 'pending_review');
  assert.equal(queue.readyCount(learnerId), 0, 'unapproved work is not ready');
  assert.equal(queue.nextReady(learnerId), undefined);

  const { slugFor } = await import('../src/surface/pwa.ts');
  const slug = slugFor({ id: learnerId, display_name: 'Queue Child' });

  // The child's own app shows nothing, rather than leaking unreviewed content.
  const blocked = await fetch(`${surface.origin}/k/${slug}`);
  assert.equal(blocked.status, 200);
  assert.ok((await blocked.text()).includes('Nothing new right now'));

  queue.approve(activity.id, 'parent', 'Fine, but keep it short.');
  assert.equal(queue.readyCount(learnerId), 1);

  // Served in place, not redirected — so an installed app always opens on
  // whatever is waiting rather than pinning one finished activity.
  const open = await fetch(`${surface.origin}/k/${slug}`);
  assert.equal(open.status, 200);
  const html = await open.text();
  assert.ok(html.includes('Dino counting'), 'the activity itself must be served');
  assert.ok(html.includes('manifest.webmanifest'), 'and it must be installable');
  assert.ok(html.includes(ifaceId), 'with the runtime wired to this interface');
  assert.equal(queue.getActivity(activity.id)!.status, 'delivered');
});

test('the review page never shows a child anything and posts decisions back', async () => {
  const activity = queue.planActivity(learnerId, {
    interface_id: makeInterface('Rejected idea'),
    title: 'Rejected idea',
    rationale: 'Testing the gate.',
  });

  const page = await fetch(`${surface.origin}/review`);
  const html = await page.text();
  assert.ok(html.includes('Rejected idea'));
  assert.ok(html.includes('has been shown to a child'));

  const res = await fetch(`${surface.origin}/review/decide`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      activity_id: activity.id,
      decision: 'reject',
      note: 'Too many items for her attention span.',
    }),
  });
  assert.equal(res.status, 200);
  assert.equal(queue.getActivity(activity.id)!.status, 'rejected');

  const feedback = queue.recentReviewFeedback(learnerId);
  assert.ok(
    feedback.some((f) => f.review_note?.includes('attention span')),
    'the adult\'s reasoning must reach the next planning run',
  );
});

test('a child who closes the app and comes back finds their activity again', async () => {
  const { slugFor } = await import('../src/surface/pwa.ts');
  const child = createLearner({ display_name: 'Resume Child' }).id;
  const slug = slugFor({ id: child, display_name: 'Resume Child' });
  const ifaceId = makeInterface('Half finished');
  const activity = queue.planActivity(child, { interface_id: ifaceId, title: 'Half finished' });
  queue.approve(activity.id);

  const first = await (await fetch(`${surface.origin}/k/${slug}`)).text();
  assert.ok(first.includes('Half finished'));
  assert.equal(queue.getActivity(activity.id)!.status, 'delivered');

  // They wander off, then open the app again. It must still be there.
  const again = await (await fetch(`${surface.origin}/k/${slug}`)).text();
  assert.ok(
    again.includes('Half finished'),
    'reopening must resume, not report that there is nothing to do',
  );

  // Once finished, it is gone and the next thing takes its place.
  queue.markDone(activity.id);
  const after = await (await fetch(`${surface.origin}/k/${slug}`)).text();
  assert.ok(after.includes('Nothing new right now'), 'a finished activity must not come back');
});

test('an activity opened but never touched goes back in the queue', async () => {
  const child = createLearner({ display_name: 'Abandoned Child' }).id;
  const ifaceId = makeInterface('Never started');
  const activity = queue.planActivity(child, { interface_id: ifaceId, title: 'Never started' });
  queue.approve(activity.id);
  queue.markDelivered(activity.id);

  // Backdate the delivery so it counts as abandoned rather than in progress.
  run(
    `UPDATE planned_activity SET delivered_at = datetime('now', '-2 hours') WHERE id = ?`,
    activity.id,
  );

  assert.equal(queue.restoreAbandoned(child), 1);
  assert.equal(queue.getActivity(activity.id)!.status, 'ready', 'nothing was recorded, so give it back');

  // But an activity they actually did some of is left alone.
  const second = queue.planActivity(child, { interface_id: makeInterface('Partly done'), title: 'Partly done' });
  queue.approve(second.id);
  queue.markDelivered(second.id);
  recordObservations(child, [
    { skill_id: 'cc_count_to_10', correct: 1, item: 'one', source: queue.getActivity(second.id)!.interface_id },
  ]);
  run(
    `UPDATE planned_activity SET delivered_at = datetime('now', '-2 hours') WHERE id = ?`,
    second.id,
  );
  assert.equal(queue.restoreAbandoned(child), 0, 'work already done must not be handed back');
});

test('each child gets their own installable app, named for them', async () => {
  const { slugFor } = await import('../src/surface/pwa.ts');
  const slug = slugFor({ id: learnerId, display_name: 'Queue Child' });

  const manifest = await (await fetch(`${surface.origin}/k/${slug}/manifest.webmanifest`)).json();
  assert.equal(manifest.name, "Queue Child's Primer");
  assert.equal(manifest.short_name, 'Queue Child');
  assert.equal(manifest.display, 'standalone', 'no browser chrome once installed');
  assert.equal(manifest.start_url, `/k/${slug}`, 'opening it lands on today, not a fixed activity');
  assert.match(manifest.theme_color, /^hsl\(/);

  const icon = await fetch(`${surface.origin}/k/${slug}/icon.svg`);
  assert.equal(icon.headers.get('content-type'), 'image/svg+xml');
  assert.match(await icon.text(), />Q</, "the child's own initial");

  // Two children of the same name must not collide on one app.
  const { createLearner: make } = await import('../src/record/learners.ts');
  const twin = make({ display_name: 'Queue Child' });
  assert.notEqual(slugFor(twin), slug, 'a second child of the same name needs their own link');
  assert.equal(slugFor({ id: learnerId, display_name: 'Queue Child' }), slug, 'and the first keeps theirs');
});

test('the old id-based link still works and moves you to the short one', async () => {
  const { slugFor } = await import('../src/surface/pwa.ts');
  const res = await fetch(`${surface.origin}/child/${learnerId}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), `/k/${slugFor({ id: learnerId, display_name: 'Queue Child' })}`);
});

test('finishing an activity closes it out', async () => {
  const { slugFor } = await import('../src/surface/pwa.ts');
  const slug = slugFor({ id: learnerId, display_name: 'Queue Child' });
  const ifaceId = makeInterface('Finish me');
  const activity = queue.planActivity(learnerId, { interface_id: ifaceId, title: 'Finish me' });
  queue.approve(activity.id);
  await fetch(`${surface.origin}/k/${slug}`);

  const session = startSession(learnerId, { interface_id: ifaceId });
  await fetch(`${surface.origin}/api/session/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ session_id: session.id, interface_id: ifaceId, summary: 'done' }),
  });
  assert.equal(queue.getActivity(activity.id)!.status, 'done');
});

test('the scheduler holds back when work is already waiting', () => {
  const child = createLearner({ display_name: 'Backlog Child' }).id;
  assert.equal(decide(child).trigger, 'backlog_empty', 'an empty queue is a reason to run');

  for (let i = 0; i < settings().queue_target; i++) {
    const a = queue.planActivity(child, { interface_id: makeInterface(`a${i}`), title: `a${i}` });
    queue.approve(a.id);
  }
  const held = decide(child);
  assert.equal(held.trigger, null);
  assert.match(held.reason, /already waiting/);
});

test('a finished session is the strongest reason to plan again', () => {
  const child = createLearner({ display_name: 'Session Child' }).id;
  for (let i = 0; i < settings().queue_target; i++) {
    const a = queue.planActivity(child, { interface_id: makeInterface(`s${i}`), title: `s${i}` });
    queue.approve(a.id);
  }
  assert.equal(decide(child).trigger, null);

  const session = startSession(child, { mode: 'practice' });
  endSession(session.id, { summary: 'went well' });
  // One is consumed by the session, dropping below target, and the session itself
  // is fresher than any prior run.
  queue.markDone(queue.nextReady(child)!.id);
  assert.equal(decide(child).trigger, 'session_ended');
});

test('a recent run keeps the tutor from waking again immediately', () => {
  const child = createLearner({ display_name: 'Cooldown Child' }).id;
  run(
    `INSERT INTO agent_run (id, learner_id, trigger, started_at, status) VALUES (?, ?, 'manual', ?, 'ok')`,
    'run_test_cooldown',
    child,
    new Date().toISOString(),
  );
  const d = decide(child);
  assert.equal(d.trigger, null);
  assert.match(d.reason, /minimum is/);
});

test('cost is computed from real token counts, cache included', () => {
  const cost = costOf('claude-opus-5', {
    input_tokens: 1_000_000,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  assert.equal(cost, 5);

  const cached = costOf('claude-opus-5', {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 1_000_000,
    cache_write_tokens: 0,
  });
  assert.ok(cached < 1, `a cache read should be about a tenth of input, got ${cached}`);

  const output = costOf('claude-opus-5', {
    input_tokens: 0,
    output_tokens: 1_000_000,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
  });
  assert.equal(output, 25);
});

test('the budget stops a run before it starts an expensive one', async () => {
  const before = budget();
  assert.equal(before.exhausted, false);

  run(
    `INSERT INTO agent_run (id, learner_id, trigger, started_at, status, cost_usd)
     VALUES (?, ?, 'manual', ?, 'ok', ?)`,
    'run_test_expensive',
    learnerId,
    new Date().toISOString(),
    99.0,
  );
  assert.equal(budget().exhausted, true);

  const result = await runTutor(learnerId, { trigger: 'manual' });
  assert.equal(result.status, 'over_budget');
  assert.match(result.summary, /Budget reached/);
  assert.equal(result.cost_usd, 0, 'a refused run costs nothing');

  run(`DELETE FROM agent_run WHERE id = 'run_test_expensive'`);
});

test('changing a setting is audited', () => {
  setSetting('review_required', 'false', 'parent');
  assert.equal(settings().review_required, false);

  const events = all<{ action: string; actor: string; target: string }>(
    `SELECT action, actor, target FROM event_log WHERE action = 'set_setting'`,
  );
  assert.ok(events.some((e) => e.target === 'review_required' && e.actor === 'parent'));

  // With the gate off, generated work is ready immediately — the point of the setting.
  const activity = queue.planActivity(learnerId, {
    interface_id: makeInterface('Ungated'),
    title: 'Ungated',
  });
  assert.equal(activity.status, 'ready');
  setSetting('review_required', 'true', 'parent');
});

test('every tool the autonomous run is allowed to call actually exists over MCP', async () => {
  const { AUTONOMOUS_TOOLS } = await import('../src/agent/claude-code.ts');
  const { TOOLS_BY_NAME } = await import('../src/mcp/tools.ts');

  for (const name of AUTONOMOUS_TOOLS) {
    assert.ok(TOOLS_BY_NAME.has(name), `allowlisted tool "${name}" is not served by the MCP server`);
  }
  for (const needed of ['learner_context', 'save_interface', 'plan_activity', 'queue_status']) {
    assert.ok(AUTONOMOUS_TOOLS.includes(needed as never), `autonomous tutor needs ${needed}`);
  }

  // The decisions that belong to an adult exist over MCP, where a human is asking,
  // and must never appear in the unattended allowlist.
  for (const forbidden of ['create_learner', 'add_accommodation', 'set_goal', 'export_record']) {
    assert.ok(TOOLS_BY_NAME.has(forbidden), `${forbidden} should exist over MCP`);
    assert.ok(
      !AUTONOMOUS_TOOLS.includes(forbidden as never),
      `${forbidden} must not be reachable by an unattended run`,
    );
  }
});

test('the Claude Code invocation is locked down', async () => {
  const { buildArgs, AUTONOMOUS_TOOLS } = await import('../src/agent/claude-code.ts');
  const args = buildArgs(
    { prompt: 'plan', systemPrompt: 'be a tutor', model: 'claude-opus-5', effort: 'high', maxBudgetUsd: 0.5, maxTurns: 30 },
    'C:/tmp/mcp.json',
  );
  const valueAfter = (flagName: string) => args[args.indexOf(flagName) + 1];

  assert.ok(args.includes('-p'), 'must run non-interactively');
  assert.equal(valueAfter('--output-format'), 'json');
  assert.equal(valueAfter('--mcp-config'), 'C:/tmp/mcp.json');

  // No Bash, no Read, no Write, no WebFetch: the tutor can only reach the record.
  assert.equal(valueAfter('--tools'), '', 'every built-in tool must be off');
  assert.ok(args.includes('--strict-mcp-config'), 'other MCP servers must be ignored');
  assert.equal(valueAfter('--setting-sources'), '', 'no hooks, plugins, or operator settings');
  assert.equal(valueAfter('--system-prompt'), 'be a tutor', 'the default system prompt is replaced');

  // --bare looks like the isolation flag and silently disables OAuth, which is the
  // only credential this transport has. Regression guard: never reintroduce it.
  assert.ok(!args.includes('--bare'), '--bare would throw away the operator\'s login');

  const allowed = valueAfter('--allowedTools')!.split(',');
  assert.equal(allowed.length, AUTONOMOUS_TOOLS.length);
  assert.ok(allowed.every((t) => t.startsWith('mcp__primer__')));
  assert.ok(!allowed.some((t) => /bash|write|edit|fetch/i.test(t)));

  assert.equal(valueAfter('--max-budget-usd'), '0.50', 'Claude Code enforces the ceiling itself');
  assert.equal(valueAfter('--model'), 'claude-opus-5');
  assert.equal(valueAfter('--effort'), 'high');
  assert.ok(args.includes('--no-session-persistence'));
});

test('a missing or signed-out Claude Code fails with something actionable', async () => {
  const { runClaudeCode } = await import('../src/agent/claude-code.ts');
  const previous = process.env.PRIMER_CLAUDE_BIN;
  process.env.PRIMER_CLAUDE_BIN = 'primer-no-such-binary';

  const result = await runClaudeCode({
    prompt: 'hello',
    systemPrompt: 'hello',
    timeoutMs: 20_000,
  });
  assert.equal(result.ok, false);
  assert.equal(result.failure, 'not_installed');
  assert.match(result.text, /PRIMER_CLAUDE_BIN/);

  if (previous === undefined) delete process.env.PRIMER_CLAUDE_BIN;
  else process.env.PRIMER_CLAUDE_BIN = previous;
});

test('a failed run is recorded with its reason, not swallowed', async () => {
  const previous = process.env.PRIMER_CLAUDE_BIN;
  process.env.PRIMER_CLAUDE_BIN = 'primer-no-such-binary';

  const child = createLearner({ display_name: 'Broken Claude Child' }).id;
  const result = await runTutor(child, { trigger: 'manual' });
  assert.equal(result.status, 'error');

  const logged = all<{ status: string; error: string }>(
    `SELECT status, error FROM agent_run WHERE learner_id = ?`,
    child,
  );
  assert.equal(logged[0]!.status, 'error');
  assert.equal(logged[0]!.error, 'not_installed');

  if (previous === undefined) delete process.env.PRIMER_CLAUDE_BIN;
  else process.env.PRIMER_CLAUDE_BIN = previous;
});

test('a record exports and imports into a fresh learner, evidence intact', () => {
  recordObservations(learnerId, [
    { skill_id: 'cc_count_to_10', correct: 1, item: 'count to ten', response: 'one two three' },
  ]);
  const dump = exportRecord(learnerId) as Record<string, any>;

  const imported = importRecord(dump);
  assert.notEqual(imported.learner_id, learnerId, 'importing twice must not merge two children');
  assert.equal(imported.name, 'Queue Child');

  const observations = all<{ response: string }>(
    `SELECT response FROM observation WHERE learner_id = ?`,
    imported.learner_id,
  );
  assert.ok(observations.some((o) => o.response === 'one two three'));

  const activities = all<{ n: number }>(
    `SELECT count(*) AS n FROM planned_activity WHERE learner_id = ?`,
    imported.learner_id,
  )[0]!;
  assert.ok(activities.n > 0, 'the queue travels with the record');
});

test('an exported record carries its activities, not just paths to them', () => {
  // The failure this catches: export stores an absolute path from the machine that
  // wrote it. On any other machine that path is meaningless, so every activity in
  // the imported record refuses to open — a record that is portable in name only.
  const iface = saveInterface(learnerId, {
    title: 'Dig site',
    html: '<!doctype html><html><head></head><body>buried words<script>primer.observe({})</script></body></html>',
  });

  const dump = exportRecord(learnerId) as Record<string, any>;
  const exported = dump['interface'].find((r: any) => r.id === iface.id);
  assert.ok(exported, 'the interface row should be in the export');
  assert.match(exported.html, /buried words/, 'the HTML itself must be in the export envelope');

  // Simulate arriving on another machine: the original path does not exist there.
  for (const row of dump['interface']) row.path = join(tmpdir(), 'nowhere', `${row.id}.html`);

  const imported = importRecord(dump);
  assert.deepEqual(imported.warnings.filter((w) => /will not open/.test(w)), []);

  const landed = all<{ path: string; title: string }>(
    `SELECT path, title FROM interface WHERE learner_id = ?`,
    imported.learner_id,
  ).find((r) => r.title === 'Dig site');
  assert.ok(landed, 'the activity should have come across');
  assert.ok(existsSync(landed.path), 'the imported activity has no file behind it');
  assert.match(readFileSync(landed.path, 'utf8'), /buried words/);
});

test('importing a hostile record cannot point an artifact at an arbitrary file', () => {
  // A record file is an untrusted document — it can arrive from anyone, claiming to
  // be "Emma's old school record". If an artifact row's `path` is trusted verbatim,
  // deleting that imported "child" later (the feature that exists to be
  // trustworthy) deletes whatever file the attacker named.
  const victim = join(tmpdir(), `victim-${id('x')}.txt`);
  writeFileSync(victim, 'do not delete me', 'utf8');

  const dump = {
    format: 'open-learner-record',
    learner: [{ id: 'lrn_evil', display_name: 'Totally Normal Kid' }],
    artifact: [
      { id: 'art_a', learner_id: 'lrn_evil', ts: now(), kind: 'audio', path: victim, mime: 'audio/webm' },
    ],
  };

  const imported = importRecord(dump);
  const row = all<{ path: string }>(
    `SELECT path FROM artifact WHERE learner_id = ?`,
    imported.learner_id,
  )[0];

  assert.ok(row, 'the artifact row should not simply vanish');
  assert.notEqual(row.path, victim, 'an imported artifact must never point outside the artifacts directory');
  assert.ok(existsSync(victim), 'the victim file must survive the import untouched');
});

test('a crafted id in an import cannot break out of the interfaces directory', () => {
  const outside = join(tmpdir(), `escape-${id('x')}.html`);

  const dump = {
    format: 'open-learner-record',
    learner: [{ id: 'lrn_evil2', display_name: 'Another Kid' }],
    interface: [
      {
        id: `../../../../../../../../..${outside.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/')}`,
        learner_id: 'lrn_evil2',
        title: 'x',
        html: 'attacker content',
      },
    ],
  };

  importRecord(dump);
  assert.ok(!existsSync(outside), 'a crafted id must not let a write land outside the interfaces directory');
});

test('a crafted id in an import cannot inject SQL through the column list', () => {
  const before = all(`SELECT value FROM setting WHERE key = 'child_token'`);

  const dump = {
    format: 'open-learner-record',
    learner: [{ id: 'lrn_evil3', display_name: 'SQLi Kid' }],
    note: [
      {
        "id, learner_id, author_role, text, created_at) SELECT id, learner_id, 'parent', value, created_at FROM setting WHERE key='child_token' --":
          'x',
        learner_id: 'lrn_evil3',
        author_role: 'parent',
        text: 'harmless note',
        created_at: now(),
      },
    ],
  };

  // Must not throw with a syntax error, and must not read another table's data
  // into a row this import controls.
  const imported = importRecord(dump);
  const notes = all<{ text: string }>(`SELECT text FROM note WHERE learner_id = ?`, imported.learner_id);
  assert.ok(
    notes.every((n) => n.text !== before[0]?.['value' as never]),
    'an imported row must never carry another table’s secret through a crafted column name',
  );
});

test('an imported id cannot carry markup into the review or progress pages', async () => {
  const dump = {
    format: 'open-learner-record',
    learner: [{ id: 'lrn_evil4', display_name: 'XSS Kid' }],
    planned_activity: [
      {
        id: 'pln_a\'-onmouseover="alert(1)',
        learner_id: 'lrn_evil4',
        title: 'x',
        status: 'ready',
        rationale: 'x',
        created_at: now(),
      },
    ],
  };

  const imported = importRecord(dump);
  const row = all<{ id: string }>(
    `SELECT id FROM planned_activity WHERE learner_id = ?`,
    imported.learner_id,
  )[0];
  assert.ok(row, 'the row should still import');
  // The id must come from a *validated* prefix, never the raw attacker string —
  // it is the thing concatenated into HTML attributes on the parent's own pages.
  assert.doesNotMatch(row.id, /["'<>]/, 'an imported id must never carry HTML-breaking characters');
});
