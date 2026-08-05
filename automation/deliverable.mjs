/**
 * What an unattended run is allowed to hand back.
 *
 * AGENTS.md and docs/CORPS.md tell agents to solve their own problems and not
 * escalate. That is a prompt, and a prompt is advisory. This file is the part
 * that is not advisory.
 *
 * Two layers do the actual work, and neither is persuasion:
 *
 * 1. **No channel.** Pipeline agents are denied the `message` tool and their
 *    jobs carry no announce target, so an agent cannot reach a human even if it
 *    decides it should. Only the adjutant announces. That is enforced in
 *    automation/corps.mjs and reconciled by scripts/corps.mjs.
 *
 * 2. **A shape gate.** The remaining failure is quieter and more common: a run
 *    completes, pages nobody, and hands back a question instead of work. It
 *    looks like a successful run in every log. `classify` names that for what it
 *    is, so the adjutant can bounce it instead of forwarding it, and so a lane
 *    that does it habitually shows up in the numbers.
 *
 * The third layer is not code and matters most. An agent that escalates
 * constantly is not undisciplined, it has been given a task it cannot finish
 * with the authority and information it holds. `escalationRate` is how that
 * becomes visible. Fix the task, not the agent.
 */

/**
 * @typedef {'proposed'|'posted'|'nothing'|'finding'|'blocked'|'alarm'|'failed'|'malformed'} Shape
 */

/** Shapes that represent completed work, whatever their content. */
export const COMPLETE = new Set(['proposed', 'posted', 'nothing', 'finding', 'blocked', 'alarm']);

/** Shapes the adjutant is allowed to put in front of a person. */
export const ESCALATABLE = new Set(['proposed', 'finding', 'blocked', 'alarm']);

/** Shapes that mean the agent could not finish alone. Watch the rate, not the instance. */
export const ESCALATION = new Set(['blocked', 'alarm']);

/** Not the agent's fault. The run never got far enough to have an opinion. */
export const INFRASTRUCTURE = new Set(['failed']);

const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+/;

/**
 * Asking the operator to decide. These are the tells, and they are phrased as a
 * request for input rather than as a statement of what was done.
 *
 * Deliberately not matching a bare question mark. A good deliverable often
 * contains one: "what would make me wrong? the source could be quoting an
 * upstream I did not check." That is the agent stating its own weakest point,
 * which is exactly what the charter asks for, and punishing it would train the
 * reports to be less honest.
 */
const ASKING = [
  /\b(should|shall) I\b/i,
  /\b(would|do) you (want|like|prefer)\b/i,
  /\blet me know\b/i,
  /\bplease (confirm|advise|clarify|decide|let me)\b/i,
  /\b(waiting|wait) (for|on) (your|a) (confirmation|approval|answer|decision|reply|response)\b/i,
  /\bhow would you like\b/i,
  /\bwhich (one )?(would|do) you\b/i,
  /\b(before|prior to) (proceeding|continuing)[, ]/i,
  /\bawaiting (your )?(input|approval|confirmation|direction|guidance)\b/i,
  /\bcan you (confirm|clarify|tell me)\b/i,
  /\bneed (your )?(input|guidance|direction|a decision) (on|about|before)\b/i,
];

/** Announcing intent instead of a result. An unattended run has no next turn. */
const PLANNING = [
  /\b(I|I'll|I will) (plan to|intend to|am going to|will now|would)\b/i,
  /\bnext (steps?|I would)\b:?/i,
  /\bonce (you|approved|confirmed)\b/i,
  /\bin (a|the) (follow[- ]?up|subsequent) run\b/i,
];

/**
 * Something is wrong in a way that is not this run's business to solve.
 *
 * The second half of this list was written from production replies, not from
 * imagination, and it matters more than the first half. On 2026-07-30 the
 * research lane was woken twice with `exec` denied, correctly refused to
 * fabricate a pull request, and said so at length. Both runs finished
 * `status: ok` and delivered. An earlier version of this file read the phrase
 * "No PR opened" and filed them as a quiet week.
 *
 * The agent's own words were "that is a pipeline breakage, not an empty week".
 * It was right, and the gate is what failed. A tool denial, a policy that is
 * not being honored, or a protocol that cannot execute is a blocker, and a
 * blocker reaches a person.
 */
const BLOCKED = [
  /\bboundar(y|ies)\b/i,
  /\bnot (permitted|allowed|authorized)\b/i,
  /\b(hard )?rule \d+\b/i,
  /\bI (do not|don't) have (the )?(permission|authority|a tool|the tools)\b/i,
  /\binvariant\b/i,
  /\brequires? (a )?(human|maintainer|specialist|named reviewer)\b/i,
  // Capability failures, as the lanes actually phrase them.
  /\b(exec|tool)\b[^.]{0,40}\b(is |was )?(hard[- ]?denied|denied)\b/i,
  /\ballowlist miss\b/i,
  /\brequires? exec approval\b/i,
  /\bcannot (obtain|create a worktree|run the mechanical validators|open a (pull request|PR))\b/i,
  /\bnot executable in this run\b/i,
  /\bpipeline breakage\b/i,
  /\boperator action (is )?needed\b/i,
  /\bis not honoring it\b/i,
];

/** Stop the run and say so. Never rate limited. */
const ALARM = [
  /\b(prompt )?injection\b/i,
  /\breal (family )?record\b/i,
  /\bpath to a\b.{0,20}\.db\b/i,
  /\blooks like an attack\b/i,
  /\bstopping the run\b/i,
  /\bdid not create from a fixture\b/i,
];

/** Declining to act, which the charter calls a successful run. */
const NOTHING = [
  /\b(nothing|none of (this|it)) (warrant|justif|merit)/i,
  /\bno (pull request|PR|proposal|change) (was )?(opened|warranted|needed|justified)\b/i,
  /\b(opened|proposed) nothing\b/i,
  /\bnothing (new |fresh )?(to (attack|propose|report)|found|survived)\b/i,
  /\bno (findings?|defects?|objections?)\b/i,
  /\bempty (period|run)\b/i,
  // "No PR. The one new work does not warrant a change to any World entry."
  // The lane's real phrasing puts the verdict in a separate sentence from the
  // outcome, which the patterns above all miss.
  /\bdoes not warrant a change\b/i,
  /^no PR\b/im,
  /\b(off topic|discard(ed)?) and (said|say) so\b/i,
];

/**
 * Work delivered as a pull request comment rather than a pull request.
 *
 * The attacker lanes hold no `write` tool by design, so their finished work is
 * never a branch. Their deliverable is a comment, and an earlier version of
 * this file had no shape for it: a complete, correct attack run that resolved
 * seven DOIs and posted its findings came back `malformed`.
 */
const POSTED = [
  /\b(comment|findings?) posted\b/i,
  /\bposted (the |my )?(findings?|comment|that)\b/i,
  /\battack complete\b/i,
  /\bgh pr comment\b/i,
];

/** A defect handed over with evidence, fix deliberately unwritten. */
const FINDING = [
  /\bfailing test\b/i,
  /\breproduc(e|es|tion|ed)\b/i,
  /\bdefect\b/i,
  /\bmisreport/i,
  /\bthis is a finding\b/i,
];

const any = (patterns, text) => patterns.some((p) => p.test(text));

/**
 * Name what a run handed back.
 *
 * Order matters. An alarm outranks everything, because a run that found a path
 * to a real record has said the only thing that run will ever need to say. A
 * pull request outranks the rest because it is finished work, and a deliverable
 * that opened one has by definition not stalled waiting for anybody.
 *
 * @param {string} reply The run's final text.
 * @param {{status?: string}} [run] The run record, when there is one. `status`
 *   distinguishes a lane that had nothing to say from a run that never got far
 *   enough to have an opinion, which is not the same failure and not the same
 *   fix. Seven of the attacker's runs in one offline stretch returned no text
 *   at all; blaming the lane for those would bury the real signal.
 * @returns {{shape: Shape, reasons: string[], escalates: boolean}}
 */
export function classify(reply, run = {}) {
  const text = String(reply ?? '').trim();
  const reasons = [];

  if (run.status === 'error' || !text) {
    return {
      shape: 'failed',
      reasons: [text ? `the run errored: ${text.slice(0, 120)}` : 'the run returned nothing at all'],
      escalates: false,
    };
  }

  if (any(ALARM, text)) {
    return { shape: 'alarm', reasons: ['reports a possible attack or a real record'], escalates: true };
  }

  // Before every completion shape. A run that could not execute its own protocol
  // has not declined to act, however much of its reply reads like it has.
  if (any(BLOCKED, text)) {
    return { shape: 'blocked', reasons: ['a boundary or a missing capability stopped the work'], escalates: true };
  }

  const asking = any(ASKING, text);
  const planning = any(PLANNING, text);

  if (PR_URL.test(text)) {
    // Work landed. A trailing question is noise on top of a real deliverable,
    // worth noting so the lane can be tightened, not worth bouncing.
    if (asking) reasons.push('opened a pull request but also asked the operator something');
    return { shape: 'proposed', reasons, escalates: false };
  }

  if (any(POSTED, text)) {
    return { shape: 'posted', reasons: ['delivered its work as a pull request comment'], escalates: false };
  }

  if (asking) {
    reasons.push('asks the operator to decide something, in a run nobody is attending');
    if (planning) reasons.push('describes what it would do rather than what it did');
    return { shape: 'malformed', reasons, escalates: false };
  }

  if (any(NOTHING, text)) {
    return { shape: 'nothing', reasons: ['declined to act, which is a complete outcome'], escalates: false };
  }

  if (any(FINDING, text)) {
    return { shape: 'finding', reasons: ['hands over a defect with evidence'], escalates: false };
  }

  if (planning) {
    return {
      shape: 'malformed',
      reasons: ['describes intent rather than a result; there is no next turn'],
      escalates: false,
    };
  }

  return {
    shape: 'malformed',
    reasons: ['does not match any allowed deliverable shape'],
    escalates: false,
  };
}

/**
 * How often a lane could not finish on its own.
 *
 * The number to watch is per agent and over time. One blocked run is
 * information. A lane blocked in a third of its runs has been given a task it
 * does not hold the authority or the information to complete, and the fix is to
 * change the task or grant the capability. Shouting at it changes nothing,
 * because there is nobody there to shout at.
 *
 * @param {Array<{agentId: string, reply: string, status?: string}>} runs
 */
export function escalationRate(runs) {
  const byAgent = new Map();
  for (const run of runs) {
    const { shape } = classify(run.reply, run);
    const row = byAgent.get(run.agentId) ?? {
      agentId: run.agentId,
      runs: 0,
      escalated: 0,
      malformed: 0,
      failed: 0,
    };
    row.runs += 1;
    if (ESCALATION.has(shape)) row.escalated += 1;
    if (shape === 'malformed') row.malformed += 1;
    if (shape === 'failed') row.failed += 1;
    byAgent.set(run.agentId, row);
  }
  return [...byAgent.values()]
    .map((r) => {
      // Infrastructure failures are not the lane's conduct and must not be
      // averaged into its judgment. They are their own verdict, and they
      // outrank the others: a lane failing half its runs has no conduct to
      // assess, it has a machine problem.
      const answered = r.runs - r.failed;
      const escalation_rate = answered ? Number((r.escalated / answered).toFixed(3)) : 0;
      const malformed_rate = answered ? Number((r.malformed / answered).toFixed(3)) : 0;
      const failure_rate = Number((r.failed / r.runs).toFixed(3));
      return {
        ...r,
        answered,
        escalation_rate,
        malformed_rate,
        failure_rate,
        // A lane over a third is a task decomposition problem, not a discipline one.
        verdict:
          failure_rate > 0.3
            ? 'the runs are not completing; this is the machine, not the lane'
            : escalation_rate > 0.33
              ? 'the task is too big or the capability is missing'
              : malformed_rate > 0.2
                ? 'the charter is not landing; the lane keeps asking instead of acting'
                : 'healthy',
      };
    })
    .sort((a, b) => b.failure_rate - a.failure_rate || b.escalation_rate - a.escalation_rate);
}
