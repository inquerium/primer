// Research-lane watcher: poll one spacing-literature source, diff against the
// last known state, fire only on change. See docs/OPENCLAW.md.
//
// Runs as an OpenClaw cron condition script. The runtime provides `tools`
// (tool calls under the owning agent's policy), `trigger` (with the frozen
// state from the last run), and `json` (the way a watcher returns its
// verdict). The payload runs only when this returns `fire: true`.
//
// Watchers are read-only checks. Actions belong in the payload, because state
// from a failed payload run is not persisted.

// TODO(operator): set the real source before registering this watcher. It
// should be a stable index of spacing and testing-effect literature, for
// example a curated bibliography page or a journal search feed. Weekly
// cadence; these sources move slowly and nobody's server should be hammered.
const SOURCE_URL = 'https://example.invalid/spacing-literature';

const res = await tools.call('exec', {
  command: `curl -sf ${SOURCE_URL} | sha256sum | cut -d" " -f1`,
});
const hash = String(res?.result?.details?.aggregated ?? '').trim();

if (!hash) {
  // A watcher that goes quiet when its check fails looks healthy while
  // broken. Surface the failure instead of returning fire: false.
  json({
    fire: true,
    message:
      `Spacing-literature watcher could not fetch its source (${SOURCE_URL}). ` +
      'Fix the watcher before trusting its silence; do not propose World changes from this run.',
    state: trigger.state ?? {},
  });
} else {
  json({
    fire: hash !== trigger.state?.hash,
    message:
      `Spacing-literature source changed (${hash.slice(0, 8)}). ` +
      'Diff against world/claims/spacing.md and follow the proposer protocol in docs/OPENCLAW.md.',
    state: { hash, checkedAt: Date.now() },
  });
}
