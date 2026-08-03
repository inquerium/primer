// activity-attacker watcher: wake the lane when the reviewer starts refusing
// good work, or stops catching a defect the corpus is known to contain.
//
// The asymmetry is the same one the misconception miner runs on, and it points
// the same way. A missed defect leaves an activity slightly worse than it could
// be. A spurious refusal blocks work that was fine, costs the tutor a retry, and
// teaches it that this gate is noise to be routed around. Once a model learns
// that, every later check inherits the distrust.
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
    command: 'node --experimental-strip-types scripts/activity-audit.mjs --json 2>/dev/null',
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
      `ACTIVITY AUDIT BROKEN. ${failStreak} failed runs since ` +
      `${new Date(firstFailAt).toISOString()}. Last error: ${failure.why}. The reviewer is ` +
      `unscored, so silence currently means nothing. Report this and stop.`,
    state: { ...prev, failStreak, firstFailAt, nextAlertAt: due ? now + ALERT_BACKOFF_MS : nextAlertAt },
  });
} else if (failure) {
  json({
    fire: true,
    message: `ACTIVITY AUDIT BROKEN, and not by the network: ${failure.why}. Report what changed.`,
    state: { ...prev, failStreak: 0, firstFailAt: null },
  });
} else if (report.false_positives > 0) {
  const spurious = report.rows.filter((r) => r.spurious.length);
  json({
    fire: true,
    message:
      `The reviewer flagged ${report.false_positives} thing(s) that were not wrong. ` +
      `Precision ${report.precision}.\n\n` +
      spurious.map((r) => `${r.id}: ${r.spurious.join(', ')} on "${r.summary}"`).join('\n') +
      `\n\nThis is the failure that matters here. A refusal the tutor did not deserve costs a ` +
      `retry and teaches it that this gate is noise, and once a model learns that, every later ` +
      `check inherits the distrust. Narrow the rule. Do not widen the corpus to make the number ` +
      `look better.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastPrecision: report.precision },
  });
} else if (report.false_negatives > 0) {
  json({
    fire: true,
    message:
      `The reviewer missed ${report.false_negatives} declared defect(s). Recall ${report.recall}.\n\n` +
      report.rows
        .filter((r) => r.missed.length)
        .map((r) => `${r.id}: missed ${r.missed.join(', ')} — ${r.summary}`)
        .join('\n') +
      `\n\nLower priority than a spurious refusal and still real: either a rule regressed, or the ` +
      `corpus gained a defect class this reviewer cannot see, which is a finding about its reach.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastRecall: report.recall },
  });
} else {
  json({
    fire: false,
    message: `Reviewer holding: precision ${report.precision}, recall ${report.recall}.`,
    state: {
      ...prev,
      failStreak: 0,
      firstFailAt: null,
      nextAlertAt: 0,
      lastPrecision: report.precision,
      lastRecall: report.recall,
    },
  });
}
