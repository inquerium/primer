// Adjutant watcher: the only job in the corps that announces.
//
// Every other lane hands back a deliverable and stops. This one reads what they
// all produced, and wakes the adjutant only when something in it has to reach a
// person. See docs/CORPS.md.
//
// The runtime provides `tools` (tool calls under the owning agent's policy),
// `trigger` (carrying the frozen state from the last run), and `json` (how a
// watcher returns its verdict). The payload runs only on `fire: true`.
//
// Why this shells out instead of classifying here: watcher scripts cannot
// import, and automation/deliverable.mjs is the shape gate the whole escalation
// doctrine rests on. A second copy inlined here would drift from it inside a
// month and the drift would be silent, because both would keep returning
// plausible answers. scripts/adjutant-scan.mjs is the one implementation.

// A day's worth, plus slack for a laptop that slept through its window. Runs
// already briefed are filtered by the seen-set, so overlap costs nothing.
const WINDOW_HOURS = 30;

// Daily cadence, so a stumble is two days of silence before it is worth a turn.
// Firing on the first failed check is what cost eight alerts in one offline
// stretch on the hourly attacker watcher. The same trap, slower.
const FAIL_STREAK = 2;

// Back off after each alert so a long outage reports a few times rather than
// once a day forever.
const ALERT_BACKOFF_MS = 4 * 24 * 3600 * 1000;

// ~30 bytes per key against a 16 KB state cap.
const KEEP = 300;

const prev = trigger.state ?? {};
const seen = new Set(prev.seen ?? []);
const now = Date.now();

// Identity of one run: the job it belongs to and the instant it finished.
const keyOf = (r) => `${r.jobId.slice(0, 8)}:${r.ts}`;

let scan = null;
let failure = null;

try {
  const res = await tools.call('exec', {
    command: `node scripts/adjutant-scan.mjs --json --hours ${WINDOW_HOURS}`,
  });
  const raw = String(res?.result?.details?.aggregated ?? '').trim();
  if (!raw) {
    // The call completed and returned nothing usable. A response arriving proves
    // the machine is up, so this is a contract change rather than a bad network,
    // and it is announced at once.
    failure = { kind: 'shape', why: 'the scan produced no output' };
  } else {
    try {
      scan = JSON.parse(raw.slice(raw.indexOf('{')));
    } catch (err) {
      failure = { kind: 'shape', why: `the scan did not return JSON: ${String(err).slice(0, 120)}` };
    }
  }
} catch (err) {
  // The call never completed. On a laptop that sleeps and changes networks this
  // is usually the machine, and waking a model to diagnose a missing machine is
  // self-defeating: the agent's own provider call needs what just failed.
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
      `ADJUTANT WATCHER BROKEN. The daily scan has failed ${failStreak} times running, ` +
      `since ${new Date(firstFailAt).toISOString()}. Last error: ${failure.why}. ` +
      `Nothing has been read from the corps in that time, so silence from the pipeline ` +
      `currently means nothing. Report this and stop; do not attempt to diagnose the ` +
      `network from inside a run that needs it.`,
    // Spread prior state. Returning fresh state after an outage would drop the
    // seen-set and re-brief every escalation the next time the scan succeeds.
    state: {
      ...prev,
      failStreak,
      firstFailAt,
      nextAlertAt: due ? now + ALERT_BACKOFF_MS : nextAlertAt,
    },
  });
} else if (failure) {
  json({
    fire: true,
    message:
      `ADJUTANT WATCHER BROKEN, and not by the network: ${failure.why}. The scan ran and ` +
      `answered in a shape this watcher does not understand, which means ` +
      `scripts/adjutant-scan.mjs or the gateway's run-history format has changed. ` +
      `Report what changed. Open no pull request.`,
    state: { ...prev, failStreak: 0, firstFailAt: null },
  });
} else {
  const fresh = (scan.escalations ?? []).filter((r) => !seen.has(keyOf(r)));
  const alarms = fresh.filter((r) => r.shape === 'alarm');
  const unhealthy = scan.unhealthy_lanes ?? [];
  const broken = scan.broken ?? [];

  // Cold start seeds silently. The first evaluation would otherwise hand the
  // adjutant every escalation in the window as though all of it happened today.
  const coldStart = prev.seen === undefined;

  // Union, not just rows. The scanner derives escalations from rows today, so
  // the two agree, and a watcher that quietly depends on that is one refactor
  // away from re-briefing the same blocker every morning until someone mutes
  // the channel. Mark everything this evaluation actually looked at.
  const nextSeen = [
    ...seen,
    ...(scan.rows ?? []).map(keyOf),
    ...(scan.escalations ?? []).map(keyOf),
  ].slice(-KEEP);

  if (coldStart) {
    json({
      fire: false,
      message: `Adjutant watcher seeded on ${scan.total} runs. Nothing briefed.`,
      state: { seen: nextSeen, failStreak: 0, firstFailAt: null, nextAlertAt: 0, seededAt: now },
    });
  } else if (!fresh.length && !unhealthy.length && !broken.length) {
    // The common case, and it must stay cheap. A quiet corps is not news, and a
    // daily message saying nothing happened is how a channel gets muted.
    json({
      fire: false,
      message: `Nothing needs a person. ${scan.total} runs in the window.`,
      state: { ...prev, seen: nextSeen, failStreak: 0, firstFailAt: null, nextAlertAt: 0 },
    });
  } else {
    const lines = [];

    if (alarms.length) {
      lines.push(
        `${alarms.length} ALARM: a lane reported a possible attack or a path to a real record. ` +
          `This outranks everything else in the brief.`,
      );
    }

    for (const r of fresh) {
      lines.push(`[${r.shape}] ${r.agentId} at ${r.at.slice(0, 16)}: ${r.excerpt.slice(0, 220)}`);
    }

    for (const l of unhealthy) {
      lines.push(
        `LANE ${l.agentId}: ${l.runs} runs, ${l.failed} did not complete, ` +
          `escalation rate ${l.escalation_rate}, malformed rate ${l.malformed_rate}. ` +
          `Reading: ${l.verdict}.`,
      );
    }

    for (const b of broken) lines.push(`BROKEN ${b.name}: ${b.why}`);

    json({
      fire: true,
      message:
        `Daily brief. ${scan.total} runs in the last ${WINDOW_HOURS}h; ` +
        `${fresh.length} new item(s) for a person, ${unhealthy.length} unhealthy lane(s).\n\n` +
        lines.join('\n\n') +
        `\n\nWrite the brief. Lead with what only the maintainer can decide and what happens ` +
        `if they decide nothing. An unhealthy lane is a statement about its task, not about ` +
        `its conduct: say which, and say what you would change. Do not summarize the day. ` +
        `Do not restate runs that needed nobody. If after reading this nothing genuinely ` +
        `needs a person, say that in one sentence and stop.`,
      state: { ...prev, seen: nextSeen, failStreak: 0, firstFailAt: null, nextAlertAt: 0 },
    });
  }
}
