import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyEvidence,
  bktUpdate,
  effectiveCorrect,
  retrievability,
  statusOf,
  nextDue,
  DEFAULT_PARAMS,
  type MasteryState,
} from '../src/domain/bkt.ts';

const fresh = (): MasteryState => ({
  p_known: 0.15,
  opportunities: 0,
  correct: 0,
  streak: 0,
  half_life_days: 3,
  last_seen: null,
});

test('a correct answer raises belief, a wrong one lowers it', () => {
  const up = bktUpdate(0.5, 1, DEFAULT_PARAMS);
  const down = bktUpdate(0.5, 0, DEFAULT_PARAMS);
  assert.ok(up > 0.5, `expected rise, got ${up}`);
  assert.ok(down < 0.5, `expected fall, got ${down}`);
});

test('hints discount the credit for a correct answer', () => {
  assert.equal(effectiveCorrect({ correct: 1 }), 1);
  assert.ok(effectiveCorrect({ correct: 1, hint_count: 1 }) < 1);
  assert.ok(
    effectiveCorrect({ correct: 1, hint_count: 2 }) < effectiveCorrect({ correct: 1, hint_count: 1 }),
  );
});

test('slow retrieval counts for less than fluent retrieval', () => {
  const fast = effectiveCorrect({ correct: 1, latency_ms: 1000, fluent_ms: 3000 });
  const slow = effectiveCorrect({ correct: 1, latency_ms: 12000, fluent_ms: 3000 });
  assert.equal(fast, 1);
  assert.ok(slow < fast);
});

test('repeated success reaches mastery; a wrong answer sets it back', () => {
  let state = fresh();
  const at = (i: number) => new Date(Date.UTC(2026, 0, 1 + i));
  for (let i = 0; i < 8; i++) {
    state = applyEvidence(state, { correct: 1, at: at(i) }, DEFAULT_PARAMS);
  }
  assert.ok(state.p_known > 0.95, `p_known was ${state.p_known}`);
  assert.equal(statusOf(state, at(8)), 'mastered');

  const after = applyEvidence(state, { correct: 0, at: at(9) }, DEFAULT_PARAMS);
  assert.ok(after.p_known < state.p_known);
  assert.equal(after.streak, 0);
});

test('knowledge decays with time away from practice', () => {
  assert.equal(retrievability(0.9, 3, 0), 0.9);
  assert.ok(Math.abs(retrievability(0.9, 3, 3) - 0.45) < 1e-9);
  assert.ok(retrievability(0.9, 3, 30) < 0.01);
});

test('a long gap before a correct answer grows the interval more than a short one', () => {
  const base = { ...fresh(), p_known: 0.8, opportunities: 3, correct: 3, last_seen: '2026-01-01T00:00:00.000Z' };
  const soon = applyEvidence(base, { correct: 1, at: new Date('2026-01-01T01:00:00.000Z') }, DEFAULT_PARAMS);
  const later = applyEvidence(base, { correct: 1, at: new Date('2026-01-06T00:00:00.000Z') }, DEFAULT_PARAMS);
  assert.ok(
    later.half_life_days > soon.half_life_days,
    `${later.half_life_days} should exceed ${soon.half_life_days}`,
  );
});

test('mastered knowledge that has decayed reads as lapsed, not mastered', () => {
  let state = fresh();
  for (let i = 0; i < 8; i++) {
    state = applyEvidence(state, { correct: 1, at: new Date(Date.UTC(2026, 0, 1 + i)) }, DEFAULT_PARAMS);
  }
  assert.equal(statusOf(state, new Date(Date.UTC(2026, 0, 9))), 'mastered');
  assert.equal(statusOf(state, new Date(Date.UTC(2027, 0, 9))), 'lapsed');
});

test('next review is scheduled before the knowledge is half gone', () => {
  const state = { ...fresh(), half_life_days: 10, last_seen: '2026-01-01T00:00:00.000Z' };
  const due = new Date(nextDue(state)!);
  const days = (due.getTime() - new Date(state.last_seen!).getTime()) / 86_400_000;
  assert.ok(days > 0 && days < 10, `review at ${days} days should fall inside the half-life`);
});
