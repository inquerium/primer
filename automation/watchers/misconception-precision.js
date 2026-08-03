// misconception-miner watcher: wake the lane when the detector starts inventing
// patterns, or stops finding ones the corpus is known to contain.
//
// The asymmetry here is the whole design. A missed misconception leaves the
// tutor working slightly blind, which is where it already was. A fabricated one
// has the tutor teaching against a model the child does not hold, and a parent
// being told something confident and false about their kid. So a single false
// positive fires; a drop in recall fires more quietly.
//
// The runtime provides `tools`, `trigger` and `json`.

const FAIL_STREAK = 2;
const ALERT_BACKOFF_MS = 4 * 24 * 3600 * 1000;
const RECALL_FLOOR = 0.5;

const prev = trigger.state ?? {};
const now = Date.now();

let report = null;
let failure = null;

try {
  const res = await tools.call('exec', {
    command: 'node --experimental-strip-types scripts/mine-misconceptions.mjs --json 2>/dev/null',
  });
  const raw = String(res?.result?.details?.aggregated ?? '').trim();
  const start = raw.indexOf('{');
  if (start < 0) {
    failure = { kind: 'shape', why: 'the scoring harness produced no JSON' };
  } else {
    try {
      report = JSON.parse(raw.slice(start));
    } catch (err) {
      failure = { kind: 'shape', why: `the harness did not return JSON: ${String(err).slice(0, 120)}` };
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
      `MISCONCEPTION HARNESS BROKEN. ${failStreak} failed runs since ` +
      `${new Date(firstFailAt).toISOString()}. Last error: ${failure.why}. The detector is ` +
      `unscored, so silence currently means nothing. Report this and stop.`,
    state: { ...prev, failStreak, firstFailAt, nextAlertAt: due ? now + ALERT_BACKOFF_MS : nextAlertAt },
  });
} else if (failure) {
  json({
    fire: true,
    message: `MISCONCEPTION HARNESS BROKEN, and not by the network: ${failure.why}. Report what changed.`,
    state: { ...prev, failStreak: 0, firstFailAt: null },
  });
} else if (report.ran === false) {
  json({
    fire: true,
    message:
      `The detector cannot be scored: ${report.why}. An unscored detector is not a working ` +
      `detector. Report this; it is a setup problem, not a proposal.`,
    state: { ...prev, failStreak: 0, firstFailAt: null },
  });
} else if (report.false_positives > 0) {
  const fabricated = report.rows.filter((r) => r.kind === 'fabricated' || r.kind === 'extra');
  json({
    fire: true,
    message:
      `The detector invented ${report.false_positives} pattern(s). Precision ${report.precision}.\n\n` +
      fabricated.map((r) => `${r.persona}: ${r.pattern} (confidence ${r.confidence})`).join('\n') +
      `\n\nThis is the failure that matters. A fabricated model means a tutor teaching against ` +
      `something the child does not hold and a parent told something false. Find why the rule ` +
      `fired on a persona built to hold no readable wrong model, and fix the detector or the ` +
      `thresholds. Raising a threshold to hide one case is not a fix unless you can say what ` +
      `it costs in recall.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastPrecision: report.precision },
  });
} else if (report.recall < RECALL_FLOOR) {
  json({
    fire: true,
    message:
      `The detector found nothing it should have. Recall ${report.recall}, precision ` +
      `${report.precision}.\n\n` +
      report.rows
        .filter((r) => r.kind === 'missed')
        .map((r) => `${r.persona}: expected ${r.want.from} -> ${r.want.to}`)
        .join('\n') +
      `\n\nLower priority than a fabricated pattern, and still worth a look: either the corpus ` +
      `gained a wrong model this detector cannot see, which is a real finding about its reach, ` +
      `or a threshold moved too far toward silence.`,
    state: { ...prev, failStreak: 0, firstFailAt: null, lastRecall: report.recall },
  });
} else {
  json({
    fire: false,
    message: `Detector holding: precision ${report.precision}, recall ${report.recall}.`,
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
