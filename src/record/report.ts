import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, one, run, tx, id, now, logEvent, parseJson, primerHome } from '../db/index.ts';
import type { Learner, Mastery } from '../domain/types.ts';
import { ageYears, interests, accommodations } from './learners.ts';
import { statusNow } from './mastery.ts';

/**
 * Parent-facing summary. Deliberately returns data, not prose — the tutor writes
 * the prose, in whatever voice suits the family.
 */
export function progressReport(learnerId: string, sinceDays = 30) {
  const since = `-${sinceDays} days`;

  const learner = one<Learner>(`SELECT * FROM learner WHERE id = ?`, learnerId)!;

  // Status is worked out here, not read from the column. A row written the day a
  // child mastered something still says "mastered" a year later, and that stale
  // word is exactly what would be printed on a parent's page.
  const rows = all<Mastery & { name: string; domain: string }>(
    `SELECT m.*, s.name, s.domain FROM mastery m JOIN skill s ON s.id = m.skill_id
      WHERE m.learner_id = ?`,
    learnerId,
  );
  const now = new Date();
  const live = rows.map((m) => ({ ...m, live_status: statusNow(m, now) }));

  const domains = all<{ domain: string; total: number }>(
    `SELECT domain, count(*) AS total FROM skill GROUP BY domain`,
  );
  const byDomain = domains.map((d) => ({
    domain: d.domain,
    total: d.total,
    mastered: live.filter((m) => m.domain === d.domain && m.live_status === 'mastered').length,
    learning: live.filter((m) => m.domain === d.domain && m.live_status === 'learning').length,
    lapsed: live.filter((m) => m.domain === d.domain && m.live_status === 'lapsed').length,
  }));

  const cutoff = new Date(now.getTime() - sinceDays * 86_400_000).toISOString();
  const newlyMastered = live
    .filter((m) => m.live_status === 'mastered' && (m.last_seen ?? '') > cutoff)
    .sort((a, b) => (b.last_seen ?? '').localeCompare(a.last_seen ?? ''))
    .map((m) => ({ id: m.skill_id, name: m.name, domain: m.domain, last_seen: m.last_seen! }));

  const working = live
    .filter((m) => m.live_status === 'learning')
    .sort((a, b) => b.p_known - a.p_known)
    .slice(0, 12)
    .map((m) => ({
      id: m.skill_id,
      name: m.name,
      domain: m.domain,
      p_known: m.p_known,
      opportunities: m.opportunities,
    }));

  // Things a child once had and has since lost — the cheapest wins available, and
  // the thing a parent most wants to be told about before a teacher notices.
  const slipped = live
    .filter((m) => m.live_status === 'lapsed')
    .map((m) => ({ id: m.skill_id, name: m.name, domain: m.domain }));

  const struggling = all<{ id: string; name: string; p_known: number; opportunities: number }>(
    `SELECT s.id, s.name, m.p_known, m.opportunities
       FROM mastery m JOIN skill s ON s.id = m.skill_id
      WHERE m.learner_id = ? AND m.opportunities >= 6 AND m.p_known < 0.5
      ORDER BY m.opportunities DESC LIMIT 8`,
    learnerId,
  );

  const activity = all<{ day: string; observations: number; sessions: number }>(
    `SELECT date(ts) AS day, count(*) AS observations, count(DISTINCT session_id) AS sessions
       FROM observation
      WHERE learner_id = ? AND ts > datetime('now', ?)
      GROUP BY date(ts) ORDER BY day`,
    learnerId,
    since,
  );

  const totals = one<{ observations: number; sessions: number; minutes: number | null }>(
    `SELECT
       (SELECT count(*) FROM observation WHERE learner_id = ? AND ts > datetime('now', ?)) AS observations,
       (SELECT count(*) FROM session WHERE learner_id = ? AND started_at > datetime('now', ?)) AS sessions,
       (SELECT sum((julianday(coalesce(ended_at, started_at)) - julianday(started_at)) * 1440)
          FROM session WHERE learner_id = ? AND started_at > datetime('now', ?)) AS minutes`,
    learnerId,
    since,
    learnerId,
    since,
    learnerId,
    since,
  );

  const affect = all<{ signal: string; n: number }>(
    `SELECT signal, count(*) AS n FROM affect
      WHERE learner_id = ? AND ts > datetime('now', ?) GROUP BY signal ORDER BY n DESC`,
    learnerId,
    since,
  );

  const artifacts = all<{ id: string; kind: string; caption: string | null; ts: string }>(
    `SELECT id, kind, caption, ts FROM artifact
      WHERE learner_id = ? AND ts > datetime('now', ?) ORDER BY ts DESC LIMIT 10`,
    learnerId,
    since,
  );

  const openMisconceptions = all<{ pattern: string; status: string; seen: number }>(
    `SELECT pattern, status, evidence_count AS seen FROM misconception
      WHERE learner_id = ? AND status != 'resolved' ORDER BY evidence_count DESC`,
    learnerId,
  );

  const resolvedMisconceptions = all<{ pattern: string; last_seen: string }>(
    `SELECT pattern, last_seen FROM misconception
      WHERE learner_id = ? AND status = 'resolved' AND last_seen > datetime('now', ?)`,
    learnerId,
    since,
  );

  return {
    learner: { id: learner.id, name: learner.display_name, age_years: ageYears(learner) },
    window_days: sinceDays,
    totals: {
      observations: totals?.observations ?? 0,
      sessions: totals?.sessions ?? 0,
      minutes: totals?.minutes ? Math.round(totals.minutes) : 0,
    },
    by_domain: byDomain,
    newly_mastered: newlyMastered,
    working_on: working,
    slipped_since_last_practice: slipped,
    needs_a_different_approach: struggling,
    misconceptions: { open: openMisconceptions, resolved_this_window: resolvedMisconceptions },
    affect,
    activity_by_day: activity,
    artifacts,
    interests: interests(learnerId).slice(0, 10).map((i) => ({ topic: i.topic, strength: i.current })),
    accommodations: accommodations(learnerId).map((a) => ({ kind: a.kind, detail: a.detail })),
  };
}

/**
 * The whole record, as JSON. This is the promise the spec makes: the family can
 * take everything and leave at any time.
 */
export function exportRecord(learnerId: string) {
  const tables = [
    'learner',
    'accommodation',
    'interest',
    'goal',
    'note',
    'mastery',
    'session',
    'observation',
    'misconception',
    'affect',
    'interface',
    'artifact',
  ];
  const out: Record<string, unknown> = {
    format: 'open-learner-record',
    schema_version: one<{ value: string }>(`SELECT value FROM meta WHERE key = 'schema_version'`)?.value,
    exported_at: new Date().toISOString(),
  };
  for (const table of tables) {
    const column = table === 'learner' ? 'id' : 'learner_id';
    out[table] = all(`SELECT * FROM ${table} WHERE ${column} = ?`, learnerId);
  }

  // An interface row stores an absolute path on the machine that wrote it. Exported
  // alone, that path means nothing anywhere else, and every activity in the imported
  // record fails to open — a portable record that quietly is not one. Carry the HTML
  // itself. It is a few KB per activity and it is the whole point of the promise.
  for (const row of out['interface'] as Array<Record<string, unknown>>) {
    try {
      row['html'] = readFileSync(String(row['path']), 'utf8');
    } catch {
      row['html'] = null;
    }
  }
  out['curriculum'] = all<{ id: string; probe: string | null }>(`SELECT * FROM skill`).map((s) => ({
    ...s,
    probe: parseJson<unknown>(s.probe, null),
  }));
  out['skill_edges'] = all(`SELECT * FROM skill_edge`);
  out['planned_activity'] = all(
    `SELECT * FROM planned_activity WHERE learner_id = ?`,
    learnerId,
  );
  return out;
}

/**
 * The other half of the promise. Export is worthless if nothing can read it back.
 *
 * A record moves between installs when a family changes tutor, a school hands one
 * over, or a child outgrows one setup. The learner gets a fresh id here and every
 * reference is remapped, so importing the same file twice makes two children
 * rather than silently merging them.
 */
export function importRecord(data: Record<string, any>): {
  learner_id: string;
  name: string;
  rows: Record<string, number>;
  warnings: string[];
} {
  if (data['format'] !== 'open-learner-record') {
    throw new Error('Not an open-learner-record export.');
  }
  const source = data['learner']?.[0];
  if (!source) throw new Error('Export contains no learner.');

  const warnings: string[] = [];
  const rows: Record<string, number> = {};
  const newId = id('lrn');

  const knownSkills = new Set(all<{ id: string }>(`SELECT id FROM skill`).map((s) => s.id));

  const TABLES = [
    'accommodation',
    'interest',
    'goal',
    'note',
    'mastery',
    'session',
    'observation',
    'misconception',
    'affect',
    'interface',
    'artifact',
    'planned_activity',
  ];

  // Every row gets a fresh id, and every reference to a row is rewritten to match.
  // Without this, importing a record that shares an origin with this one collides
  // on primary key and the rows are silently dropped — which looks like a
  // successful import of an empty history.
  const remap = new Map<string, string>([[source.id, newId]]);
  for (const table of TABLES) {
    for (const row of (data[table] ?? []) as Record<string, unknown>[]) {
      const old = row['id'];
      if (typeof old === 'string' && !remap.has(old)) {
        remap.set(old, id(old.includes('_') ? old.slice(0, old.indexOf('_')) : 'row'));
      }
    }
  }
  const REFERENCE_COLUMNS = ['id', 'learner_id', 'session_id', 'interface_id', 'supersedes'];

  tx(() => {
    run(
      `INSERT INTO learner (id, display_name, birth_date, locale, timezone, pronouns, created_at, archived_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      newId,
      source.display_name,
      source.birth_date ?? null,
      source.locale ?? 'en-US',
      source.timezone ?? null,
      source.pronouns ?? null,
      source.created_at ?? now(),
      source.archived_at ?? null,
    );

    for (const table of TABLES) {
      const incoming: Record<string, unknown>[] = data[table] ?? [];
      let written = 0;
      for (const row of incoming) {
        const record: Record<string, unknown> = { ...row, learner_id: newId };

        for (const column of REFERENCE_COLUMNS) {
          const value = record[column];
          if (typeof value === 'string' && remap.has(value)) record[column] = remap.get(value);
        }

        // Evidence about a skill this install has never loaded would be a dangling
        // reference. Keep the observation, drop the pointer, and say so.
        if ('skill_id' in record && record['skill_id'] && !knownSkills.has(record['skill_id'] as string)) {
          warnings.push(`${table}: unknown skill "${record['skill_id']}" — kept, skill link dropped`);
          record['skill_id'] = null;
        }

        // An interface row points at an HTML file on the machine that exported it.
        // Prefer the inlined copy, which travels; fall back to the path, which only
        // works when importing on the same machine.
        if (table === 'interface') {
          const inlined = typeof record['html'] === 'string' ? (record['html'] as string) : null;
          // `html` is carried in the export envelope, not a column on the table.
          delete record['html'];
          const written = inlined
            ? writeInterfaceFile(inlined, String(record['id']))
            : typeof record['path'] === 'string'
              ? adoptInterfaceFile(record['path'], String(record['id']))
              : null;
          if (written) record['path'] = written;
          else warnings.push(`interface "${record['title']}": no HTML in the export, will not open`);
        }

        const columns = Object.keys(record);
        const placeholders = columns.map(() => '?').join(', ');
        try {
          run(
            `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders})`,
            ...columns.map((c) => record[c] ?? null),
          );
          written += 1;
        } catch (err) {
          warnings.push(`${table}: skipped a row — ${(err as Error).message}`);
        }
      }
      rows[table] = written;
    }

    logEvent('import', 'import_record', newId, { name: source.display_name, rows });
  });

  return { learner_id: newId, name: source.display_name, rows, warnings };
}

/** Write an imported interface's inlined HTML into this install. */
function writeInterfaceFile(html: string, newInterfaceId: string): string {
  const dir = join(primerHome(), 'interfaces');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${newInterfaceId}.html`);
  writeFileSync(target, html, 'utf8');
  return target;
}

/** Copy an imported interface's HTML into this install. Returns the new path. */
function adoptInterfaceFile(sourcePath: string, newInterfaceId: string): string | null {
  if (!existsSync(sourcePath)) return null;
  const dir = join(primerHome(), 'interfaces');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, `${newInterfaceId}.html`);
  copyFileSync(sourcePath, target);
  return target;
}
