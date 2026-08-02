// Attacker-lane watcher: layer 2 of the admission pipeline in docs/WORLD.md.
// Polls open pull requests, fires on ones carrying World content this lane has
// not attacked yet. See docs/OPENCLAW.md. Read-only by contract; the comment
// itself belongs in the payload, because state from a failed payload run is
// not persisted and a PR marked attacked but never commented on is worse than
// one attacked twice.
//
// The runtime provides `tools` (tool calls under the owning agent's policy),
// `trigger` (carrying the frozen state from the last run), and `json` (how a
// watcher returns its verdict). The payload runs only on `fire: true`.
//
// Why changed paths and not the branch prefix: docs/OPENCLAW.md sketches this
// watcher as `--search "head:openclaw/"`, which scopes it to agent-authored
// branches. That is the wrong axis. The attack brief is about miscited papers,
// skills placed a grade early, and agreement counts that dissolve under
// inspection: failure modes of World content, not of agents. A human PR that
// seeds world/claims/ has every one of them. PR #7, the first World slice, is
// human-authored, and it is exactly the PR that definition-of-done step 4
// says the attacker must post findings on. A branch-prefix filter would skip
// it. Meanwhile an agent PR touching only src/ would have nothing to attack.
// So: any author, any branch, filtered to PRs that change a file under world/.

const REPO = 'VedSoni-dev/primer';

// A path is World content when it lives under world/ and is not a directory
// placeholder. A PR that only adds .gitkeep files has moved no claim, no prior,
// and no edge, so there is nothing in it to attack.
const isWorldContent = (path) =>
  String(path ?? '').startsWith('world/') && !String(path).endsWith('.gitkeep');

// Whether a PR has already been attacked at a given head is answered by the
// pull request itself, not by trigger state. The attacker signs every comment
// with the head it attacked, so the durable record lives on GitHub where it
// cannot be lost. Trigger state is a cache in front of that, nothing more.
//
// This is not defensive decoration. Trigger state is empty after a forced
// `openclaw cron run`, which executes the payload without ever evaluating the
// watcher, and after any job edit that resets it. Observed: the first attack on
// PR #7 was a forced run, so the next scheduled evaluation would have found an
// empty seen-set and attacked it a second time. A duplicate attack comment is
// the exact thing that teaches a reviewer to skim this layer.
const attackedAt = (body, sha) => {
  const b = String(body ?? '');
  return (
    b.includes(`<!-- world-attacker head=${sha} -->`) ||
    new RegExp(`attacked at head ${sha}`, 'i').test(b)
  );
};

// The turn that fires attacks every PR named in the message. Each one is a
// close read of a diff plus source resolution, so a run that names ten is a
// run that reads none of them properly. Overflow is not dropped, it waits for
// the next run, and the message says how many are waiting.
const MAX_PER_RUN = 3;

// ~50 bytes per entry against a 16 KB state cap.
const KEEP = 200;

// How many consecutive failures before breakage is worth a model turn.
//
// Firing on the first failed check was wrong and cost eight aborted runs and
// eight Telegram alerts in one day. This runs on a laptop that sleeps and
// changes networks. When the gh call fails for that reason, waking an agent to
// diagnose it is self-defeating: the same missing network prevents the agent's
// own provider call, so the run hangs for twenty minutes and aborts. The
// diagnosis cannot run under the condition it was written to diagnose.
//
// So a call that never completed is counted, not announced. A call that
// completed and returned the wrong shape is announced at once, because a
// response arrived, which means the network is up, the agent can actually run,
// and something about the gh contract has genuinely changed.
const CONNECT_ALERT_AFTER = 3; // hourly cadence, so roughly three hours down
const SHAPE_ALERT_AFTER = 1;

let prs = null;
let failure = '';
let shapeFailure = false;
try {
  const res = await tools.call('exec', {
    command:
      `gh pr list --repo ${REPO} --state open --limit 50 ` +
      '--json number,title,headRefName,headRefOid,isDraft,url,files,comments',
  });
  const body = JSON.parse(String(res?.result?.details?.aggregated ?? ''));
  if (!Array.isArray(body)) {
    failure = 'unexpected gh response shape (expected a JSON array)';
    shapeFailure = true;
  } else {
    prs = body;
  }
} catch (err) {
  failure = String(err).slice(0, 200);
}

if (failure) {
  // A watcher that goes quiet when its check breaks is indistinguishable from a
  // healthy watcher with nothing to report, so persistent breakage still has to
  // speak. It just does not have to speak on the first stumble.
  const prev = trigger.state ?? {};
  const streak = (prev.failStreak ?? 0) + 1;
  const firstFailAt = prev.firstFailAt ?? Date.now();
  const threshold =
    prev.nextAlertAt ?? (shapeFailure ? SHAPE_ALERT_AFTER : CONNECT_ALERT_AFTER);
  const alert = streak >= threshold;

  // Back off after each alert, so a genuinely long outage reports at three
  // hours, then twelve, then two days, instead of once an hour forever. Nothing
  // is learned from the ninth identical alert that the first did not say.
  const hours = Math.round((Date.now() - firstFailAt) / 36e5);

  json({
    fire: alert,
    message: alert
      ? `WATCHER BROKEN (world-proposals): the gh check has failed ${streak} ` +
        `time${streak === 1 ? '' : 's'} in a row, over about ${hours} hour` +
        `${hours === 1 ? '' : 's'}. Latest: ${failure}. Post no PR comments ` +
        'from this run. If your own web and provider calls are also failing, ' +
        'this is the machine being offline rather than the watcher being ' +
        'wrong: say that in one sentence and stop, do not retry in a loop. ' +
        'Otherwise diagnose it, starting with `gh auth status`, and report.'
      : undefined,
    // Spread the previous state so the seen-set survives an outage. Wiping it
    // would re-attack every open PR the moment the network came back.
    state: {
      ...prev,
      failStreak: streak,
      firstFailAt,
      nextAlertAt: alert ? streak * 4 : threshold,
      lastError: failure.slice(0, 120),
    },
  });
} else {
  // Keyed by head commit, not PR number. A proposer that pushes a fix in
  // response to an attack has produced a different proposal, and the previous
  // attack no longer applies to it. Keying on number alone would attack the
  // first revision of a PR and nothing after it. The attacker cannot write, so
  // its own comment never moves the head and never re-fires this.
  const seen = new Set(trigger.state?.seen ?? []);
  const short = (p) => String(p.headRefOid ?? '').slice(0, 7);
  const key = (p) => `${p.number}@${String(p.headRefOid ?? '').slice(0, 12)}`;

  const candidates = prs.filter(
    (p) =>
      !p.isDraft && // a draft is not a proposal yet
      Array.isArray(p.files) &&
      p.files.some((f) => isWorldContent(f.path)),
  );
  const fresh = candidates.filter(
    (p) =>
      !seen.has(key(p)) &&
      !(p.comments ?? []).some((c) => attackedAt(c.body, short(p))),
  );

  // No silent cold-start seed here, unlike the research watcher. There, a first
  // run holds a lookback window of unrelated papers that cannot become one
  // coherent proposal. Here, a backlog of open World PRs is precisely the thing
  // that wants attacking, and each one is already its own coherent unit.
  const batch = fresh.slice(0, MAX_PER_RUN);
  const waiting = fresh.length - batch.length;

  if (batch.length === 0) {
    // Both success paths write fresh state without the failure counters, which
    // is how a recovered check resets its streak and its backoff.
    json({ fire: false, state: { seen: [...seen], checkedAt: Date.now() } });
  } else {
    const describe = (p) => {
      const worldFiles = p.files
        .filter((f) => isWorldContent(f.path))
        .map((f) => `    ${f.path} (+${f.additions}/-${f.deletions})`)
        .join('\n');
      return `- #${p.number} ${p.title}\n  ${p.url}\n  head ${short(p)}\n${worldFiles}`;
    };

    json({
      fire: true,
      // The numbers, titles, and touched World files travel in the message
      // because the fired payload receives this string as its entire event
      // context. "A PR is open" would force the attacker to re-derive what the
      // watcher already knew.
      message:
        `${batch.length} pull request${batch.length === 1 ? '' : 's'} ` +
        'carrying World content, not yet attacked:\n' +
        batch.map(describe).join('\n') +
        (waiting > 0
          ? `\n\n${waiting} more are waiting and will be picked up on the next ` +
            'run; this run is capped so each PR gets a real read.'
          : '') +
        '\n\nAttack each one on its own terms, then post with `gh pr comment`. ' +
        'Begin every comment with the line `<!-- world-attacker head=<sha> -->` ' +
        'using that PR head above, then a sentence naming yourself and the head ' +
        'you attacked. The marker is how the next run knows this head is done, ' +
        'and the naming is because your comment posts under the maintainer\'s ' +
        'GitHub account and must not read as the maintainer\'s own words. ' +
        'Read the full diff before writing anything: ' +
        `\`gh pr diff <number> --repo ${REPO}\`. Resolve every DOI and every ` +
        'source the PR cites; a citation that does not resolve, or resolves to ' +
        'something other than what the PR says it says, is the finding. You ' +
        'approve nothing and you merge nothing, and your comment is never a ' +
        'merge signal. If a proposal survives the attack, say so in one ' +
        'sentence and post that. A manufactured objection wastes the one ' +
        'human in this pipeline, which is the only scarce thing in it.',
      state: {
        // Only the batch is marked seen. The overflow stays fresh so the next
        // run picks it up instead of losing it.
        seen: [...seen, ...batch.map(key)].slice(-KEEP),
        checkedAt: Date.now(),
      },
    });
  }
}
