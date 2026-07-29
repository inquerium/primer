import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Deleting a child has to be real, because the promise made about it is the
 * strongest one in this project: that a family can take their child back out.
 *
 * The failure this guards against is quiet and total. `DELETE FROM learner`
 * cascades through every table and looks like success — while the audio of a
 * six-year-old reading aloud stays on disk, now with nothing in the record that
 * even names it. Rows are not the sensitive part. Files are.
 */

const home = mkdtempSync(join(tmpdir(), 'primer-forget-'));
process.env.PRIMER_HOME = home;
process.env.PRIMER_DB = join(home, 'record.db');

const { db, closeDb, all } = await import('../src/db/index.ts');
const { loadCurriculum } = await import('../src/curriculum/load.ts');
const { createLearner, forgetLearner, listLearners } = await import('../src/record/learners.ts');
const { saveInterface } = await import('../src/surface/store.ts');
const { saveArtifact, artifactsDir } = await import('../src/record/artifacts.ts');
const { startSession, recordObservations } = await import('../src/record/observations.ts');

const CLIP = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x00, 0x00, 0x00]);

let doomed = '';
let sibling = '';
let doomedFiles: string[] = [];
let siblingFiles: string[] = [];

/** Give a child a full life: a session, evidence, an activity, and a recording. */
function populate(name: string): { id: string; files: string[] } {
  const learner = createLearner({ display_name: name });
  const session = startSession(learner.id, { channel: 'test' });
  recordObservations(learner.id, [
    { session_id: session.id, skill_id: 'cc_count_to_10', correct: 1, source: 'test' },
  ]);
  const iface = saveInterface(learner.id, {
    title: `${name}'s activity`,
    html: '<!doctype html><html><head></head><body><script>primer.observe({})</script></body></html>',
  });
  const artifact = saveArtifact(learner.id, {
    kind: 'audio',
    data: CLIP,
    mimeType: 'audio/webm',
    session_id: session.id,
  });
  return { id: learner.id, files: [iface.path, artifact.path] };
}

before(() => {
  db();
  loadCurriculum();
  const a = populate('Doomed Child');
  const b = populate('Sibling');
  doomed = a.id;
  doomedFiles = a.files;
  sibling = b.id;
  siblingFiles = b.files;
});

after(() => {
  closeDb();
  rmSync(home, { recursive: true, force: true });
});

test('the files exist before the deletion, or this test proves nothing', () => {
  for (const path of [...doomedFiles, ...siblingFiles]) {
    assert.ok(existsSync(path), `${path} should exist before we delete anything`);
  }
});

test('deleting a child removes their recordings and activities from disk', () => {
  const result = forgetLearner(doomed);

  assert.equal(result.artifacts, 1, 'should report the recording it removed');
  assert.equal(result.interfaces, 1, 'should report the activity it removed');
  assert.deepEqual(result.files_left_behind, [], 'nothing should have resisted deletion');

  for (const path of doomedFiles) {
    assert.ok(
      !existsSync(path),
      `${path} is still on disk after deletion — a child's voice outlived their record`,
    );
  }
});

test('every row belonging to that child is gone too', () => {
  assert.equal(all(`SELECT id FROM learner WHERE id = ?`, doomed).length, 0);
  assert.equal(all(`SELECT id FROM artifact WHERE learner_id = ?`, doomed).length, 0);
  assert.equal(all(`SELECT id FROM interface WHERE learner_id = ?`, doomed).length, 0);
  assert.equal(all(`SELECT id FROM session WHERE learner_id = ?`, doomed).length, 0);
  assert.equal(all(`SELECT skill_id FROM mastery WHERE learner_id = ?`, doomed).length, 0);
  // The observation hangs off the session, so this is the cascade reaching two deep.
  const orphans = all(
    `SELECT o.id FROM observation o LEFT JOIN session s ON o.session_id = s.id WHERE s.id IS NULL`,
  );
  assert.equal(orphans.length, 0, 'observations survived their session');
});

test('a sibling on the same install is untouched', () => {
  // Everything lives in one directory keyed by id, so an over-broad delete —
  // clearing the artifacts directory, say — would take the other child with it.
  assert.equal(listLearners().length, 1);
  for (const path of siblingFiles) {
    assert.ok(existsSync(path), `deleting one child removed ${path} from another`);
  }
  assert.equal(all(`SELECT id FROM artifact WHERE learner_id = ?`, sibling).length, 1);
});

test('nothing anonymous is left in the artifacts directory', () => {
  // A file whose row is gone can never be found, reviewed, or deleted again.
  const onDisk = readdirSync(artifactsDir());
  const known = new Set(
    all<{ path: string }>(`SELECT path FROM artifact`).map((r) => r.path.split(/[\\/]/).pop()),
  );
  const orphaned = onDisk.filter((f) => !known.has(f));
  assert.deepEqual(orphaned, [], 'unreferenced recordings are left on disk');
});

test('the event log records the deletion without re-recording the child', () => {
  const events = all<{ actor: string; payload: string | null }>(
    `SELECT actor, payload FROM event_log WHERE action = 'delete_learner'`,
  );
  assert.equal(events.length, 1);
  assert.doesNotMatch(
    events[0]!.payload ?? '',
    /Doomed Child/,
    'the audit trail became the last place the deleted child is named',
  );
});
