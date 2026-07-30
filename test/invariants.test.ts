/**
 * The human-in-the-loop invariants, as executable doctrine.
 *
 * Everything in this file is a promise the project makes about who holds
 * power: what an unattended model may and may not do, what an adult must
 * approve, what the model is structurally unable to reach. These promises are
 * why a family can run an autonomous tutor in their home at all — and they are
 * exactly the properties that erode one convenient refactor at a time, because
 * each individual erosion looks harmless and ships with something useful.
 *
 * So they are pinned here, separately from the tests of whether things work.
 * A failing test in this file does not mean something is broken. It means a
 * capability boundary moved — and moving one must be a conscious, reviewed,
 * argued-for decision, not a side effect. If you came here to update an
 * assertion, the assertion is working: now write in your PR why the boundary
 * should move.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-invariants-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { saveInterface } = await import('../src/surface/store.ts');
const { planActivity } = await import('../src/record/queue.ts');
const { settings } = await import('../src/agent/config.ts');
const { TOOLS, TOOLS_BY_NAME } = await import('../src/mcp/tools.ts');
const { AUTONOMOUS_TOOLS } = await import('../src/agent/claude-code.ts');
const { AUTONOMOUS_PROMPT } = await import('../src/agent/prompt.ts');
const { TUTOR_PROMPT } = await import('../src/mcp/prompt.ts');
const { validateInterface } = await import('../src/surface/validate.ts');
const { describeArtifact } = await import('../src/record/artifacts.ts');

before(() => {
  db();
  loadCurriculum();
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

/**
 * What an unattended run may call. This is the whole boundary: every built-in
 * tool is switched off, so these eighteen names are the entire reach of a
 * model nobody is watching.
 */
const ALLOWED = [
  'add_note',
  'evidence_for',
  'get_interface_html',
  'learner_context',
  'list_artifacts',
  'list_interfaces',
  'next_targets',
  'note_affect',
  'note_interest',
  'note_misconception',
  'plan_activity',
  'queue_status',
  'record_artifact_review',
  'record_observations',
  'resolve_misconception',
  'save_interface',
  'skill_detail',
  'skill_search',
];

/**
 * What exists but is withheld from an unattended run, and why. Each of these
 * is an adult's decision or an adult's tool; giving any of them to the
 * overnight loop changes who is in charge of a child's education.
 */
const WITHHELD = [
  'create_learner', //     who is enrolled is a human decision, never the model's
  'list_learners', //      an unattended run works on the one child it was woken for
  'start_session', //      sessions bracket a real child's presence; the daemon has no child in front of it
  'end_session', //        same boundary as start_session
  'add_accommodation', //  a standing constraint on how a child must be taught is set by an adult
  'set_goal', //           intent belongs to the family, not the loop
  'score_interface', //    outcome scoring runs from evidence at session end, not on the author's say-so
  'progress_report', //    the parent-facing summary is pulled by a human, not pushed by the model
  'export_record', //      the whole record leaves this machine only by a human's hand
  'recompute_mastery', //  rebuilding every estimate is maintenance, not tutoring
];

test('the autonomous allowlist is exactly the eighteen tools it has always been', () => {
  assert.deepEqual(
    [...AUTONOMOUS_TOOLS].sort(),
    ALLOWED,
    'the set of things an unattended model can do has changed — that must be a deliberate, argued-for decision, not a drive-by',
  );
});

test('every tool the server exposes is consciously classified: allowed or withheld', () => {
  const exposed = TOOLS.map((t) => t.name).sort();
  assert.deepEqual(
    exposed,
    [...ALLOWED, ...WITHHELD].sort(),
    'a tool exists that this file has not classified — decide whether an unattended run may call it, write down why, and add it to exactly one list',
  );
  for (const name of WITHHELD) {
    assert.ok(
      !(AUTONOMOUS_TOOLS as readonly string[]).includes(name),
      `${name} is withheld from the unattended tutor by design`,
    );
  }
});

test('no tool exposed to any model can touch settings', () => {
  // review_required, budgets, audio_capture — the levers that govern the
  // autonomous system — are changed by `primer config` and the parent app,
  // with an actor logged. There is no MCP path to them, so no amount of
  // prompt injection reaches them either.
  for (const t of TOOLS) {
    assert.ok(
      !/setting|config|budget/i.test(t.name),
      `${t.name} looks like a settings tool; the record's levers are not model-reachable`,
    );
  }
});

test('the tutor cannot approve its own work, structurally', () => {
  // Not "is instructed not to" — cannot. The plan_activity schema has no field
  // that could carry a status, and planActivity derives the status from the
  // install's review_required setting alone.
  const schema = TOOLS_BY_NAME.get('plan_activity')!.inputSchema as {
    properties: Record<string, unknown>;
  };
  for (const key of Object.keys(schema.properties)) {
    assert.ok(
      !/status|approv|review|ready|skip/i.test(key),
      `plan_activity accepts "${key}", which reads like a self-approval channel`,
    );
  }

  assert.equal(settings().review_required, true, 'the gate ships closed');
  const child = createLearner({ display_name: 'Gate Check' });
  const iface = saveInterface(child.id, {
    title: 'Gate check',
    html: '<!doctype html><html><body><script>primer.observe({skill:"x",correct:1});primer.done();</script></body></html>',
  });
  const planned = planActivity(child.id, { interface_id: iface.id, title: 'Gate check' });
  assert.equal(
    planned.status,
    'pending_review',
    'whatever the tutor wants, work waits for an adult while the gate is closed',
  );
});

test('a recording is opaque to the model: metadata only, never the path, never the bytes', () => {
  // The model can know a recording exists, what was asked, how long it ran,
  // and what a human said after listening. It cannot hear the child, and it
  // cannot learn where on this machine the child's voice is stored.
  const described = describeArtifact({
    id: 'art_test',
    learner_id: 'lrn_test',
    kind: 'audio',
    path: '/very/private/place/recording.webm',
    ts: '2026-07-29T00:00:00Z',
    prompt: 'Read the page aloud.',
    caption: null,
    transcript: null,
    skill_ids: null,
    duration_ms: 4000,
    reviewed_at: null,
    bytes: 1234,
  } as never);

  assert.ok(!('path' in described), 'the filesystem path must not cross the boundary');
  assert.ok(
    !JSON.stringify(described).includes('/very/private/place'),
    'no field may leak where recordings live',
  );
  assert.ok(!('data' in described) && !('base64' in described), 'no bytes cross either');
});

test('an activity that phones home or reports nothing is refused before it can be saved', () => {
  // The child-facing page is static by decree: no live model path, no external
  // requests, and it must feed the record. These are hard errors in the
  // validator, which runs before save_interface will store anything — the
  // rules hold even when the model forgets them.
  const phoningHome = validateInterface(
    '<!doctype html><html><body><script src="https://cdn.example.com/x.js"></script><script>primer.observe({skill:"x",correct:1});</script></body></html>',
  );
  assert.equal(phoningHome.ok, false, 'an external request is a refusal, not a warning');

  const silent = validateInterface(
    '<!doctype html><html><body><script>document.body.textContent = "fun";</script></body></html>',
  );
  assert.equal(silent.ok, false, 'an activity that reports nothing teaches the record nothing');
});

test('both prompts carry the engagement-mechanics ban and the limits of the loop', () => {
  // Prompt text is the soft layer above the structural enforcement, and it is
  // part of the contract too: the tutor is told what it must not build, and
  // told the truth about what it cannot do.
  assert.match(AUTONOMOUS_PROMPT, /No streaks, coins, leaderboards, or countdown timers/);
  assert.match(AUTONOMOUS_PROMPT, /cannot create or delete learners/);
  assert.match(TUTOR_PROMPT, /no streaks, no coins, no leaderboards/);
});
