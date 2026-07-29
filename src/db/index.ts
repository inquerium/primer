import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { SCHEMA_SQL, MIGRATIONS } from '../generated/assets.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SCHEMA_VERSION = '0.1';

/** Where the record lives. Override with PRIMER_HOME. */
export function primerHome(): string {
  return process.env.PRIMER_HOME
    ? resolve(process.env.PRIMER_HOME)
    : join(homedir(), '.primer');
}

export function dbPath(): string {
  return process.env.PRIMER_DB ? resolve(process.env.PRIMER_DB) : join(primerHome(), 'record.db');
}

let cached: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (cached) return cached;
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const handle = new DatabaseSync(path);
  migrate(handle);
  cached = handle;
  return handle;
}

export function closeDb(): void {
  if (cached) {
    cached.close();
    cached = null;
  }
}

/**
 * Disk first so an edit in a checkout takes effect immediately; the embedded copy
 * otherwise, so primer still starts when there is no source tree beside it.
 */
function schemaSql(): string {
  for (const candidate of [join(HERE, 'schema.sql'), join(HERE, '..', '..', 'src', 'db', 'schema.sql')]) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf8');
  }
  return SCHEMA_SQL;
}

function migrationsDir(): string | null {
  for (const candidate of [
    join(HERE, 'migrations'),
    join(HERE, '..', '..', 'src', 'db', 'migrations'),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Forward-only migrations, applied in filename order, each in its own transaction.
 *
 * A record meant to last a childhood will outlive several versions of this code.
 * The baseline schema is `schema.sql`; every change after it is a numbered file
 * that is applied once and recorded. Nothing here ever drops a column — a
 * destructive change is a major version and a written migration path.
 */
function migrate(handle: DatabaseSync): void {
  handle.exec(schemaSql());
  handle.exec(
    `CREATE TABLE IF NOT EXISTS applied_migration (
       name TEXT PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );

  const dir = migrationsDir();
  {
    const applied = new Set(
      (handle.prepare(`SELECT name FROM applied_migration`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    const pending: Array<[string, string]> = dir
      ? readdirSync(dir)
          .filter((f) => f.endsWith('.sql'))
          .sort()
          .map((name) => [name, readFileSync(join(dir, name), 'utf8')])
      : MIGRATIONS.map(([name, body]) => [name, body]);

    for (const [file, sql] of pending) {
      if (applied.has(file)) continue;
      handle.exec('BEGIN');
      try {
        handle.exec(sql);
        handle
          .prepare(`INSERT INTO applied_migration (name, applied_at) VALUES (?, ?)`)
          .run(file, new Date().toISOString());
        handle.exec('COMMIT');
      } catch (err) {
        handle.exec('ROLLBACK');
        throw new Error(`primer: migration ${file} failed — ${(err as Error).message}`);
      }
    }
  }

  const row = handle
    .prepare(`SELECT value FROM meta WHERE key = 'schema_version'`)
    .get() as { value: string } | undefined;
  if (!row) {
    handle
      .prepare(`INSERT INTO meta (key, value) VALUES ('schema_version', ?)`)
      .run(SCHEMA_VERSION);
  } else if (row.value !== SCHEMA_VERSION) {
    handle
      .prepare(`UPDATE meta SET value = ? WHERE key = 'schema_version'`)
      .run(SCHEMA_VERSION);
  }
}

/* --------------------------------------------------------------- helpers -- */

export function now(): string {
  return new Date().toISOString();
}

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

export function one<T>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): void {
  db()
    .prepare(sql)
    .run(...(params as never[]));
}

export function tx<T>(fn: () => T): T {
  const handle = db();
  handle.exec('BEGIN');
  try {
    const out = fn();
    handle.exec('COMMIT');
    return out;
  } catch (err) {
    handle.exec('ROLLBACK');
    throw err;
  }
}

export function logEvent(
  actor: string,
  action: string,
  target?: string | null,
  payload?: unknown,
): void {
  run(
    `INSERT INTO event_log (ts, actor, action, target, payload) VALUES (?, ?, ?, ?, ?)`,
    now(),
    actor,
    action,
    target ?? null,
    payload === undefined ? null : JSON.stringify(payload),
  );
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
