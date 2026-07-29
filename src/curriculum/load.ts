import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, tx, logEvent, all } from '../db/index.ts';
import type { Domain, GradeBand } from '../domain/types.ts';
import { CURRICULUM } from '../generated/assets.ts';

const HERE = dirname(fileURLToPath(import.meta.url));

interface SkillDef {
  id: string;
  strand: string;
  name: string;
  description?: string;
  grade_band?: GradeBand;
  ordinal?: number;
  prereq?: string[];
  component_of?: string[];
  probe?: unknown;
  tags?: string[];
  p_init?: number;
  p_learn?: number;
  p_guess?: number;
  p_slip?: number;
}

interface Pack {
  domain: Domain;
  version?: string;
  note?: string;
  skills: SkillDef[];
}

/** Where the skill packs live in a checkout, or null when there is no source tree. */
export function curriculumDir(): string | null {
  for (const candidate of [HERE, join(HERE, '..', '..', 'src', 'curriculum')]) {
    if (existsSync(join(candidate, 'reading.json'))) return candidate;
  }
  return null;
}

/**
 * Disk first, so editing a skill file in a checkout takes effect straight away —
 * that is the loop a curriculum contributor works in. The embedded copies are the
 * fallback for an install with no source beside it.
 */
export function readPacks(dir = curriculumDir()): Pack[] {
  if (dir) {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Pack);
  }
  return CURRICULUM.map(([, body]) => JSON.parse(body) as Pack);
}

export interface LoadResult {
  skills: number;
  edges: number;
  packs: string[];
  warnings: string[];
}

/**
 * Load skill packs into the record. Idempotent: re-running updates definitions
 * in place and never touches a learner's mastery or evidence.
 */
export function loadCurriculum(dirOrPacks?: string | Pack[]): LoadResult {
  const packs =
    Array.isArray(dirOrPacks) ? dirOrPacks : readPacks(dirOrPacks ? resolve(dirOrPacks) : undefined);

  const seen = new Map<string, SkillDef>();
  for (const pack of packs) {
    for (const s of pack.skills) {
      if (seen.has(s.id)) throw new Error(`Duplicate skill id "${s.id}"`);
      seen.set(s.id, s);
    }
  }

  const warnings: string[] = [];
  let edges = 0;

  tx(() => {
    for (const pack of packs) {
      for (const s of pack.skills) {
        run(
          `INSERT INTO skill
             (id, domain, strand, name, description, grade_band, ordinal, probe, tags,
              p_init, p_learn, p_guess, p_slip)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             domain = excluded.domain, strand = excluded.strand, name = excluded.name,
             description = excluded.description, grade_band = excluded.grade_band,
             ordinal = excluded.ordinal, probe = excluded.probe, tags = excluded.tags,
             p_init = excluded.p_init, p_learn = excluded.p_learn,
             p_guess = excluded.p_guess, p_slip = excluded.p_slip`,
          s.id,
          pack.domain,
          s.strand,
          s.name,
          s.description ?? null,
          s.grade_band ?? null,
          s.ordinal ?? 0,
          s.probe === undefined ? null : JSON.stringify(s.probe),
          s.tags ? JSON.stringify(s.tags) : null,
          s.p_init ?? 0.15,
          s.p_learn ?? 0.2,
          s.p_guess ?? 0.2,
          s.p_slip ?? 0.1,
        );
      }
    }

    // Edges second: prerequisites cross domain files (spelling depends on phonics).
    for (const pack of packs) {
      for (const s of pack.skills) {
        for (const [kind, list] of [
          ['prerequisite', s.prereq ?? []],
          ['component', s.component_of ?? []],
        ] as const) {
          for (const parent of list) {
            if (!seen.has(parent)) {
              warnings.push(`${s.id}: unknown ${kind} "${parent}" — skipped`);
              continue;
            }
            run(
              `INSERT OR IGNORE INTO skill_edge (from_skill, to_skill, kind) VALUES (?, ?, ?)`,
              parent,
              s.id,
              kind,
            );
            edges++;
          }
        }
      }
    }
    logEvent('cli', 'load_curriculum', null, { skills: seen.size, edges });
  });

  const cycle = findCycle();
  if (cycle) warnings.push(`Prerequisite cycle: ${cycle.join(' -> ')}`);

  return {
    skills: seen.size,
    edges,
    // Two packs can share a domain and version — K-2 math and grade-3 math do —
    // so the count is what distinguishes them. Without it the output reads as if
    // the same pack were loaded twice, which is what a duplicate-load bug would
    // also look like.
    packs: packs.map((p) => `${p.domain}@${p.version ?? '0'} (${p.skills.length} skills)`),
    warnings,
  };
}

/** A cycle in prerequisites would make part of the graph permanently unteachable. */
export function findCycle(): string[] | null {
  const edges = all<{ from_skill: string; to_skill: string }>(
    `SELECT from_skill, to_skill FROM skill_edge WHERE kind = 'prerequisite'`,
  );
  const next = new Map<string, string[]>();
  for (const e of edges) {
    const list = next.get(e.from_skill) ?? [];
    list.push(e.to_skill);
    next.set(e.from_skill, list);
  }

  const state = new Map<string, number>(); // 0 unvisited, 1 in stack, 2 done
  const stack: string[] = [];

  const visit = (node: string): string[] | null => {
    const s = state.get(node) ?? 0;
    if (s === 1) return [...stack.slice(stack.indexOf(node)), node];
    if (s === 2) return null;
    state.set(node, 1);
    stack.push(node);
    for (const child of next.get(node) ?? []) {
      const found = visit(child);
      if (found) return found;
    }
    stack.pop();
    state.set(node, 2);
    return null;
  };

  for (const node of next.keys()) {
    const found = visit(node);
    if (found) return found;
  }
  return null;
}
