/**
 * Find stable wrong models in the evidence.
 *
 * SPEC.md calls `misconception` the single highest-value thing in the record:
 * what a great tutor carries in their head about a student and what every
 * worksheet app throws away. Until now the only way one arrived was a model
 * noticing it in passing, or a generated activity happening to call
 * `primer.misconception(...)`. Nothing read the evidence.
 *
 * The evidence is there. Every observation stores `item`, `response` and
 * `expected` precisely so the wrongness is inspectable later, and a wrong answer
 * that is wrong the same way eight times is not eight mistakes. It is one model,
 * applied consistently.
 *
 * ## What this deliberately does not do
 *
 * It does not write to the record, and nothing calls it from the tutor's loop
 * yet. Whether a detected candidate should be surfaced to the tutor, shown to a
 * parent, or written as a `misconception` row is a human-in-the-loop decision
 * with a boundary in it, not a consequence of this file existing. A detector
 * that silently writes its guesses into a child's permanent record is a
 * different and worse thing than a detector.
 *
 * ## What it detects
 *
 * One class, honestly: a recurring single-character substitution between what
 * was expected and what the child produced. That is narrow, and it covers the
 * case that matters most in early reading, where a child maps one grapheme onto
 * another sound consistently and every downstream skill inherits the error.
 *
 * Other classes exist (transposition, omission, off-by-one in arithmetic,
 * place-value inversion) and are not implemented. An empty result means this
 * detector found nothing, never that the child holds no misconception.
 */

import { all } from '../db/index.ts';

export interface SubstitutionEvidence {
  skill_id: string;
  item: string;
  response: string;
  expected: string;
  ts: string;
}

export interface MisconceptionCandidate {
  kind: 'substitution';
  /** Plain language, for a human. Never an id, never a code. */
  pattern: string;
  from: string;
  to: string;
  skill_ids: string[];
  occurrences: number;
  distinct_items: number;
  /** Share of this learner's readable wrong answers that this one rule explains. */
  share: number;
  confidence: number;
  evidence: SubstitutionEvidence[];
}

export interface MineOptions {
  /** A rule seen twice is a coincidence. Default 3. */
  minOccurrences?: number;
  /** The same word missed three times is one word, not a model. Default 3. */
  minDistinctItems?: number;
  /** How much of the readable wrongness the rule must explain. Default 0.4. */
  minShare?: number;
}

/**
 * The one substitution that turns `expected` into `response`, or null.
 *
 * Equal lengths only. An answer of a different length is a different kind of
 * error (an omission, an insertion, a guess at a different word), and folding
 * those in here would produce a rule that explains everything and predicts
 * nothing.
 */
export function singleSubstitution(
  expected: string,
  response: string,
): { from: string; to: string; index: number } | null {
  if (expected.length !== response.length || !expected.length) return null;
  let found: { from: string; to: string; index: number } | null = null;
  for (let i = 0; i < expected.length; i++) {
    if (expected[i] === response[i]) continue;
    if (found) return null; // more than one character differs
    found = { from: expected[i]!, to: response[i]!, index: i };
  }
  return found;
}

/**
 * Mine one learner's evidence for recurring substitutions.
 *
 * Reads only. Superseded observations are excluded, because a corrected attempt
 * is not evidence of a standing model.
 */
export function mineMisconceptions(
  learnerId: string,
  opts: MineOptions = {},
): MisconceptionCandidate[] {
  const minOccurrences = opts.minOccurrences ?? 3;
  const minDistinctItems = opts.minDistinctItems ?? 3;
  const minShare = opts.minShare ?? 0.4;

  const wrong = all<{
    skill_id: string;
    item: string | null;
    response: string | null;
    expected: string | null;
    ts: string;
  }>(
    `SELECT skill_id, item, response, expected, ts FROM observation
      WHERE learner_id = ? AND correct IS NOT NULL AND correct < 0.6
        AND response IS NOT NULL AND expected IS NOT NULL AND skill_id IS NOT NULL
        AND id NOT IN (SELECT supersedes FROM observation WHERE supersedes IS NOT NULL)
      ORDER BY ts ASC`,
    learnerId,
  );

  // The denominator is readable wrong answers, not all of them. A child whose
  // interface recorded no response text has evidence this cannot read, and
  // counting those against the rule would make every detector look weak on
  // exactly the records where it has the least to go on.
  const readable = wrong.filter(
    (w) => singleSubstitution(String(w.expected), String(w.response)) !== null,
  );
  if (!readable.length) return [];

  const groups = new Map<string, SubstitutionEvidence[]>();
  for (const w of readable) {
    const sub = singleSubstitution(String(w.expected), String(w.response))!;
    const key = `${sub.from}->${sub.to}`;
    const list = groups.get(key) ?? [];
    list.push({
      skill_id: w.skill_id,
      item: String(w.item ?? w.expected),
      response: String(w.response),
      expected: String(w.expected),
      ts: w.ts,
    });
    groups.set(key, list);
  }

  const candidates: MisconceptionCandidate[] = [];
  for (const [key, evidence] of groups) {
    const [from, to] = key.split('->') as [string, string];
    const distinctItems = new Set(evidence.map((e) => e.item)).size;
    const share = evidence.length / readable.length;

    if (evidence.length < minOccurrences) continue;
    if (distinctItems < minDistinctItems) continue;
    if (share < minShare) continue;

    const skillIds = [...new Set(evidence.map((e) => e.skill_id))].sort();

    candidates.push({
      kind: 'substitution',
      pattern: describe(from, to, evidence),
      from,
      to,
      skill_ids: skillIds,
      occurrences: evidence.length,
      distinct_items: distinctItems,
      share: Number(share.toFixed(3)),
      // Evidence count, breadth of items, and breadth of skills all raise it.
      // A rule that holds across two skills is a model; one confined to a single
      // skill may be that skill being taught badly.
      confidence: Number(
        Math.min(
          0.95,
          0.3 +
            0.4 * Math.min(1, evidence.length / 8) +
            0.15 * Math.min(1, distinctItems / 6) +
            0.1 * Math.min(1, (skillIds.length - 1) / 2),
        ).toFixed(3),
      ),
      evidence: evidence.slice(0, 12),
    });
  }

  return candidates.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Say it the way a teacher would to another adult, not the way the table stores
 * it. This string is the one thing here a parent might ever read.
 */
function describe(from: string, to: string, evidence: SubstitutionEvidence[]): string {
  const sample = evidence
    .slice(0, 3)
    .map((e) => `${e.expected} read as ${e.response}`)
    .join(', ');
  return `Reads "${from}" as "${to}" (${sample})`;
}
