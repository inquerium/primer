// fixture-keeper watcher: wake when the corpus has fallen behind the code it
// describes, or when it has stopped being true.
//
// The corpus is ground truth for every engineering lane. Its failure mode is
// not noise, it is silence: a persona that no longer exhibits the property it
// is named for makes every lane measured against it report success against
// nothing. So this watcher fires on two conditions, and neither of them is a
// clock.
//
// The runtime provides `tools`, `trigger` and `json`. The payload runs only on
// `fire: true`.

// Which paths can invalidate a persona is declared by the corpus, in
// test/fixtures/GOVERNS, and read at evaluation time rather than hardcoded here.
//
// Two reasons, and the second is the binding one. The corpus is the thing making
// the claim, so the scope of that claim belongs beside it and moves when
// fixture-keeper changes what it covers. And test/invariants.test.ts forbids
// anything under automation/ from naming the record's modules at all, bluntly
// and deliberately, so that no convenience import ever crosses the one boundary
// that must not blur. A watcher listing those module paths trips it, correctly.
// The invariant wins, and obeying it put the list somewhere better.
const GOVERNS_FILE = 'test/fixtures/GOVERNS';
const CORPUS = ['test/fixtures/', 'test/fixtures.test.ts'];

// Two consecutive failed checks before breakage is worth a model turn. This is
// a daily job on a laptop that sleeps, and a call that never completed says
// nothing about the corpus.
const FAIL_STREAK = 2;
const ALERT_BACKOFF_MS = 4 * 24 * 3600 * 1000;

const prev = trigger.state ?? {};
const now = Date.now();

// One `git log` per path set, plus one test run. Read-only by contract: this
// watcher never writes, and the proposal belongs to the payload, because state
// from a failed payload run is not persisted.
async function sh(command) {
  const res = await tools.call('exec', { command });
  return String(res?.result?.details?.aggregated ?? '').trim();
}

let facts = null;
let failure = null;

try {
  // Strip comments and blanks, then hand the rest to git as pathspecs. If the
  // file is missing or empty the corpus has stopped saying what it covers, and
  // that is itself worth a look rather than something to paper over.
  const governs = await sh(`grep -v '^\\s*#' ${GOVERNS_FILE} 2>/dev/null | grep -v '^\\s*$' | tr '\\n' ' '`);

  if (!governs) {
    // Not a transient failure and not a corpus defect. The corpus has stopped
    // saying what it covers, so this watcher cannot tell whether it is stale.
    failure = {
      kind: 'shape',
      why:
        `${GOVERNS_FILE} is missing or empty, so the corpus no longer declares what it claims ` +
        `to describe. Restore it: git pathspecs, one per line.`,
    };
  } else {
    const governingAt = await sh(`git log -1 --format=%ct -- ${governs}`);
    const corpusAt = await sh(`git log -1 --format=%ct -- ${CORPUS.join(' ')}`);
    const head = await sh('git rev-parse --short HEAD');

    // The corpus is allowed to be older than the code. It is not allowed to be
    // older than a change to what it describes, without someone having looked.
    const governing = Number(governingAt);
    const corpus = Number(corpusAt);

    if (!Number.isFinite(governing) || !head) {
      failure = { kind: 'shape', why: `git answered but not with a timestamp: "${governingAt}"` };
    } else {
      // Runs the corpus against itself. This is the check that matters most: the
      // timestamps say the corpus might be stale, this says whether it is wrong.
      const testOut = await sh(
        'node --experimental-strip-types --test test/fixtures.test.ts 2>&1 | tail -20 || true',
      );
      const failing = /(^|\n)ℹ fail (\d+)/.exec(testOut);
      const failCount = failing ? Number(failing[2]) : null;

      facts = {
        head,
        governs,
        governing,
        corpus: Number.isFinite(corpus) ? corpus : 0,
        staleDays: Number.isFinite(corpus) ? Math.floor((governing - corpus) / 86400) : null,
        failCount,
        testTail: testOut.slice(-600),
      };
    }
  }
} catch (err) {
  failure = { kind: 'transient', why: String(err).slice(0, 200) };
}

if (failure && failure.kind === 'transient') {
  const failStreak = (prev.failStreak ?? 0) + 1;
  const firstFailAt = prev.firstFailAt ?? now;
  const nextAlertAt = prev.nextAlertAt ?? 0;
  const due = failStreak >= FAIL_STREAK && now >= nextAlertAt;
  json({
    fire: due,
    message:
      `FIXTURE WATCHER BROKEN. ${failStreak} failed checks running since ` +
      `${new Date(firstFailAt).toISOString()}. Last error: ${failure.why}. Nothing is being ` +
      `checked, so a quiet corpus currently means nothing. Report this and stop.`,
    state: { ...prev, failStreak, firstFailAt, nextAlertAt: due ? now + ALERT_BACKOFF_MS : nextAlertAt },
  });
} else if (failure) {
  json({
    fire: true,
    message:
      `FIXTURE WATCHER BROKEN, and not by the network: ${failure.why}. Report what changed ` +
      `about the repository or the tooling. Open no pull request.`,
    state: { ...prev, failStreak: 0, firstFailAt: null },
  });
} else if (facts.failCount !== null && facts.failCount > 0) {
  // The loudest condition, and the only one that is unambiguous. Something the
  // corpus asserts about the model is now false.
  json({
    fire: true,
    message:
      `The fixture corpus no longer holds: ${facts.failCount} failing test(s) at ${facts.head}.\n\n` +
      `${facts.testTail}\n\n` +
      `Establish which is wrong before you touch either. A persona whose expect block has ` +
      `become false is either a fixture to update or a defect in whatever changed the model, ` +
      `and telling those apart is the work. A fixture edited to make a test pass is how a ` +
      `corpus stops being ground truth. If it is a defect, hand over the failing test and ` +
      `leave the fix unwritten.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastHead: facts.head, lastFailCount: facts.failCount },
  });
} else if (facts.corpus === 0) {
  json({
    fire: true,
    message:
      `No commit has ever touched ${CORPUS.join(' or ')}, but the model code has. The corpus ` +
      `does not exist or is untracked. Every engineering lane measures itself against it. ` +
      `Report this; it is a setup problem, not a proposal.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastHead: facts.head },
  });
} else if (facts.governing > facts.corpus && prev.lastReviewedGoverning !== facts.governing) {
  json({
    fire: true,
    message:
      `The model moved after the corpus did. Last change under ${facts.governs} was ` +
      `${facts.staleDays} day(s) newer than the last change to the corpus, at ${facts.head}. ` +
      `The corpus still passes, so nothing is known to be wrong.\n\n` +
      `Read what changed and decide whether any persona's expect block is now understated, ` +
      `overstated, or silent about a new behavior. Adding a persona is the usual right answer; ` +
      `so is concluding that nothing changed that the corpus should describe. If the latter, ` +
      `say so in one sentence and open nothing.`,
    // Remember the timestamp reviewed, not just that a review happened, so the
    // same change is not raised every single day until something else moves.
    state: {
      ...prev,
      failStreak: 0,
      firstFailAt: null,
      lastHead: facts.head,
      lastReviewedGoverning: facts.governing,
    },
  });
} else {
  json({
    fire: false,
    message: `Corpus current at ${facts.head}; nothing under the governing paths has moved past it.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, nextAlertAt: 0, lastHead: facts.head },
  });
}
