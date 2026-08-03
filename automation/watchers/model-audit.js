// model-auditor watcher: wake the lane when a property of the mastery model
// stops holding, or when the model has moved and nobody has re-checked it.
//
// The suite checks the model against examples someone thought of. The audit
// checks it against two hundred thousand nobody did, and this watcher is what
// makes that continuous rather than something a person remembers to run.
//
// The runtime provides `tools`, `trigger` and `json`. The payload runs only on
// `fire: true`.

const CASES = 20000;
const FAIL_STREAK = 2;
const ALERT_BACKOFF_MS = 4 * 24 * 3600 * 1000;

const prev = trigger.state ?? {};
const now = Date.now();

let audit = null;
let failure = null;

try {
  const res = await tools.call('exec', {
    command: `node --experimental-strip-types scripts/model-audit.mjs --json --cases ${CASES} 2>/dev/null`,
  });
  const raw = String(res?.result?.details?.aggregated ?? '').trim();
  const start = raw.indexOf('{');
  if (start < 0) {
    failure = { kind: 'shape', why: 'the audit produced no JSON' };
  } else {
    try {
      audit = JSON.parse(raw.slice(start));
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
      `MODEL AUDIT BROKEN. ${failStreak} failed runs since ${new Date(firstFailAt).toISOString()}. ` +
      `Last error: ${failure.why}. Nothing is being checked, so a quiet audit currently means ` +
      `nothing. Report this and stop.`,
    state: { ...prev, failStreak, firstFailAt, nextAlertAt: due ? now + ALERT_BACKOFF_MS : nextAlertAt },
  });
} else if (failure) {
  json({
    fire: true,
    message:
      `MODEL AUDIT BROKEN, and not by the network: ${failure.why}. The harness ran and answered ` +
      `in a shape this watcher does not understand. Report what changed. Open no pull request.`,
    state: { ...prev, failStreak: 0, firstFailAt: null },
  });
} else if (audit.total > 0) {
  const broken = (audit.properties ?? []).filter((p) => !p.ok);
  const lines = broken.map(
    (p) =>
      `PROPERTY ${p.name}: ${p.claim}\n  counterexample: ${p.counterexample?.why}\n` +
      `  replay: node --experimental-strip-types scripts/model-audit.mjs --seed ${audit.seed} ` +
      `--cases ${(p.counterexample?.case ?? 0) + 1}`,
  );
  for (const v of audit.corpus?.violations ?? []) lines.push(`RECORD ${v.persona}: ${v.why}`);

  json({
    fire: true,
    message:
      `The mastery model no longer holds: ${audit.total} violation(s) at seed ${audit.seed}.\n\n` +
      lines.join('\n\n') +
      `\n\nEvery counterexample replays exactly from the seed above. Before you propose ` +
      `anything, decide which is wrong: the model, or the property. A property asserting ` +
      `something the model never promised is the more common of the two, and correcting the ` +
      `property is a real deliverable. If it is the model, hand over the failing case and say ` +
      `what a child would experience because of it.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastTotal: audit.total },
  });
} else if (!audit.corpus?.ran) {
  // Half the audit is not running. That is not a passing audit.
  json({
    fire: true,
    message:
      `The pure properties hold, but the record-level checks did not run: ${audit.corpus?.why}. ` +
      `Those are the ones that catch a scheduler telling a parent something false. Report what ` +
      `is missing; this is a setup problem, not a proposal.`,
    state: { ...prev, failStreak: 0, firstFailAt: null },
  });
} else {
  json({
    fire: false,
    message: `The model holds: ${audit.properties.length} properties, ${audit.cases} cases each.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, nextAlertAt: 0, lastTotal: 0 },
  });
}
