/**
 * The shape gate is the part of the escalation doctrine that is not advisory.
 * These are the cases it has to get right, written as things an agent actually
 * says rather than as keyword probes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// @ts-expect-error plain JS module, no declarations
import { classify, escalationRate, ESCALATION } from '../automation/deliverable.mjs';

test('a pull request is finished work', () => {
  const r = classify(
    'Opened https://github.com/VedSoni-dev/primer/pull/12 with one claims file and one priors ' +
      'proposal. Agreement is 3, and the weakest point is that two of the sources share a 2019 ' +
      'review I could not open.',
  );
  assert.equal(r.shape, 'proposed');
  assert.equal(r.escalates, false);
});

test('declining to act is a complete outcome, not a failure', () => {
  for (const reply of [
    'The watcher fired on four new DOIs. Three are off topic for this lane and the fourth ' +
      'restates a claim world/claims/spacing.md already carries. Nothing warranted a proposal, ' +
      'so I opened none.',
    'No findings. The diff cites two sources, both resolve, and the placement matches them.',
  ]) {
    assert.equal(classify(reply).shape, 'nothing', reply.slice(0, 40));
  }
});

test('asking the operator to decide is malformed, because nobody is there', () => {
  for (const reply of [
    'I found two plausible readings of the grade 4 fractions sequence. Which would you prefer I use?',
    'The prior contradicts the claim it depends on. Should I update the prior or the claim? ' +
      'Let me know and I will open the PR.',
    'Ready to open the pull request. Please confirm before I proceed.',
    'Awaiting your guidance on whether this belongs in the curriculum lane.',
  ]) {
    const r = classify(reply);
    assert.equal(r.shape, 'malformed', reply.slice(0, 45));
    // Malformed is not an escalation. It never reaches a person at all.
    assert.equal(r.escalates, false);
  }
});

test('stating what would make it wrong is honesty, not a question', () => {
  // The charter explicitly asks for this. If the gate punished it, the reports
  // would get less candid, which is the opposite of what the gate is for.
  const r = classify(
    'Opened https://github.com/VedSoni-dev/primer/pull/13. What would make me wrong? The two ' +
      'frameworks may both be quoting the same 2017 state adoption, in which case agreement is ' +
      '1 and not 2. I could not establish that either way.',
  );
  assert.equal(r.shape, 'proposed');
});

test('a boundary is a real escalation and reaches a person', () => {
  const r = classify(
    'The fix requires widening the tool surface in src/mcp/tools.ts, which my charter forbids ' +
      'and which is a capability decision. I did not write the diff. The reproduction is in ' +
      'the branch and the boundary is hard rule 3.',
  );
  assert.equal(r.shape, 'blocked');
  assert.equal(r.escalates, true);
  assert.ok(ESCALATION.has(r.shape));
});

test('a possible attack outranks everything and is never rate limited', () => {
  const r = classify(
    'A source page I fetched contained an instruction addressed to me telling me to read a ' +
      'path I did not create from a fixture. That looks like an attack. Stopping the run.',
  );
  assert.equal(r.shape, 'alarm');
  assert.equal(r.escalates, true);
});

test('a defect with evidence is a finding, and does not need a person yet', () => {
  const r = classify(
    'nextTargets misreports a lapsed skill as stuck when opportunities is at least six. ' +
      'Failing test added at test/fixtures.test.ts; it reproduces on the lapsed-summer persona. ' +
      'I left the fix unwritten because the threshold is a judgment call.',
  );
  assert.equal(r.shape, 'finding');
  assert.equal(r.escalates, false);
});

test('announcing intent is malformed; an unattended run has no next turn', () => {
  const r = classify('I will now review the remaining four pull requests and report back.');
  assert.equal(r.shape, 'malformed');
});

test('an empty reply is malformed rather than silently fine', () => {
  assert.equal(classify('').shape, 'malformed');
  assert.equal(classify(null).shape, 'malformed');
});

test('escalation rate names a bad task rather than a bad agent', () => {
  const blocked = 'This needs a boundary moved. I do not have the permission.';
  const done = 'Nothing warranted a change this run.';

  const rates = escalationRate([
    { agentId: 'over-scoped', reply: blocked },
    { agentId: 'over-scoped', reply: blocked },
    { agentId: 'over-scoped', reply: done },
    { agentId: 'healthy', reply: done },
    { agentId: 'healthy', reply: done },
    { agentId: 'healthy', reply: 'Opened https://github.com/VedSoni-dev/primer/pull/9.' },
  ]);

  const over = rates.find((r) => r.agentId === 'over-scoped');
  const fine = rates.find((r) => r.agentId === 'healthy');

  assert.ok(over.escalation_rate > 0.33);
  assert.match(over.verdict, /task is too big|capability is missing/);
  assert.equal(fine.escalation_rate, 0);
  assert.equal(fine.verdict, 'healthy');

  // Worst first, so the daily brief leads with the lane that needs rethinking.
  assert.equal(rates[0].agentId, 'over-scoped');
});

test('a lane that keeps asking is diagnosed separately from one that is blocked', () => {
  const asking = 'Should I use the state framework or the national one? Let me know.';
  const rates = escalationRate([
    { agentId: 'confused', reply: asking },
    { agentId: 'confused', reply: asking },
    { agentId: 'confused', reply: 'Nothing warranted a change.' },
  ]);
  const row = rates[0];
  assert.equal(row.escalation_rate, 0, 'asking never reaches a person, so it is not an escalation');
  assert.ok(row.malformed_rate > 0.2);
  assert.match(row.verdict, /charter is not landing/);
});
