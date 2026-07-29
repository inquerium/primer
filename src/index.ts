/** primer — an open learner record. Library surface. */

export * from './domain/types.ts';
export * from './domain/bkt.ts';
export { nextTargets, frontier, type TargetOptions } from './domain/scheduler.ts';

export { db, dbPath, primerHome, closeDb, now, id, all, one, run, tx } from './db/index.ts';

export { loadCurriculum, readPacks, findCycle, curriculumDir } from './curriculum/load.ts';

export {
  createLearner,
  getLearner,
  listLearners,
  resolveLearner,
  ageYears,
  addAccommodation,
  accommodations,
  noteInterest,
  interests,
} from './record/learners.ts';

export {
  recordObservations,
  evidenceFor,
  startSession,
  endSession,
  noteAffect,
  noteMisconception,
  resolveMisconception,
  type ObservationInput,
} from './record/observations.ts';

export { ingest, recompute, getMastery, currentP } from './record/mastery.ts';
export { learnerContext, type ContextOptions } from './record/context.ts';
export { progressReport, exportRecord } from './record/report.ts';

export {
  saveInterface,
  listInterfaces,
  getInterface,
  readInterfaceHtml,
  scoreInterface,
  renderInterface,
} from './surface/store.ts';
export { createSurfaceServer } from './surface/server.ts';

export { startMcpServer } from './mcp/server.ts';
export { TUTOR_PROMPT } from './mcp/prompt.ts';
export { seedDemo } from './demo.ts';

export { importRecord } from './record/report.ts';
export {
  planActivity,
  queue,
  readyCount,
  pendingReview,
  approve,
  reject,
  nextReady,
  markDelivered,
  markDone,
  recentReviewFeedback,
  type PlannedActivity,
  type ActivityStatus,
} from './record/queue.ts';

export { runTutor, recentRuns, type RunResult, type RunOptions } from './agent/tutor.ts';
export { decide, tick, watch, type Decision, type TickResult } from './agent/daemon.ts';
export { settings, setSetting, budget, costOf, type Settings } from './agent/config.ts';
export {
  runClaudeCode,
  buildArgs,
  claudeBinary,
  AUTONOMOUS_TOOLS,
  type ClaudeCodeResult,
} from './agent/claude-code.ts';
export { AUTONOMOUS_PROMPT } from './agent/prompt.ts';
