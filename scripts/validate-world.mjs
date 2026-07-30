#!/usr/bin/env node
/**
 * Layer 1 of the World admission pipeline: the mechanical checks.
 *
 * Deterministic, no model, no database, no network. Runs in CI on every pull
 * request, human or agent, and fails loudly. The checks are the ones listed
 * in docs/WORLD.md: schema conformance, prerequisite cycle detection,
 * duplicate skill ids, provenance completeness, agreement counts, reading
 * level of child-facing prompt text, and that every skill has assessable
 * success criteria.
 *
 * This script must never import from src/ or open a database. It reads the
 * World and the shipped curriculum JSON as plain files, nothing else. That
 * boundary is pinned in test/invariants.test.ts.
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORLD = join(ROOT, 'world');

const errors = [];
const fail = (file, message) => errors.push(`${relative(ROOT, file)}: ${message}`);

if (!existsSync(WORLD)) {
  console.error('world/ does not exist; nothing to validate');
  process.exit(1);
}

/** Every file under a directory, recursively, ignoring .gitkeep. */
function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === '.gitkeep') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    fail(file, `not valid JSON: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// WORLD_VERSION: a single semver line.
// ---------------------------------------------------------------------------
{
  const file = join(WORLD, 'WORLD_VERSION');
  if (!existsSync(file)) {
    fail(file, 'missing');
  } else {
    const text = readFileSync(file, 'utf8');
    if (!/^\d+\.\d+\.\d+\n?$/.test(text)) {
      fail(file, `must be a single semver line, got ${JSON.stringify(text)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Provenance completeness and agreement counts. Every World entry carries one.
// ---------------------------------------------------------------------------
const REVIEW_STATES = ['unreviewed', 'specialist-reviewed', 'field-tested'];
// The reviewer is a named person. An agent cannot appear in this field.
const AGENT_NAME = /\b(agent|bot|claude|gpt|gemini|llm|model|openclaw|assistant)\b/i;
const REAL_SOURCE = /^(https?:\/\/|doi:10\.|10\.\d)/;

/** All depends_on_claims references, resolved after every claim is parsed. */
const claimRefs = [];

function checkProvenance(prov, file, where) {
  const at = (msg) => fail(file, `${where}: ${msg}`);
  if (!prov || typeof prov !== 'object') return at('missing provenance block');

  const { sources, retrieved, agreement, review, reviewer, depends_on_claims } = prov;

  if (!Array.isArray(sources) || sources.length === 0 || sources.some((s) => typeof s !== 'string' || !s.trim())) {
    at('provenance.sources must be a non-empty array of strings');
  } else {
    const todo = sources.filter((s) => /^TODO\b/.test(s.trim()));
    const real = sources.filter((s) => REAL_SOURCE.test(s.trim()));
    const junk = sources.filter((s) => !/^TODO\b/.test(s.trim()) && !REAL_SOURCE.test(s.trim()));
    for (const s of junk) at(`source ${JSON.stringify(s)} is neither a URL, a DOI, nor an explicit TODO`);
    if (todo.length > 0 && review !== 'unreviewed') {
      at('a TODO source is only honest while review is "unreviewed"');
    }
    // Agreement counts independent sources attesting the claim. Computed, not
    // asserted: mechanically we can at least refuse a count the listed sources
    // cannot support. A TODO attests nothing.
    if (!Number.isInteger(agreement) || agreement < 0) {
      at('provenance.agreement must be a non-negative integer');
    } else if (agreement > new Set(real.map((s) => s.trim())).size) {
      at(`provenance.agreement is ${agreement} but only ${real.length} resolvable sources are listed`);
    }
  }

  if (typeof retrieved !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(retrieved)) {
    at('provenance.retrieved must be a YYYY-MM-DD date');
  }

  if (!REVIEW_STATES.includes(review)) {
    at(`provenance.review must be one of ${REVIEW_STATES.join(', ')}`);
  }

  if (review === 'unreviewed') {
    if (reviewer !== null) at('provenance.reviewer must be null while unreviewed; only a human move sets it');
  } else {
    if (typeof reviewer !== 'string' || !reviewer.trim()) {
      at('a reviewed entry names its reviewer');
    } else if (AGENT_NAME.test(reviewer)) {
      at(`provenance.reviewer ${JSON.stringify(reviewer)} reads like an agent; the reviewer is a named person`);
    }
  }

  if (depends_on_claims !== undefined) {
    if (!Array.isArray(depends_on_claims) || depends_on_claims.some((c) => typeof c !== 'string')) {
      at('provenance.depends_on_claims must be an array of claim ids');
    } else {
      for (const ref of depends_on_claims) claimRefs.push({ ref, file, where });
    }
  }
}

// ---------------------------------------------------------------------------
// Claims: one claim per entry, parsed from world/claims/*.md.
// ---------------------------------------------------------------------------
const claimIds = new Set();
const CLAIM_ID = /^[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/;

for (const file of walk(join(WORLD, 'claims'))) {
  if (!file.endsWith('.md')) {
    fail(file, 'claims are markdown; unexpected file type');
    continue;
  }
  const text = readFileSync(file, 'utf8');
  const sections = text.split(/^## /m).slice(1);
  if (sections.length === 0) {
    fail(file, 'no claim entries (## <claim-id> headings) found');
    continue;
  }
  for (const section of sections) {
    const id = section.slice(0, section.indexOf('\n')).trim();
    const at = (msg) => fail(file, `claim "${id}": ${msg}`);

    if (!CLAIM_ID.test(id)) at('claim id must look like namespace/slug, lowercase');
    if (claimIds.has(id)) at('duplicate claim id');
    claimIds.add(id);

    const claim = section.match(/^\*\*Claim\.\*\* (.+)$/m);
    if (!claim) at('missing a one-line "**Claim.** ..." sentence');
    else if (!claim[1].trim().endsWith('.')) at('the claim must be a sentence');

    const strength = section.match(/^\*\*Strength\.\*\* (\w+)/m);
    if (!strength || !['strong', 'moderate', 'weak'].includes(strength[1])) {
      at('missing "**Strength.** strong|moderate|weak"');
    }

    if (!/^\*\*Depends on this\.\*\* .+$/m.test(section)) {
      at('missing "**Depends on this.** ..." naming what in primer depends on it');
    }

    const fences = [...section.matchAll(/```json\n([\s\S]*?)```/g)];
    if (fences.length !== 1) {
      at(`expected exactly one fenced json provenance block, found ${fences.length}`);
      continue;
    }
    let body;
    try {
      body = JSON.parse(fences[0][1]);
    } catch (e) {
      at(`provenance block is not valid JSON: ${e.message}`);
      continue;
    }
    checkProvenance(body.provenance, file, `claim "${id}"`);
  }
}

// ---------------------------------------------------------------------------
// The shipped curriculum, read as plain JSON, for cross-checks.
// ---------------------------------------------------------------------------
const skillIds = new Map(); // id -> file it was defined in
const prereqEdges = []; // { from, to, file }
const GRADE_BAND = /^(pk|k|[1-9]|1[0-2])$/;

function readPack(file, { world }) {
  const pack = readJson(file);
  if (!pack) return;
  if (typeof pack.domain !== 'string' || !pack.domain.trim()) fail(file, 'pack has no domain');
  if (!Array.isArray(pack.skills)) return fail(file, 'pack has no skills array');

  if (world) checkProvenance(pack.provenance, file, 'pack');

  for (const s of pack.skills) {
    const at = (msg) => fail(file, `skill "${s?.id ?? '?'}": ${msg}`);
    if (typeof s.id !== 'string' || !/^[a-z0-9][a-z0-9_]*$/.test(s.id)) {
      at('skill id must be lowercase snake_case');
      continue;
    }
    if (skillIds.has(s.id)) at(`duplicate skill id, already defined in ${relative(ROOT, skillIds.get(s.id))}`);
    skillIds.set(s.id, file);

    for (const p of s.prereq ?? []) prereqEdges.push({ from: p, to: s.id, file });
    for (const p of s.component_of ?? []) prereqEdges.push({ from: p, to: s.id, file });

    if (!world) continue; // the shipped packs predate these rules; World proposals meet them

    if (typeof s.name !== 'string' || !s.name.trim()) at('skill has no name');
    if (typeof s.strand !== 'string' || !s.strand.trim()) at('skill has no strand');
    if (s.grade_band !== undefined && !GRADE_BAND.test(String(s.grade_band))) {
      at(`grade_band ${JSON.stringify(s.grade_band)} is not a known band`);
    }
    // Assessable success criteria: a probe with a type is how this repository
    // states "here is how you would know". A skill nobody can assess cannot
    // enter the graph.
    if (!s.probe || typeof s.probe !== 'object' || typeof s.probe.type !== 'string') {
      at('every skill needs assessable success criteria: a probe with a type');
    } else {
      checkPromptReadingLevel(s, file);
    }
  }
}

// ---------------------------------------------------------------------------
// Reading level of child-facing prompt text. A grade 1 child cannot be probed
// with grade 6 prose. Flesch-Kincaid grade over the prompt, template
// placeholders stripped, against a cap for the skill's grade band.
// ---------------------------------------------------------------------------
function syllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

function fleschKincaidGrade(text) {
  const clean = text.replace(/\{[^}]*\}/g, 'it');
  const sentences = Math.max(1, (clean.match(/[.!?]+/g) ?? []).length);
  const words = clean.split(/\s+/).filter((w) => /[a-zA-Z]/.test(w));
  if (words.length === 0) return 0;
  const syl = words.reduce((n, w) => n + syllables(w), 0);
  return 0.39 * (words.length / sentences) + 11.8 * (syl / words.length) - 15.59;
}

// A prompt may sit a little above the band, because an adult or the activity
// reads it aloud for the youngest bands. It may not sit years above.
const READING_CAP = { pk: 3, k: 3, 1: 3, 2: 4, 3: 5 };
const capFor = (band) => READING_CAP[band] ?? Number(band) + 2;

function checkPromptReadingLevel(skill, file) {
  const texts = [];
  for (const key of ['prompt', 'follow_up']) {
    if (typeof skill.probe?.[key] === 'string') texts.push(skill.probe[key]);
  }
  for (const t of texts) {
    const grade = fleschKincaidGrade(t);
    const cap = capFor(skill.grade_band ?? 'k');
    if (grade > cap) {
      fail(
        file,
        `skill "${skill.id}": prompt reads at grade ${grade.toFixed(1)}, above the ` +
          `cap of ${cap} for band ${skill.grade_band ?? 'k'}: ${JSON.stringify(t)}`,
      );
    }
  }
}

for (const file of readdirSync(join(ROOT, 'src', 'curriculum')).filter((f) => f.endsWith('.json'))) {
  readPack(join(ROOT, 'src', 'curriculum', file), { world: false });
}
for (const file of walk(join(WORLD, 'curriculum'))) {
  if (file.endsWith('.json')) readPack(file, { world: true });
  else fail(file, 'curriculum proposals are JSON packs; unexpected file type');
}

// Unknown prerequisite references, then cycle detection over the whole graph.
for (const e of prereqEdges) {
  if (!skillIds.has(e.from)) fail(e.file, `"${e.to}" depends on unknown skill "${e.from}"`);
}
{
  const next = new Map();
  for (const e of prereqEdges) {
    if (!next.has(e.from)) next.set(e.from, []);
    next.get(e.from).push(e.to);
  }
  const state = new Map();
  const stack = [];
  const visit = (node) => {
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
    const cycle = visit(node);
    if (cycle) {
      fail(WORLD, `prerequisite cycle: ${cycle.join(' -> ')}`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Priors: parameters a family's fit will start from. Ranges mirror the
// clamps in src/domain/fit.ts, and guess plus slip must stay coherent.
// ---------------------------------------------------------------------------
for (const file of walk(join(WORLD, 'priors'))) {
  if (!file.endsWith('.json')) {
    fail(file, 'priors are JSON; unexpected file type');
    continue;
  }
  const doc = readJson(file);
  if (!doc) continue;
  checkProvenance(doc.provenance, file, 'priors');
  if (!doc.skill_types || typeof doc.skill_types !== 'object' || Object.keys(doc.skill_types).length === 0) {
    fail(file, 'priors carry a non-empty skill_types object');
    continue;
  }
  const claimedProbeTypes = new Map();
  let defaults = 0;
  for (const [name, t] of Object.entries(doc.skill_types)) {
    const at = (msg) => fail(file, `skill_types.${name}: ${msg}`);
    const inRange = (key, lo, hi) => {
      if (typeof t[key] !== 'number' || t[key] < lo || t[key] > hi) {
        at(`${key} must be a number in [${lo}, ${hi}], got ${JSON.stringify(t[key])}`);
        return false;
      }
      return true;
    };
    inRange('p_init', 0.001, 0.999);
    const g = inRange('p_guess', 0.001, 0.5);
    const s = inRange('p_slip', 0.001, 0.3);
    inRange('p_learn', 0.05, 0.5);
    inRange('half_life_days', 0.25, 365);
    // Past this point BKT stops being identifiable and a wrong answer becomes
    // evidence of knowing. fit.ts refuses such a fit; we refuse such a prior.
    if (g && s && t.p_guess + t.p_slip >= 0.95) {
      at(`incoherent: p_guess + p_slip = ${(t.p_guess + t.p_slip).toFixed(2)} >= 0.95`);
    }
    if (!Array.isArray(t.depends_on_claims) || t.depends_on_claims.length === 0) {
      at('every prior links back to the claims it rests on via depends_on_claims');
    } else {
      for (const ref of t.depends_on_claims) claimRefs.push({ ref, file, where: `skill_types.${name}` });
    }
    if (!Array.isArray(t.probe_types) || t.probe_types.some((p) => typeof p !== 'string')) {
      at('probe_types must be an array of strings');
    } else {
      for (const p of t.probe_types) {
        if (claimedProbeTypes.has(p)) at(`probe type "${p}" is already claimed by skill_types.${claimedProbeTypes.get(p)}`);
        claimedProbeTypes.set(p, name);
      }
    }
    if (t.default === true) defaults += 1;
  }
  if (defaults > 1) fail(file, 'at most one skill type may be the default');
}

// ---------------------------------------------------------------------------
// Lenses: mappings over existing skill ids. Never a new skill tree, never a
// change to the mastery model.
// ---------------------------------------------------------------------------
const MODEL_KEYS = ['prereq', 'component_of', 'p_init', 'p_guess', 'p_slip', 'p_learn'];
for (const file of walk(join(WORLD, 'lenses'))) {
  if (!file.endsWith('.json')) {
    fail(file, 'lenses are JSON; unexpected file type');
    continue;
  }
  const doc = readJson(file);
  if (!doc) continue;
  checkProvenance(doc.provenance, file, 'lens');
  if (typeof doc.lens !== 'string' || !doc.lens.trim()) fail(file, 'a lens names itself in a "lens" field');
  if (!Array.isArray(doc.mappings) || doc.mappings.length === 0) {
    fail(file, 'a lens is a non-empty array of mappings over existing skill ids');
    continue;
  }
  for (const m of doc.mappings) {
    if (typeof m.skill_id !== 'string' || !skillIds.has(m.skill_id)) {
      fail(file, `lens maps unknown skill ${JSON.stringify(m.skill_id)}; a lens never invents skills`);
    }
    for (const key of MODEL_KEYS) {
      if (key in m) fail(file, `lens mapping for "${m.skill_id}" carries "${key}"; a lens is a costume, never a model change`);
    }
  }
}

// ---------------------------------------------------------------------------
// Trajectories: path metadata over existing skills.
// ---------------------------------------------------------------------------
for (const file of walk(join(WORLD, 'trajectories'))) {
  if (!file.endsWith('.json')) {
    fail(file, 'trajectories are JSON; unexpected file type');
    continue;
  }
  const doc = readJson(file);
  if (!doc) continue;
  checkProvenance(doc.provenance, file, 'trajectory');
  if (typeof doc.name !== 'string' || !doc.name.trim()) fail(file, 'a trajectory has a name');
  if (!Array.isArray(doc.leans_on) || doc.leans_on.length === 0) {
    fail(file, 'a trajectory lists the existing skills it leans on');
  } else {
    for (const id of doc.leans_on) {
      if (!skillIds.has(id)) fail(file, `trajectory leans on unknown skill ${JSON.stringify(id)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Cross-checks over the whole World.
// ---------------------------------------------------------------------------
for (const { ref, file, where } of claimRefs) {
  if (!claimIds.has(ref)) {
    fail(file, `${where}: depends_on_claims names "${ref}", which no claims file defines`);
  }
}

// No World data structure contains a learner id. The World knows the field;
// only the Record knows the child. Also pinned in test/invariants.test.ts.
for (const file of walk(WORLD)) {
  const text = readFileSync(file, 'utf8');
  if (/\blrn_[a-z0-9]+/i.test(text) || /\blearner_id\b/.test(text)) {
    fail(file, 'contains what looks like a learner id; The World must not know any child');
  }
}

// ---------------------------------------------------------------------------
if (errors.length > 0) {
  console.error(`world validation failed with ${errors.length} error(s):\n`);
  for (const e of errors) console.error(`  ${e}`);
  process.exit(1);
}
console.log(
  `world ok: ${claimIds.size} claims, ${skillIds.size} skills, ` +
    `${prereqEdges.length} edges, version ${readFileSync(join(WORLD, 'WORLD_VERSION'), 'utf8').trim()}`,
);
