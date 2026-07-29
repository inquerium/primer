import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'primer-art-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, all } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner } = await import('../src/record/learners.ts');
const { saveInterface, renderInterface, getInterface } = await import('../src/surface/store.ts');
const { createSurfaceServer } = await import('../src/surface/server.ts');
const { setSetting, settings } = await import('../src/agent/config.ts');
const artifacts = await import('../src/record/artifacts.ts');

const surface = createSurfaceServer(7761);
let learnerId = '';

// A tiny but structurally valid WebM header, enough to prove bytes round-trip.
const CLIP = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x23]);

before(async () => {
  db();
  loadCurriculum();
  learnerId = createLearner({ display_name: 'Reader Child' }).id;
  await surface.listen();
});

after(async () => {
  await surface.close();
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('recording a child is off until an adult turns it on', () => {
  assert.equal(settings().audio_capture, false, 'never a default');
});

test('the runtime is told capture is off, so a generated page cannot record', () => {
  const iface = saveInterface(learnerId, {
    title: 'Read aloud',
    html: '<!doctype html><html><head></head><body>read</body></html>',
  });
  const off = renderInterface(getInterface(iface.id)!, {
    learner_id: learnerId,
    session_id: null,
    api: surface.origin,
  });
  assert.match(off, /"audio_capture":false/);

  setSetting('audio_capture', 'true', 'parent');
  const on = renderInterface(getInterface(iface.id)!, {
    learner_id: learnerId,
    session_id: null,
    api: surface.origin,
  });
  assert.match(on, /"audio_capture":true/);
  setSetting('audio_capture', 'false', 'parent');
});

test('the upload endpoint refuses while capture is off', async () => {
  const res = await fetch(
    `${surface.origin}/api/artifact?learner_id=${learnerId}&kind=audio`,
    { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: CLIP },
  );
  assert.equal(res.status, 403);
  assert.equal(all(`SELECT count(*) AS n FROM artifact`)[0]!.n, 0);
});

test('a recording round-trips: posted, stored on disk, served back', async () => {
  setSetting('audio_capture', 'true', 'parent');

  const res = await fetch(
    `${surface.origin}/api/artifact?learner_id=${learnerId}&kind=audio` +
      `&duration_ms=4200&prompt=${encodeURIComponent('Read this page out loud.')}&skills=fl_phrasing`,
    { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: CLIP },
  );
  assert.equal(res.status, 200);
  const saved = (await res.json()) as any;

  assert.equal(saved.kind, 'audio');
  assert.equal(saved.duration_seconds, 4.2);
  assert.equal(saved.prompt, 'Read this page out loud.');
  assert.deepEqual(saved.skills, ['fl_phrasing']);
  assert.equal(saved.reviewed, false);
  assert.equal(saved.bytes, CLIP.length);

  const row = artifacts.getArtifact(saved.id)!;
  assert.ok(existsSync(row.path), 'the audio must actually be on disk');

  // And a parent can play it back through the surface.
  const played = await fetch(`${surface.origin}${saved.url}`);
  assert.equal(played.status, 200);
  assert.equal(played.headers.get('content-type'), 'audio/webm');
  assert.deepEqual(Buffer.from(await played.arrayBuffer()), CLIP);
});

test('an oversized recording is refused rather than filling the disk', async () => {
  const res = await fetch(`${surface.origin}/api/artifact?learner_id=${learnerId}&kind=audio`, {
    method: 'POST',
    headers: { 'content-type': 'audio/webm' },
    body: Buffer.alloc(26_000_000),
  });
  assert.ok(res.status >= 400, `expected a refusal, got ${res.status}`);
});

test('listening to a clip is recorded, and what was heard becomes evidence', async () => {
  const clip = artifacts.listArtifacts(learnerId)[0]!;
  assert.equal(artifacts.unreviewed(learnerId).length >= 1, true);

  const res = await fetch(`${surface.origin}/api/artifact/${clip.id}/reviewed`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(artifacts.getArtifact(clip.id)!.reviewed_at, 'review must be timestamped');
  assert.equal(artifacts.getArtifact(clip.id)!.reviewed_by, 'parent');

  // The tutor route: a human describes what they heard, and it lands as evidence.
  const { TOOLS_BY_NAME } = await import('../src/mcp/tools.ts');
  TOOLS_BY_NAME.get('record_artifact_review')!.handler(
    {
      learner: learnerId,
      artifact_id: clip.id,
      transcript: 'The... the dog ran fast.',
      note: 'Read in phrases, self-corrected on "the".',
      skill_id: 'fl_phrasing',
      correct: 1,
    },
    { origin: surface.origin },
  );

  const evidence = all<{ kind: string; response: string; source: string }>(
    `SELECT kind, response, source FROM observation WHERE skill_id = 'fl_phrasing'`,
  );
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]!.kind, 'artifact_review');
  assert.match(evidence[0]!.response, /self-corrected|dog ran fast/);
  assert.equal(evidence[0]!.source, clip.id, 'evidence must point back at the recording');

  assert.match(artifacts.getArtifact(clip.id)!.transcript!, /dog ran fast/);
});

test('the tutor is told when recording is unavailable rather than guessing', async () => {
  const { TOOLS_BY_NAME } = await import('../src/mcp/tools.ts');
  const listed = TOOLS_BY_NAME.get('list_artifacts')!.handler(
    { learner: learnerId },
    { origin: surface.origin },
  ) as any;
  assert.equal(listed.audio_capture_enabled, true);
  assert.ok(listed.artifacts.length >= 1);

  setSetting('audio_capture', 'false', 'parent');
  const off = TOOLS_BY_NAME.get('list_artifacts')!.handler(
    { learner: learnerId },
    { origin: surface.origin },
  ) as any;
  assert.equal(off.audio_capture_enabled, false);
  assert.match(off.note, /switched off/);
});

test('deleting a recording removes the file, not just the row', () => {
  setSetting('audio_capture', 'true', 'parent');
  const clip = artifacts.saveArtifact(learnerId, {
    kind: 'audio',
    data: CLIP,
    mimeType: 'audio/webm',
  });
  const path = clip.path;
  assert.ok(existsSync(path));

  artifacts.deleteArtifact(clip.id);
  assert.equal(existsSync(path), false, 'deletion must be real deletion');
  assert.equal(artifacts.getArtifact(clip.id), undefined);
});
