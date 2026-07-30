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

// The turn that fires attacks every PR named in the message. Each one is a
// close read of a diff plus source resolution, so a run that names ten is a
// run that reads none of them properly. Overflow is not dropped, it waits for
// the next run, and the message says how many are waiting.
const MAX_PER_RUN = 3;

// ~50 bytes per entry against a 16 KB state cap.
const KEEP = 200;

let prs = null;
let failure = '';
try {
  const res = await tools.call('exec', {
    command:
      `gh pr list --repo ${REPO} --state open --limit 50 ` +
      '--json number,title,headRefName,headRefOid,isDraft,url,files',
  });
  const body = JSON.parse(String(res?.result?.details?.aggregated ?? ''));
  if (!Array.isArray(body)) {
    failure = 'unexpected gh response shape (expected a JSON array)';
  } else {
    prs = body;
  }
} catch (err) {
  failure = String(err).slice(0, 200);
}

if (failure) {
  // A watcher that returns fire: false when its check breaks is
  // indistinguishable from a healthy watcher with nothing to report. Expired
  // gh auth is the likely cause and it fails silently forever. Preserve the
  // existing state rather than returning fresh state: wiping it would re-attack
  // every open PR on the next successful run.
  json({
    fire: true,
    message:
      `WATCHER BROKEN (world-proposals): the gh check failed: ${failure}. ` +
      'Post no PR comments from this run. Diagnose the watcher and report. ' +
      'Check `gh auth status` first.',
    state: trigger.state,
  });
} else {
  // Keyed by head commit, not PR number. A proposer that pushes a fix in
  // response to an attack has produced a different proposal, and the previous
  // attack no longer applies to it. Keying on number alone would attack the
  // first revision of a PR and nothing after it. The attacker cannot write, so
  // its own comment never moves the head and never re-fires this.
  const seen = new Set(trigger.state?.seen ?? []);
  const key = (p) => `${p.number}@${String(p.headRefOid ?? '').slice(0, 12)}`;

  const candidates = prs.filter(
    (p) =>
      !p.isDraft && // a draft is not a proposal yet
      Array.isArray(p.files) &&
      p.files.some((f) => isWorldContent(f.path)),
  );
  const fresh = candidates.filter((p) => !seen.has(key(p)));

  // No silent cold-start seed here, unlike the research watcher. There, a first
  // run holds a lookback window of unrelated papers that cannot become one
  // coherent proposal. Here, a backlog of open World PRs is precisely the thing
  // that wants attacking, and each one is already its own coherent unit.
  const batch = fresh.slice(0, MAX_PER_RUN);
  const waiting = fresh.length - batch.length;

  if (batch.length === 0) {
    json({ fire: false, state: { seen: [...seen], checkedAt: Date.now() } });
  } else {
    const describe = (p) => {
      const worldFiles = p.files
        .filter((f) => isWorldContent(f.path))
        .map((f) => `    ${f.path} (+${f.additions}/-${f.deletions})`)
        .join('\n');
      return `- #${p.number} ${p.title}\n  ${p.url}\n${worldFiles}`;
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
