import { existsSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { all, one, run, tx, id, now, logEvent, parseJson, primerHome } from '../db/index.ts';
import { artifactsDir } from './artifacts.ts';
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
    // The envelope's own version, independent of the SQLite schema version.
    // Bumped when the shape of this file changes in a way an importer must know
    // about. FORMAT.md is the contract; this number is how an importer checks it.
    format_version: 1,
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
  //
  // The prefix of the new id is taken from the old one only after validating it —
  // an import file is an untrusted document, and this string used to flow straight
  // into `id()` and from there into `onclick="...('${id}')"` in the review and
  // progress pages, and into filenames written to disk. A crafted prefix meant
  // stored XSS on the parent's own review page (which runs with `unsafe-inline`)
  // and, separately, a path outside the interfaces directory.
  const safePrefix = (old: string): string => {
    const candidate = old.includes('_') ? old.slice(0, old.indexOf('_')) : old;
    return /^[a-z]{2,8}$/.test(candidate) ? candidate : 'row';
  };
  const remap = new Map<string, string>([[source.id, newId]]);
  for (const table of TABLES) {
    for (const row of (data[table] ?? []) as Record<string, unknown>[]) {
      const old = row['id'];
      if (typeof old === 'string' && !remap.has(old)) {
        remap.set(old, id(safePrefix(old)));
      }
    }
  }
  const REFERENCE_COLUMNS = ['id', 'learner_id', 'session_id', 'interface_id', 'supersedes'];

  // The insert below builds its column list from the keys of each incoming row.
  // Those keys come from the import file too, so without a whitelist an attacker
  // can add a key like `id, learner_id, path) SELECT ... --` and inject SQL through
  // the identifier list — the values are parameterised, the column names were not.
  // Real columns only; anything else is silently dropped rather than failing the
  // whole row, since an export from a newer primer may carry columns this one
  // predates.
  const tableColumns = new Map<string, Set<string>>();
  for (const table of TABLES) {
    tableColumns.set(
      table,
      new Set(all<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => c.name)),
    );
  }

  tx(() => {
    fillCurriculumFromEnvelope(data, knownSkills, rows, warnings);

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
          const landedAt = inlined
            ? writeInterfaceFile(inlined, String(record['id']))
            : typeof record['path'] === 'string'
              ? adoptInterfaceFile(record['path'], String(record['id']))
              : null;
          if (landedAt) record['path'] = landedAt;
          else warnings.push(`interface "${record['title']}": no HTML in the export, will not open`);
        }

        // An artifact row likewise points at a file — a recording — on the machine
        // that exported it. Without this, an imported `path` was stored verbatim:
        // an attacker-supplied export naming an arbitrary file (a tax return, an
        // SSH key) meant that deleting the imported "child" later, via the delete
        // feature that exists specifically to be trustworthy, deleted that file.
        // The rule is the same as for interfaces: copy the real file across if it
        // exists on this machine, otherwise drop the pointer and say so.
        if (table === 'artifact') {
          const source = typeof record['path'] === 'string' ? record['path'] : null;
          const landedAt = source ? adoptArtifactFile(source, String(record['id'])) : null;
          if (landedAt) record['path'] = landedAt;
          else {
            warnings.push(`artifact: source file missing, recording dropped`);
            continue; // an artifact row with no file is not worth keeping
          }
        }

        const allowed = tableColumns.get(table)!;
        const columns = Object.keys(record).filter((c) => allowed.has(c));
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

/**
 * A record must not lose its meaning in transit.
 *
 * The export carries the whole curriculum precisely because `mastery.skill_id`
 * is NOT NULL and `observation.skill_id` is a real foreign key: land this file
 * on an install that never loaded the same packs and, without this, every
 * mastery row on those skills is dropped and every observation loses its link —
 * a child's history on a skill her old install taught quietly evaporates.
 * Filling the gaps from the envelope is what makes the record portable rather
 * than portable-if-you-happen-to-have-the-same-packs.
 *
 * Two deliberate limits:
 *
 * - **The local curriculum always wins.** Only skills this install has never
 *   heard of are inserted. An import must never re-parameterize, rename, or
 *   re-band a skill the local packs define — a record is evidence about one
 *   child, not an authority on the curriculum.
 * - **Edges are only added where at least one endpoint is newly filled.** The
 *   envelope's edge list describes the exporting install's graph; letting it
 *   add edges between two skills this install already has would silently
 *   rewire the local prerequisite graph — including re-adding an edge a local
 *   pack author deliberately removed.
 *
 * Everything is validated before insertion: an import file is an untrusted
 * document, and skill ids flow into DOM ids, SQL identifiers elsewhere, and
 * error messages. An id that fails the pattern is skipped with a warning, and
 * every row that referenced it then takes the existing unknown-skill path.
 */
const SKILL_ID = /^[a-z][a-z0-9_]{1,63}$/;
const SHORT_TOKEN = /^[a-z][a-z0-9_]{0,31}$/;
const EDGE_KINDS = new Set(['prerequisite', 'component', 'extends']);
const clamp01 = (v: unknown, fallback: number): number => {
  const n = typeof v === 'number' ? v : Number.NaN;
  return Number.isFinite(n) && n > 0 && n < 1 ? n : fallback;
};

function fillCurriculumFromEnvelope(
  data: Record<string, any>,
  knownSkills: Set<string>,
  rows: Record<string, number>,
  warnings: string[],
): void {
  const incoming: Record<string, unknown>[] = Array.isArray(data['curriculum'])
    ? data['curriculum']
    : [];
  const filled = new Set<string>();

  for (const s of incoming) {
    const skillId = typeof s['id'] === 'string' ? s['id'] : '';
    if (knownSkills.has(skillId)) continue; // local curriculum wins, always
    if (!SKILL_ID.test(skillId)) {
      if (skillId) warnings.push(`curriculum: skill id "${skillId.slice(0, 40)}" fails validation — skipped`);
      continue;
    }
    const domain = typeof s['domain'] === 'string' && SHORT_TOKEN.test(s['domain']) ? s['domain'] : null;
    const strand = typeof s['strand'] === 'string' && SHORT_TOKEN.test(s['strand']) ? s['strand'] : null;
    const name = typeof s['name'] === 'string' && s['name'].trim() ? s['name'].slice(0, 200) : null;
    if (!domain || !strand || !name) {
      warnings.push(`curriculum: skill "${skillId}" is missing a valid domain, strand, or name — skipped`);
      continue;
    }
    run(
      `INSERT INTO skill (id, domain, strand, name, description, grade_band, ordinal, probe, tags,
                          p_init, p_learn, p_guess, p_slip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      skillId,
      domain,
      strand,
      name,
      typeof s['description'] === 'string' ? s['description'].slice(0, 1000) : null,
      typeof s['grade_band'] === 'string' && /^[a-z0-9]{1,4}$/.test(s['grade_band']) ? s['grade_band'] : null,
      Number.isFinite(Number(s['ordinal'])) ? Math.trunc(Number(s['ordinal'])) : 0,
      // The export parses `probe` into an object so the file is readable; the
      // column stores JSON text.
      s['probe'] == null ? null : JSON.stringify(s['probe']),
      typeof s['tags'] === 'string' ? s['tags'] : Array.isArray(s['tags']) ? JSON.stringify(s['tags']) : null,
      clamp01(s['p_init'], 0.15),
      clamp01(s['p_learn'], 0.2),
      clamp01(s['p_guess'], 0.2),
      clamp01(s['p_slip'], 0.1),
    );
    knownSkills.add(skillId);
    filled.add(skillId);
  }

  let edges = 0;
  const incomingEdges: Record<string, unknown>[] = Array.isArray(data['skill_edges'])
    ? data['skill_edges']
    : [];
  for (const e of incomingEdges) {
    const from = typeof e['from_skill'] === 'string' ? e['from_skill'] : '';
    const to = typeof e['to_skill'] === 'string' ? e['to_skill'] : '';
    const kind = typeof e['kind'] === 'string' ? e['kind'] : 'prerequisite';
    if (!filled.has(from) && !filled.has(to)) continue; // never rewire the local graph
    if (!knownSkills.has(from) || !knownSkills.has(to) || !EDGE_KINDS.has(kind)) continue;
    run(`INSERT OR IGNORE INTO skill_edge (from_skill, to_skill, kind) VALUES (?, ?, ?)`, from, to, kind);
    edges += 1;
  }

  if (filled.size) rows['skills_filled'] = filled.size;
  if (edges) rows['skill_edges_filled'] = edges;
}

/**
 * Resolve `name` under `dir` and refuse anything that would land outside it.
 *
 * `name` is always a freshly generated id here, so this should never fire — it is
 * the second layer, in case a future caller passes something less trustworthy.
 */
function withinDir(dir: string, name: string): string {
  const target = resolve(join(dir, name));
  if (target !== resolve(dir) && !target.startsWith(resolve(dir) + sep)) {
    throw new Error(`refusing to write outside ${dir}: ${name}`);
  }
  return target;
}

/** Write an imported interface's inlined HTML into this install. */
function writeInterfaceFile(html: string, newInterfaceId: string): string {
  const dir = join(primerHome(), 'interfaces');
  mkdirSync(dir, { recursive: true });
  const target = withinDir(dir, `${newInterfaceId}.html`);
  writeFileSync(target, html, 'utf8');
  return target;
}

/** Copy an imported interface's HTML into this install. Returns the new path. */
function adoptInterfaceFile(sourcePath: string, newInterfaceId: string): string | null {
  if (!existsSync(sourcePath)) return null;
  const dir = join(primerHome(), 'interfaces');
  mkdirSync(dir, { recursive: true });
  const target = withinDir(dir, `${newInterfaceId}.html`);
  copyFileSync(sourcePath, target);
  return target;
}

/** Copy an imported artifact's recording into this install. Returns the new path. */
function adoptArtifactFile(sourcePath: string, newArtifactId: string): string | null {
  if (!existsSync(sourcePath)) return null;
  const dir = artifactsDir();
  const ext = sourcePath.slice(sourcePath.lastIndexOf('.'));
  // The extension comes off the source path, so constrain it to something that
  // cannot itself be a traversal (`../../x.html`) or carry a null byte.
  const safeExt = /^\.[a-z0-9]{1,5}$/i.test(ext) ? ext : '.bin';
  const target = withinDir(dir, `${newArtifactId}${safeExt}`);
  copyFileSync(sourcePath, target);
  return target;
}
