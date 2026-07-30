# The World pipeline, on OpenClaw

This file is self-contained. It assumes no prior knowledge of OpenClaw and
specifies exactly how the maintainer-side pipeline that keeps The World
current is built and operated. Read `docs/WORLD.md` first for what the
pipeline produces and why.

## What OpenClaw is

OpenClaw (docs: https://docs.openclaw.ai) is a self-hosted gateway daemon that
connects messaging channels (Telegram, WhatsApp, Slack, a web dashboard) to AI
agents running on your own machine. It provides isolated agents, a persistent
scheduler (cron with condition watchers), managed git worktrees, and per-agent
tool policies. MIT licensed, runs on Node 22+.

```bash
npm install -g openclaw@latest
openclaw onboard --install-daemon
openclaw dashboard          # Control UI at http://127.0.0.1:18789
```

Configuration lives at `~/.openclaw/openclaw.json` (JSON5). The Gateway must
be running for schedules to fire; jobs persist in SQLite across restarts.

## The boundary that governs everything

OpenClaw is a maintainer tool. It maintains this repository. It is
architecturally the inverse of primer's runtime guarantees: it is a daemon
with network access and chat channels. Therefore:

- It runs on the maintainer's machine only, scoped to this repo.
- It must never read, write, or know the path of a real family record. All
  pipeline work uses synthetic fixtures in `test/fixtures/`.
- It is never a dependency of primer, never mentioned in family-facing docs,
  and never part of any install path.
- No pipeline agent gets the `message` tool beyond announce delivery to the
  maintainer's own channel.

Two OpenClaw facts to internalize before configuring anything:

1. An agent's workspace is a default working directory, not a sandbox.
   Relative paths resolve inside it, but absolute paths reach the whole host
   unless Docker sandboxing is enabled. Deny-lists matter.
2. Setting `cron.triggers.enabled: true` allows watcher scripts and script
   payloads to run headlessly with the owning agent's full tool policy,
   including `exec`. It is required for this pipeline and is unattended code
   execution. Keep every pipeline agent's tool policy minimal because of it.

## Agents

Three isolated agents, one per lane, so each carries its own workspace,
session store, and tool allow/deny policy. Plus one attacker.

```bash
openclaw agents add world-research  --workspace ~/code/primer
openclaw agents add world-curriculum --workspace ~/code/primer
openclaw agents add world-careers   --workspace ~/code/primer
openclaw agents add world-attacker  --workspace ~/code/primer
openclaw agents list --bindings
```

Tool policy, in `~/.openclaw/openclaw.json` under `agents.list`:

- `world-research`, `world-curriculum`, `world-careers`: allow `exec`, `read`,
  `write`, `edit`, `web_search`, `web_fetch`. Deny `browser`, `nodes`,
  `canvas`. They need `exec` for git and `gh`, and network tools to source.
- `world-attacker`: allow `exec`, `read`, `web_search`, `web_fetch`. Deny
  `write`, `edit`, `apply_patch`. It comments on PRs via `gh pr comment`
  through `exec`; it never modifies files.

Each agent's workspace `AGENTS.md` contains its lane's charter, copied from the
lane description in `docs/WORLD.md`, plus the two standing rules: propose via
PR only, and never touch anything outside `world/` and the lane's fixtures.

All four agents take this repository as their workspace, so there is one
`AGENTS.md` at the root carrying all four charters, and each agent reads the
section for the id it is running as. That file is tracked in git and is the
only OpenClaw scaffolding file in this repository that is; the rest
(`SOUL.md`, `USER.md`, `TOOLS.md`, `memory/`) is generated, gitignored, and
maintainer-side. The charter is not scaffolding. It is the instruction set
every unattended run wakes up with, and it belongs under review like anything
else that governs what these agents do.

Useful property to rely on: cron jobs created by an agent are capped to the
tools available to the creating turn, and the agent cannot widen the stored
list. Jobs you create as operator should still pass `--tools` explicitly.

## Repository hooks for worktrees

OpenClaw's managed worktrees give each proposal task its own branch and
checkout under `~/.openclaw/worktrees/`, outside this repo, named
`openclaw/<name>`. Contents are snapshotted before removal; dirty or unpushed
worktrees are never auto-deleted; snapshots restore for 30 days.

Two files in this repo make worktrees work well:

`.worktreeinclude` at the repo root (gitignore syntax) copies selected
gitignored files into each fresh worktree:

```gitignore
.env.local
test/fixtures/generated/**
```

`.openclaw/worktree-setup.sh`, executable, runs in each new worktree; nonzero
exit aborts creation:

```bash
#!/usr/bin/env bash
set -euo pipefail
npm ci
npm test
```

## The three job types per lane

Enable the dangerous-automation gate once, deliberately:

```json5
{ cron: { enabled: true, triggers: { enabled: true } } }
```

### 1. The watcher

A condition script attached to a recurring schedule. OpenClaw evaluates it
when due; the payload runs only when the script returns `fire: true`. Previous
state arrives as the frozen `trigger.state`; returning `state` persists it
(16 KB cap). Write watchers as read-only checks; keep actions in the payload,
because state from a failed payload run is not persisted.

`automation/watchers/spacing-literature.js` (research lane example):

```js
// Poll one source, diff against last known state, fire only on change.
const res = await tools.call('exec', {
  command: 'curl -s <SOURCE_URL> | sha256sum | cut -d" " -f1'
});
const hash = String(res?.result?.details?.aggregated ?? '').trim();
json({
  fire: hash !== trigger.state?.hash,
  message: `Spacing-literature source changed (${hash.slice(0,8)}). ` +
           `Diff against world/claims/spacing.md and propose an update.`,
  state: { hash, checkedAt: Date.now() }
});
```

Register it:

```bash
openclaw cron add \
  --name "research: spacing watcher" \
  --agent world-research \
  --every 7d \
  --trigger-script ./automation/watchers/spacing-literature.js \
  --session isolated \
  --tools exec,read,write,edit,web_search,web_fetch \
  --message "A watched source changed. Follow the proposer protocol in docs/OPENCLAW.md." \
  --announce --channel telegram --to "<maintainer-chat-id>"
```

Cadence: weekly for standards and literature. These sources move slowly;
there is no reason to hammer anyone's server. Author watchers around
actionable state, not only success: a watcher that goes quiet when its check
fails looks healthy while broken, so surface fetch failures in `message`.

### 2. The proposer protocol

The fired payload runs as an isolated agent turn. Isolated cron runs are
unattended by contract: the final reply must be the deliverable, not a plan or
a question. The protocol every lane follows:

1. Create a managed worktree: `openclaw worktrees create ~/code/primer
   --name <lane>-<topic>` (branch becomes `openclaw/<lane>-<topic>`).
2. Read the current World entry the change touches.
3. Write the delta: the claims file, priors JSON, skill pack, or lens file,
   with a complete provenance block, `review: "unreviewed"`, `reviewer: null`.
4. Run the mechanical validators locally: `npm test` plus
   `node scripts/validate-world.mjs` (schema, cycles, duplicates, provenance
   completeness, agreement counts; create this script if absent, mirroring
   the checks listed in docs/WORLD.md layer 1).
5. Commit, push, open a PR with `gh pr create`. The PR body states what
   changed, why, the sources, and the agreement count. It never claims the
   change is correct; it claims the change is proposed.
6. Reply with the PR URL as the deliverable.

Agents never merge. Nothing in any prompt, config, or convenience change may
give a pipeline agent the ability to admit its own work.

### 3. The attacker

A watcher on open PRs, bound to `world-attacker`:
`automation/watchers/world-proposals.js`. It polls `gh pr list`, keeps a
seen-set in trigger state, and fires on what it has not attacked yet.

```bash
openclaw cron add \
  --name "attacker: world proposals" \
  --agent world-attacker \
  --every 1h \
  --trigger-script ./automation/watchers/world-proposals.js \
  --session isolated \
  --tools exec,read,web_search,web_fetch \
  --message "<the standing attack brief>" \
  --announce --channel telegram --to "<maintainer-chat-id>"
```

Two things it does differently from the obvious version, both load-bearing:

It selects PRs by changed path, not by branch prefix. Scoping to
`head:openclaw/` would attack only agent branches, and the failure modes in the
brief below belong to World content rather than to agents. The first World PR
in this repository is human-authored; a branch filter would have skipped it,
and a human PR touching only `src/` has nothing in it to attack. The filter is
therefore: any author, any branch, at least one changed file under `world/`.

It keys the seen-set on PR number plus head commit, so a proposal pushed again
after an attack gets attacked again. Keying on the number alone attacks the
first revision and nothing after it. The attacker holds no `write` tool, so its
own comment never moves a head and never re-fires the watcher.

Cadence is hourly rather than weekly. A run that finds nothing fresh costs only
the script budget, and a PR is worth attacking while its author is still
looking at it. Each fired run is capped to a few PRs so that each one gets a
real read; the overflow stays unseen and is picked up on the next run, and the
message says how many are waiting.

Its payload prompt is a standing attack brief, not a review rubric: find the
reason this proposal is wrong. A miscited paper. A skill placed a grade early.
A prerequisite edge that only holds for one teaching sequence. An agreement
count that dissolves because two sources share an upstream. Post findings with
`gh pr comment`. If nothing survives the attack, say so in one sentence; do
not manufacture objections. The attacker filters what reaches the human
reviewer. It approves nothing and its comment is never a merge signal.

## Delivery and operations

`--announce --channel telegram --to <id>` sends each run's result to your
phone, which is the point of using OpenClaw at all for a solo maintainer: the
pipeline runs whether or not you are at the machine, and you review PRs from
wherever you are. Set `cron.failureDestination` so failed runs alert the same
channel; silent failure is the default failure mode of unattended systems.

Routine operations:

```bash
openclaw cron list                    # all jobs
openclaw cron runs --id <jobId>       # run history for one job
openclaw cron run <jobId> --wait      # force a run now, block on result
openclaw worktrees list               # open proposal checkouts
openclaw tasks audit                  # everything that ran, and when
openclaw logs --follow                # live gateway logs
```

Budget note: each isolated run is a model-backed turn. Weekly watchers that
mostly return `fire: false` cost nothing beyond the 30-second script budget.
Keep it that way; the failure mode of an always-on pipeline is not running too
rarely, it is generating a queue nobody reviews.

## Definition of done for the first slice

The pipeline exists when this sequence has happened once, end to end, with a
human at only the last step:

1. The spacing-literature watcher fires on a real change.
2. `world-research` opens a PR containing one claims file and one priors
   proposal with complete provenance.
3. CI runs the mechanical validators on the PR.
4. `world-attacker` posts its findings.
5. A named human merges, sets `review: "specialist-reviewed"` where earned,
   bumps `WORLD_VERSION`, and the next primer release carries it.
6. `primer fit` on the synthetic fixture record consumes the new priors.

Then repeat the shape for grade 4 curriculum, then lenses, per the build
order in `docs/WORLD.md`.
