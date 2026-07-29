import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-surface-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, all } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { saveInterface } = await import('../src/surface/store.ts');
const { createSurfaceServer } = await import('../src/surface/server.ts');

const surface = await createSurfaceServer(7739);
let learnerId = '';
let interfaceId = '';

before(async () => {
  db();
  loadCurriculum();
  learnerId = createLearner({ display_name: 'Surface Child' }).id;
  interfaceId = saveInterface(learnerId, {
    title: 'Counting dinosaurs',
    html: '<!doctype html><html><head></head><body><h1>count</h1></body></html>',
    kind: 'game',
    target_skills: ['cc_count_to_10'],
  }).id;
  await surface.listen();
});

after(async () => {
  await surface.close();
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('the runtime is served and exposes the tutoring API', async () => {
  const res = await fetch(`${surface.origin}/runtime.js`);
  assert.equal(res.status, 200);
  const src = await res.text();
  for (const fn of ['observe', 'affect', 'interest', 'misconception', 'done', 'mark']) {
    assert.ok(src.includes(`${fn}:`), `runtime should expose primer.${fn}`);
  }
});

test('opening an interface creates a session and injects its identity', async () => {
  const res = await fetch(`${surface.origin}/i/${interfaceId}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes('window.__PRIMER__'));
  assert.ok(html.includes(learnerId));
  assert.ok(html.includes('<h1>count</h1>'));

  const sessions = all<{ n: number }>(
    `SELECT count(*) AS n FROM session WHERE interface_id = ?`,
    interfaceId,
  )[0]!;
  assert.equal(sessions.n, 1, 'opening an interface should open exactly one session');
});

test('attempts posted from an interface land in the record as evidence', async () => {
  const res = await fetch(`${surface.origin}/api/observe`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      learner_id: learnerId,
      interface_id: interfaceId,
      observations: [
        { skill_id: 'cc_count_to_10', correct: 1, item: '7 dinosaurs', response: '7', latency_ms: 1800 },
        { skill_id: 'cc_count_to_10', correct: 0, item: '9 dinosaurs', response: '8', latency_ms: 6400 },
      ],
    }),
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { recorded: number; results: Array<{ p_known: number }> };
  assert.equal(body.recorded, 2);
  assert.ok(body.results[0]!.p_known > 0);

  const rows = all<{ item: string; source: string }>(
    `SELECT item, source FROM observation WHERE learner_id = ? ORDER BY ts`,
    learnerId,
  );
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.source === interfaceId), 'evidence must record which interface produced it');
});

test('affect, interests, and misconceptions post from the interface too', async () => {
  for (const [path, body] of [
    ['/api/affect', { learner_id: learnerId, signal: 'delight', intensity: 0.9, evidence: 'asked for one more' }],
    ['/api/interest', { learner_id: learnerId, topic: 'dinosaurs' }],
    ['/api/misconception', { learner_id: learnerId, pattern: 'counts the last object twice' }],
  ] as const) {
    const res = await fetch(`${surface.origin}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200, `${path} should accept a post`);
  }

  assert.equal(all<{ n: number }>(`SELECT count(*) AS n FROM affect WHERE learner_id = ?`, learnerId)[0]!.n, 1);
  assert.equal(all<{ n: number }>(`SELECT count(*) AS n FROM interest WHERE learner_id = ?`, learnerId)[0]!.n, 1);
  assert.equal(
    all<{ n: number }>(`SELECT count(*) AS n FROM misconception WHERE learner_id = ?`, learnerId)[0]!.n,
    1,
  );
});

test('ending a session scores the interface from what happened inside it', async () => {
  const session = all<{ id: string }>(
    `SELECT id FROM session WHERE interface_id = ? ORDER BY started_at DESC LIMIT 1`,
    interfaceId,
  )[0]!;
  const res = await fetch(`${surface.origin}/api/session/end`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      session_id: session.id,
      interface_id: interfaceId,
      summary: 'Counted to ten with dinosaurs.',
      energy: 'high',
    }),
  });
  const body = (await res.json()) as { outcome_score: number | null };
  assert.ok(body.outcome_score !== null && body.outcome_score > 0 && body.outcome_score <= 1);

  const stored = all<{ outcome_score: number; ended_at: string | null }>(
    `SELECT i.outcome_score, s.ended_at FROM interface i
       JOIN session s ON s.interface_id = i.id WHERE i.id = ?`,
    interfaceId,
  )[0]!;
  assert.ok(stored.ended_at, 'the session should be closed');
});

test('an activity posts back to wherever it was served from, not to localhost', async () => {
  // Opened on a tablet over the LAN, an absolute `http://127.0.0.1:7333` baked into
  // the page resolves to the *tablet's* own localhost. The activity plays, the child
  // finishes, and every answer is posted into the void — no error, no clue, an empty
  // record. Relative URLs are the only form correct on both localhost and the LAN.
  const html = await (await fetch(`${surface.origin}/i/${interfaceId}`)).text();
  const config = JSON.parse(html.match(/window\.__PRIMER__=(\{.*?\});/)![1]!);

  assert.equal(config.api, '', 'the runtime must post to a relative URL');
  assert.ok(
    !/"api":\s*"https?:\/\//.test(html),
    'no absolute origin may be baked into a page a child might open from another device',
  );

  // The same must hold on the child's own app route, which is the one a tablet uses.
  const { slugFor } = await import('../src/surface/pwa.ts');
  const { one } = await import('../src/db/index.ts');
  const learner = one<{ id: string; display_name: string }>(
    `SELECT id, display_name FROM learner WHERE id = ?`,
    learnerId,
  )!;
  const appHtml = await (await fetch(`${surface.origin}/k/${slugFor(learner)}`)).text();
  const appConfig = appHtml.match(/window\.__PRIMER__=(\{.*?\});/);
  if (appConfig) {
    assert.equal(JSON.parse(appConfig[1]!).api, '', 'the installed app must post relatively too');
  }
});

test('a path traversal attempt on artifacts is refused', async () => {
  const res = await fetch(`${surface.origin}/artifacts/..%2F..%2Frecord.db`);
  assert.ok(res.status === 400 || res.status === 404);
});
