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

test('an empty or errored run is the machine failing, not the lane', () => {
  // Seven of the attacker's runs in one offline stretch came back with no text.
  // Charging those to the lane's conduct would bury the signal that matters.
  assert.equal(classify('').shape, 'failed');
  assert.equal(classify(null).shape, 'failed');
  assert.equal(
    classify('The model did not produce a response before the model idle timeout.', {
      status: 'error',
    }).shape,
    'failed',
  );
});

/* ------------------------------------------------------------------------- */
/* Cases taken verbatim from runs this pipeline actually produced. Every one   */
/* of these was classified wrongly by the first version of this gate.          */
/* ------------------------------------------------------------------------- */

test('real: an exec denial is a blocker, however much it reads like a quiet week', () => {
  // 2026-07-30. Both of these finished status ok and delivered, and the first
  // version of this gate filed them as "declined to act, a complete outcome".
  // The lane itself said the right thing and the gate is what failed.
  const first = classify(
    'Confirmed. `git`, `gh`, `curl`, `node`, `npm` all require exec approval that this cron run ' +
      'cannot obtain. The proposer protocol is not executable in this run. I will report the ' +
      'blocker as the deliverable rather than fabricate a PR or manufacture claims from DOIs I ' +
      'cannot resolve. Research lane, spacing watcher fired, but the proposer protocol could not ' +
      'run. No PR opened. Operator action needed.',
  );
  assert.equal(first.shape, 'blocked');
  assert.equal(first.escalates, true);

  const second = classify(
    '`exec` is hard-denied for this run. That is decisive for what I can honestly deliver. ' +
      'The stored cron job was registered with --tools exec,read,write,edit,web_search,web_fetch, ' +
      'so the intended policy includes exec; this run environment is not honoring it. That is a ' +
      'pipeline breakage, not an empty week.',
  );
  assert.equal(second.shape, 'blocked');
  assert.equal(second.escalates, true);
});

test('real: an attacker delivers a comment, not a branch', () => {
  // The attacker lanes hold no write tool by design, so a finished attack is
  // never a pull request. This complete, correct run came back malformed.
  const r = classify(
    'Comment posted to PR #7. Attack complete on PR #7 (head 7df447c). I resolved all seven DOIs ' +
      'against Crossref and checked each against the source abstract. Every DOI resolves to the ' +
      'paper the entry names. Agreement counts are honestly deflated, not inflated. The proposal ' +
      'survives. I posted that in one sentence, admitted nothing, and stated the comment is not a ' +
      'merge signal.',
  );
  assert.equal(r.shape, 'posted');
  assert.equal(r.escalates, false);
});

test('real: the verdict can sit in a different sentence from the outcome', () => {
  const r = classify(
    'No PR. The one new work does not warrant a change to any World entry. Watcher fire: 1 new ' +
      'work in the spacing claim family, venue Journal of Memory and Language. The journal filter ' +
      'is a venue filter, not a topic filter, and this one is off topic for the lane.',
  );
  assert.equal(r.shape, 'nothing');
});

test('infrastructure failure is diagnosed as the machine, not the lane', () => {
  const rates = escalationRate([
    { agentId: 'offline', reply: '', status: 'error' },
    { agentId: 'offline', reply: '', status: 'error' },
    { agentId: 'offline', reply: '', status: 'error' },
    { agentId: 'offline', reply: 'Nothing warranted a change.', status: 'ok' },
  ]);
  const row = rates[0];
  assert.equal(row.failed, 3);
  assert.equal(row.answered, 1);
  // The one run that answered was clean, so its conduct is not in question.
  assert.equal(row.escalation_rate, 0);
  assert.match(row.verdict, /the machine, not the lane/);
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
