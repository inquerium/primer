/**
 * The roster, as data.
 *
 * One place that says which agents exist, what class each belongs to, what it
 * may not touch, and which jobs wake it. `scripts/corps.mjs` reconciles this
 * against the running gateway, so the answer to "what is supposed to be running"
 * is a file under review rather than a shell history nobody kept.
 *
 * Registering sixteen agents by hand is how a roster drifts. A job created with
 * a flag someone forgot is invisible until the day it matters: both jobs live in
 * this repository today were registered without --timeout-seconds, which
 * docs/OPENCLAW.md requires and which is the difference between a run that fails
 * and a run that hangs for twenty minutes.
 *
 * Nothing here grants authority. Creating agents and setting exec policy are
 * operator acts, deliberately outside what this file can cause.
 */

/** Where the maintainer is reachable. Only the adjutant may use it. */
export const MAINTAINER = { channel: 'telegram', to: '8754753666' };

/** Tools no pipeline agent gets, whatever its class. */
const NEVER = ['browser', 'nodes', 'canvas', 'message'];

/** An agent that reads and reports but must not change a file. */
const READ_ONLY = [...NEVER, 'write', 'edit', 'apply_patch'];

/**
 * Timeouts, in seconds. A run that loses the network does not fail, it hangs,
 * and an unattended hang is invisible. Set a few times the observed good run.
 */
const T = { watcher: 900, review: 1200, build: 2400, brief: 600 };

/**
 * @typedef {object} Job
 * @property {string} name          Stable. Used as the reconciler's identity key.
 * @property {string} every         Duration string, e.g. '1h', '7d'.
 * @property {string} [triggerScript] Path relative to the repo root.
 * @property {string} [message]     Fallback text when there is no watcher.
 * @property {string[]} tools       Caps the run on top of the agent policy.
 * @property {number} timeoutSeconds
 * @property {boolean} [announce]   Only the adjutant should ever set this.
 */

/**
 * @typedef {object} Agent
 * @property {string} id
 * @property {'world'|'engineering'|'command'} agentClass
 * @property {string} task          One sentence. If it needs two, it is two agents.
 * @property {string[]} deny        Per the skill: deny-lists work, allow-lists resolve to zero tools.
 * @property {number} standUp       Order from docs/CORPS.md. 0 means already running.
 * @property {Job[]} jobs           Empty until the lane is stood up.
 */

/** @type {Agent[]} */
export const CORPS = [
  /* ------------------------------------------------------------- command -- */
  {
    id: 'adjutant',
    agentClass: 'command',
    task: 'Decide what reaches the maintainer, and let nothing else through.',
    // Produces English. It cannot open a pull request, fix a finding, or merge.
    deny: [...READ_ONLY, 'web_search', 'web_fetch'],
    standUp: 2,
    jobs: [
      {
        name: 'adjutant: daily brief',
        every: '24h',
        triggerScript: 'automation/watchers/adjutant-queue.js',
        tools: ['exec', 'read'],
        timeoutSeconds: T.brief,
        // The only announcing job in the corps. This is the whole design.
        announce: true,
      },
    ],
  },

  /* -------------------------------------------------------------- world -- */
  {
    id: 'world-research',
    agentClass: 'world',
    task: 'Turn learning-science literature into claims files and parameter priors.',
    deny: NEVER,
    standUp: 0,
    jobs: [
      {
        name: 'research: spacing watcher',
        every: '7d',
        triggerScript: 'automation/watchers/spacing-literature.js',
        tools: ['exec', 'read', 'write', 'edit', 'web_search', 'web_fetch'],
        timeoutSeconds: T.build,
      },
    ],
  },
  {
    id: 'world-curriculum',
    agentClass: 'world',
    task: 'Turn public standards frameworks into skill packs and prerequisite edges.',
    deny: NEVER,
    standUp: 6,
    jobs: [],
  },
  {
    id: 'world-careers',
    agentClass: 'world',
    task: 'Turn practitioner knowledge into lenses and trajectories.',
    deny: NEVER,
    standUp: 9,
    jobs: [],
  },
  {
    id: 'world-attacker',
    agentClass: 'world',
    task: 'Find the reason a World proposal is wrong. Admit nothing.',
    deny: READ_ONLY,
    standUp: 0,
    jobs: [
      {
        name: 'attacker: world proposals',
        every: '1h',
        triggerScript: 'automation/watchers/world-proposals.js',
        tools: ['exec', 'read', 'web_search', 'web_fetch'],
        timeoutSeconds: T.review,
      },
    ],
  },

  /* -------------------------------------------------------- engineering -- */
  {
    id: 'fixture-keeper',
    agentClass: 'engineering',
    task: 'Keep test/fixtures/ rich and true to the schema.',
    deny: [...NEVER, 'web_search', 'web_fetch'],
    standUp: 1,
    jobs: [
      {
        name: 'fixtures: corpus drift',
        every: '24h',
        triggerScript: 'automation/watchers/fixture-drift.js',
        tools: ['exec', 'read', 'write', 'edit'],
        timeoutSeconds: T.build,
      },
    ],
  },
  {
    id: 'model-auditor',
    agentClass: 'engineering',
    task: 'Find where the mastery model tells a lie.',
    deny: [...NEVER, 'web_search', 'web_fetch'],
    standUp: 3,
    jobs: [],
  },
  {
    id: 'misconception-miner',
    agentClass: 'engineering',
    task: 'Find stable wrong models in the evidence, unaided by any label.',
    deny: [...NEVER, 'web_search', 'web_fetch'],
    standUp: 3,
    jobs: [],
  },
  {
    id: 'accommodation-marshal',
    agentClass: 'engineering',
    task: 'Prove every generated activity honors every active accommodation.',
    deny: [...NEVER, 'web_search', 'web_fetch'],
    standUp: 4,
    jobs: [],
  },
  {
    id: 'child-sim',
    agentClass: 'engineering',
    task: 'Play a generated activity as a fixture persona and report what the record learned.',
    // The one lane that needs a browser, because playing a page is the job.
    deny: ['nodes', 'canvas', 'message'],
    standUp: 5,
    jobs: [],
  },
  {
    id: 'activity-attacker',
    agentClass: 'engineering',
    task: 'Find the reason a generated activity will fail a child. Admit nothing.',
    deny: READ_ONLY,
    standUp: 5,
    jobs: [],
  },
  {
    id: 'scheduler-critic',
    agentClass: 'engineering',
    task: 'Find pathological sequences coming out of nextTargets.',
    deny: [...NEVER, 'web_search', 'web_fetch'],
    standUp: 7,
    jobs: [],
  },
  {
    id: 'rationale-reader',
    agentClass: 'engineering',
    task: 'Hold the parent-facing rationale to the rules the prompt sets for it.',
    deny: [...NEVER, 'web_search', 'web_fetch'],
    standUp: 7,
    jobs: [],
  },
  {
    id: 'report-auditor',
    agentClass: 'engineering',
    task: 'Prove progress_report matches the evidence behind it.',
    deny: [...NEVER, 'web_search', 'web_fetch'],
    standUp: 8,
    jobs: [],
  },
  {
    id: 'invariant-sentry',
    agentClass: 'engineering',
    task: 'Confirm every exposed tool is still consciously classified.',
    deny: READ_ONLY,
    standUp: 8,
    jobs: [],
  },
  {
    id: 'privacy-sentry',
    agentClass: 'engineering',
    task: 'Confirm nothing leaks: contribution shape, CSP, artifact opacity, no learner id under world/.',
    deny: READ_ONLY,
    standUp: 8,
    jobs: [],
  },
];

export const byId = (id) => CORPS.find((a) => a.id === id);
export const running = () => CORPS.filter((a) => a.jobs.length > 0);
export const desiredJobs = () =>
  CORPS.flatMap((a) => a.jobs.map((j) => ({ ...j, agentId: a.id })));

/** Every job the roster wants, keyed by the name the reconciler matches on. */
export const desiredJobsByName = () =>
  new Map(desiredJobs().map((j) => [j.name, j]));
