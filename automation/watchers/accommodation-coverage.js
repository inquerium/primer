// accommodation-marshal watcher: wake the lane when a check stops working, or
// when the set of accommodations nobody can verify has grown.
//
// SPEC.md calls honoring accommodations a hard constraint. The checks that make
// that true are worth exactly as much as the last time anyone proved they fire,
// which is what this runs. And the kinds with no check are the lane's backlog:
// a promise the spec makes and the code does not keep.
//
// The runtime provides `tools`, `trigger` and `json`.

const FAIL_STREAK = 2;
const ALERT_BACKOFF_MS = 4 * 24 * 3600 * 1000;

const prev = trigger.state ?? {};
const now = Date.now();

let report = null;
let failure = null;

try {
  const res = await tools.call('exec', {
    command: 'node --experimental-strip-types scripts/accommodation-audit.mjs --json 2>/dev/null',
  });
  const raw = String(res?.result?.details?.aggregated ?? '').trim();
  const start = raw.indexOf('{');
  if (start < 0) {
    failure = { kind: 'shape', why: 'the audit produced no JSON' };
  } else {
    try {
      report = JSON.parse(raw.slice(start));
    } catch (err) {
      failure = { kind: 'shape', why: `the audit did not return JSON: ${String(err).slice(0, 120)}` };
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
      `ACCOMMODATION AUDIT BROKEN. ${failStreak} failed runs since ` +
      `${new Date(firstFailAt).toISOString()}. Last error: ${failure.why}. Nothing is proving ` +
      `the checks still fire, so a quiet audit currently means nothing. Report this and stop.`,
    state: { ...prev, failStreak, firstFailAt, nextAlertAt: due ? now + ALERT_BACKOFF_MS : nextAlertAt },
  });
} else if (failure) {
  json({
    fire: true,
    message: `ACCOMMODATION AUDIT BROKEN, and not by the network: ${failure.why}. Report what changed.`,
    state: { ...prev, failStreak: 0, firstFailAt: null },
  });
} else if (report.broken.length) {
  // A check that stopped firing is worse than one that never existed, because
  // the report it produces reads clean.
  json({
    fire: true,
    message:
      `${report.broken.length} accommodation check(s) are not working.\n\n` +
      report.broken
        .map((b) =>
          b.catches_violation
            ? `${b.kind}: refuses a COMPLIANT page (${b.false_refusal.join(', ')}). The tutor will ` +
              `retry forever and eventually route around the constraint.`
            : `${b.kind}: does NOT refuse a violating page. Every report it produces reads clean.`,
        )
        .join('\n') +
      `\n\nA check that no longer fires is worse than one that never existed. Fix it, and add ` +
      `the case that would have caught this to test/accommodations.test.ts.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastUnchecked: report.unchecked.length },
  });
} else if (report.unchecked.length > (prev.lastUnchecked ?? report.unchecked.length)) {
  json({
    fire: true,
    message:
      `The unverifiable set grew: ${report.unchecked.length} accommodation kinds now have no ` +
      `mechanical check, up from ${prev.lastUnchecked}.\n\n` +
      report.unchecked.map((u) => `${u.kind}`).join('\n') +
      `\n\nEach of these is a promise SPEC.md makes and the code does not keep. Either write the ` +
      `check, or say plainly why it cannot be written from source text, which is a legitimate ` +
      `and final answer for some of them. Never make a check that could invert what a parent ` +
      `asked for: a kind phrased as a prohibition must not become a requirement.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastUnchecked: report.unchecked.length },
  });
} else {
  json({
    fire: false,
    message:
      `Checks hold, coverage ${report.checked}/${report.total}. ` +
      `${report.unchecked.length} kind(s) still rest on an adult reading the activity.`,
    state: {
      ...prev,
      failStreak: 0,
      firstFailAt: null,
      nextAlertAt: 0,
      lastUnchecked: report.unchecked.length,
    },
  });
}
