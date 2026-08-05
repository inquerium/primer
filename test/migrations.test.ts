import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');

test('the artifact migration upgrades a record from before artifacts existed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'primer-pre-artifact-'));
  const database = new DatabaseSync(join(dir, 'record.db'));
  try {
    // This is the only dependency 003 has after 002. The record is otherwise an
    // old baseline where audio artifacts had never been introduced.
    database.exec('CREATE TABLE setting (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT)');
    database.exec(readFileSync(join(ROOT, 'src/db/migrations/003_artifacts.sql'), 'utf8'));

    const columns = database
      .prepare('SELECT name FROM pragma_table_info(\'artifact\') ORDER BY name')
      .all() as { name: string }[];
    assert.deepEqual(
      columns.map((column) => column.name),
      ['bytes', 'caption', 'duration_ms', 'id', 'kind', 'learner_id', 'mime', 'mime_type', 'path', 'prompt', 'reviewed_at', 'reviewed_by', 'session_id', 'skill_ids', 'transcript', 'ts'],
    );
  } finally {
    database.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
