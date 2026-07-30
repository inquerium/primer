import { all, one, parseJson } from '../db/index.ts';
import type { Domain, GradeBand, Learner, Mastery, Skill } from './types.ts';
import { retention, TEACHABLE_THRESHOLD } from './bkt.ts';
import { ageYears } from '../record/learners.ts';

/**
 * Cold-start placement: find a child's real starting line instead of assuming it.
 *
 * Every skill starts at p_init and a brand-new record surfaces the roots of the
 * graph, which is right for a four-year-old and absurd for a nine-year-old — she
 * would be offered pencil grip and rhyme recognition on day one and have to grind
 * upward through years of material she walked in knowing. Placement uses the one
 * fact the record already holds (birth date) to pick a sensible first guess, then
 * lets evidence correct it in both directions.
 *
 * Everything here is derived, nothing is stored. Expected bands come from
 * `learner.birth_date`; placement progress comes from the append-only observation
 * table by way of `mastery`. That is not a stylistic preference: `recompute()`
 * replays raw observations and must land on the same state, and an interrupted
 * placement must resume where it left off. Both hold automatically because there
 * is no second copy of the truth to drift.
 *
 * The expected band is a starting guess, never a verdict. A probe the child fails
 * moves the bracket down without comment; the band a child actually works in is
 * whatever the evidence says it is.
 */

export interface ExpectedBands {
  /** One or two bands, low to high. Two when the age sits near a boundary. */
  bands: GradeBand[];
  primary: GradeBand;
  /** True when the child is older than the highest band the curriculum ships.
   *  Says the curriculum tops out, not that the child does. */
  beyond_curriculum: boolean;
}

export type PlacementDomainStatus = 'not_needed' | 'in_progress' | 'settled';

export interface PlacementProbe {
  skill_id: string;
  name: string;
  strand: string;
  grade_band: GradeBand | null;
  /** The skill's item-generation template, so a probe item can be made fresh. */
  probe: unknown;
  why: string;
}

export interface PlacementStatus {
  expected: ExpectedBands;
  domains: Record<
    Domain,
    {
      status: PlacementDomainStatus;
      /** Skills to probe next, most informative first. Empty unless in_progress. */
      probes: PlacementProbe[];
      /** Where evidence currently puts the working edge. Descriptive only. */
      frontier_band: GradeBand | null;
    }
  >;
}

const BAND_RANK: Record<GradeBand, number> = { pk: 0, k: 1, '1': 2, '2': 3, '3': 4 };
const BANDS_BY_RANK: GradeBand[] = ['pk', 'k', '1', '2', '3'];

/** Typical-age spans, US-conventional and deliberately fuzzy at the edges. */
const SPANS: Array<{ band: GradeBand; lo: number; hi: number }> = [
  { band: 'pk', lo: 3, hi: 5 },
  { band: 'k', lo: 5, hi: 6 },
  { band: '1', lo: 6, hi: 7 },
  { band: '2', lo: 7, hi: 8 },
  { band: '3', lo: 8, hi: 9 },
];

/**
 * Half a school year, roughly. A child five months from a band boundary could
 * plausibly be working in either band, so both are offered as starting guesses
 * rather than pretending birthdays are placement tests.
 */
const CUSP_YEARS = 0.4;

/** How many distinct organically-practiced skills make placement unnecessary. */
const SETTLED_EVIDENCE_SKILLS = 5;

/** Enough for one short assess session; the next session gets the next slice. */
const PROBES_PER_DOMAIN = 8;

export function expectedBands(age: number): ExpectedBands {
  const top = SPANS[SPANS.length - 1]!;
  if (age >= top.hi) return { bands: [top.band], primary: top.band, beyond_curriculum: true };
  if (age < SPANS[0]!.lo + CUSP_YEARS) {
    return { bands: ['pk'], primary: 'pk', beyond_curriculum: false };
  }
  const lo = age - CUSP_YEARS;
  const hi = age + CUSP_YEARS;
  const bands = SPANS.filter((s) => s.lo < hi && s.hi > lo).map((s) => s.band);
  const primary = (SPANS.find((s) => age >= s.lo && age < s.hi) ?? SPANS[0]!).band;
  return { bands, primary, beyond_curriculum: false };
}

/** The demonstrated gate, identical to the scheduler's impliedKnown: competence,
 *  not exposure. Two lucky guesses must not place a child. */
function passed(m: Mastery | undefined, at: Date): boolean {
  return Boolean(m && retention(m, at) >= TEACHABLE_THRESHOLD && m.correct >= 2);
}

/** Tried it properly and it did not hold. One miss is noise; two attempts with
 *  belief still below coin-flip is a real "not yet". */
function failed(m: Mastery | undefined, at: Date): boolean {
  return Boolean(m && m.opportunities >= 2 && retention(m, at) < 0.5);
}

interface StrandPlan {
  converged: boolean;
  width: number;
  probes: PlacementProbe[];
}

/**
 * One strand's bisection. Skills arrive in ordinal order — the pack author's
 * teaching order, which is the honest difficulty axis here; grade bands are only
 * fuzzy labels along it (they are not even monotonic in five places, and that is
 * fine). Evidence brackets the child: the highest demonstrated skill below, the
 * lowest failed skill above, next probe at the midpoint. No evidence yet means
 * the first probe goes where the expected band says to guess.
 */
function planStrand(
  skills: Skill[],
  mastery: Map<string, Mastery>,
  expected: ExpectedBands,
  at: Date,
): StrandPlan | null {
  const maxRank = Math.max(...expected.bands.map((b) => BAND_RANK[b]));
  /**
   * Is this skill at or below the expected band's reach? A band this build does
   * not know — possible once `primer import` has filled curriculum from a record
   * written elsewhere — is not placed on this axis at all, so it stays out of the
   * probing range rather than being silently treated as the easiest material.
   */
  const withinReach = (s: Skill): boolean => {
    if (!s.grade_band) return true; // unbanded skills sort with the earliest material
    const rank = BAND_RANK[s.grade_band as GradeBand];
    return rank !== undefined && rank <= maxRank;
  };

  // The ceiling: placement only probes material within the expected band's
  // reach. A child who clears the ceiling is placed; whatever lies above is the
  // normal frontier's job, session by session, with teaching attached.
  let ceiling = -1;
  for (let i = 0; i < skills.length; i++) if (withinReach(skills[i]!)) ceiling = i;
  if (ceiling < 0) return null; // whole strand sits above the expected bands

  let lower = -1; // highest index demonstrated
  for (let i = 0; i <= ceiling; i++) if (passed(mastery.get(skills[i]!.id), at)) lower = i;
  let upper = ceiling + 1; // lowest index above `lower` that failed
  for (let i = lower + 1; i <= ceiling; i++) {
    if (failed(mastery.get(skills[i]!.id), at)) {
      upper = i;
      break;
    }
  }

  if (upper - lower <= 1) return { converged: true, width: 0, probes: [] };

  const toProbe = (s: Skill, why: string): PlacementProbe => ({
    skill_id: s.id,
    name: s.name,
    strand: s.strand,
    grade_band: (s.grade_band as GradeBand | null) ?? null,
    probe: parseJson<unknown>(s.probe, null),
    why,
  });

  const untouched = lower === -1 && upper === ceiling + 1;
  if (untouched) {
    // First contact with this strand: guess from the band, not the midpoint.
    let start = skills.findIndex((s) => expected.bands.includes(s.grade_band as GradeBand));
    if (start < 0 || start > ceiling) start = ceiling; // strand tops out below the band
    const first = skills[start]!;
    const probes = [
      toProbe(
        first,
        `nothing on record for ${first.strand} yet — at this age, start around ` +
          `${bandLabel(first.grade_band)} material`,
      ),
    ];
    const below = Math.floor(start / 2);
    if (below < start) {
      probes.push(
        toProbe(skills[below]!, `a step below "${first.name}", in case that starting guess is too high`),
      );
    }
    return { converged: false, width: upper - lower, probes };
  }

  const mid = Math.floor((lower + upper) / 2);
  const midSkill = skills[mid]!;
  const lowName = lower >= 0 ? `"${skills[lower]!.name}" (demonstrated)` : 'the start of the strand';
  const highName = upper <= ceiling ? `"${skills[upper]!.name}" (not yet)` : 'the top of the expected band';
  const probes = [toProbe(midSkill, `midpoint between ${lowName} and ${highName}`)];
  const stepDown = Math.floor((lower + mid) / 2);
  if (stepDown > lower && stepDown < mid) {
    probes.push(toProbe(skills[stepDown]!, `a step below "${midSkill.name}", to tighten the bracket faster`));
  }
  return { converged: false, width: upper - lower, probes };
}

export function bandLabel(band: string | null): string {
  if (band === 'pk') return 'pre-kindergarten';
  if (band === 'k') return 'kindergarten';
  if (band === '1') return 'first-grade';
  if (band === '2') return 'second-grade';
  if (band === '3') return 'third-grade';
  return 'early';
}

/**
 * Where placement stands for this child, computed fresh from evidence.
 *
 * Null when placement does not apply: no birth date on record, or an expected
 * band of pre-K/K — for the youngest children the roots of the graph *are* the
 * starting line, and today's behavior is already right for them.
 */
export function placementStatus(learnerId: string, at = new Date()): PlacementStatus | null {
  const learner = one<Learner>(`SELECT * FROM learner WHERE id = ?`, learnerId);
  if (!learner) return null;
  const age = ageYears(learner, at);
  if (age == null) return null;
  const expected = expectedBands(age);
  if (expected.primary === 'pk' || expected.primary === 'k') return null;

  const skills = all<Skill>(`SELECT * FROM skill ORDER BY domain, strand, ordinal`);
  const mastery = new Map(
    all<Mastery>(`SELECT * FROM mastery WHERE learner_id = ?`, learnerId).map((m) => [m.skill_id, m]),
  );

  // "Does this child need placing at all?" is judged on organic evidence only —
  // real practice, not the probes placement itself generates. Without this
  // distinction, round one of probing would immediately convince the engine the
  // child has an established record and placement would cancel itself mid-way.
  const organic = new Map(
    all<{ domain: Domain; n: number }>(
      `SELECT s.domain AS domain, count(DISTINCT o.skill_id) AS n
         FROM observation o JOIN skill s ON s.id = o.skill_id
        WHERE o.learner_id = ? AND o.correct IS NOT NULL AND o.kind != 'probe'
          AND o.id NOT IN (SELECT supersedes FROM observation WHERE supersedes IS NOT NULL)
        GROUP BY s.domain`,
      learnerId,
    ).map((r) => [r.domain, r.n]),
  );

  const byDomainStrand = new Map<Domain, Map<string, Skill[]>>();
  for (const s of skills) {
    const strands = byDomainStrand.get(s.domain) ?? new Map<string, Skill[]>();
    byDomainStrand.set(s.domain, strands);
    const list = strands.get(s.strand) ?? [];
    list.push(s);
    strands.set(s.strand, list);
  }

  const domains = {} as PlacementStatus['domains'];
  for (const domain of ['reading', 'writing', 'math'] as Domain[]) {
    const strands = byDomainStrand.get(domain) ?? new Map<string, Skill[]>();

    // Descriptive frontier: the highest band this child has demonstrated in.
    let frontierRank = -1;
    for (const list of strands.values()) {
      for (const s of list) {
        if (passed(mastery.get(s.id), at)) frontierRank = Math.max(frontierRank, rankToBand(s));
      }
    }
    const frontier_band = frontierRank < 0 ? null : BANDS_BY_RANK[frontierRank]!;

    if ((organic.get(domain) ?? 0) >= SETTLED_EVIDENCE_SKILLS) {
      domains[domain] = { status: 'not_needed', probes: [], frontier_band };
      continue;
    }

    const plans = [...strands.values()]
      .map((list) => planStrand(list, mastery, expected, at))
      .filter((p): p is StrandPlan => p !== null);
    const open = plans.filter((p) => !p.converged);

    if (!open.length) {
      domains[domain] = { status: 'settled', probes: [], frontier_band };
      continue;
    }

    // Coverage before refinement: every open strand gets its first probe before
    // any strand gets a second, widest brackets first — one short session should
    // sketch the whole domain, not map one strand precisely.
    open.sort((a, b) => b.width - a.width);
    const probes = [
      ...open.map((p) => p.probes[0]!),
      ...open.map((p) => p.probes[1]).filter((p): p is PlacementProbe => Boolean(p)),
    ].slice(0, PROBES_PER_DOMAIN);

    domains[domain] = { status: 'in_progress', probes, frontier_band };
  }

  return { expected, domains };
}

/**
 * Rank of a skill's band, or -1 if the band is one this build does not know.
 *
 * A grade_band is not always one of the five: `primer import` fills missing
 * curriculum from the envelope, and a record written by a fork or a later primer
 * can carry a band this build has never heard of. Reading BAND_RANK blindly then
 * yields `undefined`, `Math.max(n, undefined)` is NaN, and `BANDS_BY_RANK[NaN]`
 * is `undefined` — so `frontier_band` ends up undefined while its type says
 * `GradeBand | null`. Unknown bands are simply not rankable on this axis, which
 * is exactly what -1 means everywhere else here.
 */
function rankToBand(s: Skill): number {
  if (!s.grade_band) return 0;
  const rank = BAND_RANK[s.grade_band as GradeBand];
  return rank === undefined ? -1 : rank;
}
