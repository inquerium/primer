-- Open Learner Record v0.1
-- One file per family. Evidence is immutable; everything else is derived.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------- learner ---

CREATE TABLE IF NOT EXISTS learner (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  birth_date   TEXT,               -- ISO date; used only for grade-band defaults
  locale       TEXT NOT NULL DEFAULT 'en-US',
  timezone     TEXT,
  pronouns     TEXT,
  created_at   TEXT NOT NULL,
  archived_at  TEXT
);

CREATE TABLE IF NOT EXISTS accommodation (
  id         TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,        -- typography | audio_first | no_timers | contrast | pacing | motor | attention | language
  detail     TEXT NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  set_by     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_accom_learner ON accommodation(learner_id, active);

CREATE TABLE IF NOT EXISTS interest (
  id         TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  topic      TEXT NOT NULL,
  weight     REAL NOT NULL DEFAULT 1.0,
  source     TEXT,                 -- observed | parent | self_report | tutor
  last_seen  TEXT NOT NULL,
  note       TEXT,
  UNIQUE(learner_id, topic)
);

CREATE TABLE IF NOT EXISTS goal (
  id          TEXT PRIMARY KEY,
  learner_id  TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  text        TEXT NOT NULL,
  set_by      TEXT,                -- parent | teacher | learner | tutor
  target_date TEXT,
  status      TEXT NOT NULL DEFAULT 'open',  -- open | met | dropped
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS note (
  id          TEXT PRIMARY KEY,
  learner_id  TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  author_role TEXT NOT NULL,       -- parent | teacher | tutor | specialist
  text        TEXT NOT NULL,
  visibility  TEXT NOT NULL DEFAULT 'all',   -- all | adults_only
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_note_learner ON note(learner_id, created_at DESC);

-- -------------------------------------------------------------- curriculum ---

CREATE TABLE IF NOT EXISTS skill (
  id          TEXT PRIMARY KEY,
  domain      TEXT NOT NULL,       -- reading | writing | math
  strand      TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  grade_band  TEXT,                -- pk | k | 1 | 2 | 3
  ordinal     INTEGER NOT NULL DEFAULT 0,
  probe       TEXT,                -- JSON: how to generate an item for this skill
  tags        TEXT,                -- JSON array
  -- BKT priors, per skill, tunable
  p_init      REAL NOT NULL DEFAULT 0.15,
  p_learn     REAL NOT NULL DEFAULT 0.20,
  p_guess     REAL NOT NULL DEFAULT 0.20,
  p_slip      REAL NOT NULL DEFAULT 0.10
);
CREATE INDEX IF NOT EXISTS idx_skill_domain ON skill(domain, strand, ordinal);

CREATE TABLE IF NOT EXISTS skill_edge (
  from_skill TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  to_skill   TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL DEFAULT 'prerequisite',  -- prerequisite | component | extends
  PRIMARY KEY (from_skill, to_skill, kind)
);
CREATE INDEX IF NOT EXISTS idx_edge_to ON skill_edge(to_skill, kind);

-- ------------------------------------------------------------------ state ---

CREATE TABLE IF NOT EXISTS mastery (
  learner_id     TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  skill_id       TEXT NOT NULL REFERENCES skill(id) ON DELETE CASCADE,
  p_known        REAL NOT NULL,
  opportunities  INTEGER NOT NULL DEFAULT 0,
  correct        INTEGER NOT NULL DEFAULT 0,
  streak         INTEGER NOT NULL DEFAULT 0,
  half_life_days REAL NOT NULL DEFAULT 3.0,
  last_seen      TEXT,
  next_due       TEXT,
  status         TEXT NOT NULL DEFAULT 'unseen',    -- unseen | learning | mastered | lapsed
  PRIMARY KEY (learner_id, skill_id)
);
CREATE INDEX IF NOT EXISTS idx_mastery_due ON mastery(learner_id, next_due);
CREATE INDEX IF NOT EXISTS idx_mastery_status ON mastery(learner_id, status);

CREATE TABLE IF NOT EXISTS session (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  started_at    TEXT NOT NULL,
  ended_at      TEXT,
  mode          TEXT,              -- play | practice | assess | story | free
  target_skills TEXT,              -- JSON array of skill ids
  interface_id  TEXT,
  summary       TEXT,              -- tutor's own end-of-session note
  energy        TEXT               -- high | ok | low | done
);
CREATE INDEX IF NOT EXISTS idx_session_learner ON session(learner_id, started_at DESC);

-- Evidence. Append-only. Never UPDATE, never DELETE.
CREATE TABLE IF NOT EXISTS observation (
  id          TEXT PRIMARY KEY,
  learner_id  TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  skill_id    TEXT REFERENCES skill(id) ON DELETE SET NULL,
  session_id  TEXT,
  ts          TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'attempt',  -- attempt | probe | self_report | tutor_judgment | artifact_review
  correct     REAL,              -- 1 | 0 | fractional for partial credit
  latency_ms  INTEGER,
  hint_count  INTEGER NOT NULL DEFAULT 0,
  item        TEXT,              -- what was actually asked
  response    TEXT,              -- what the child actually did
  expected    TEXT,
  modality    TEXT,              -- spoken | typed | drawn | selected | manipulated
  source      TEXT,              -- interface id, 'tutor', 'parent', 'import'
  supersedes  TEXT REFERENCES observation(id),
  meta        TEXT               -- JSON escape hatch
);
CREATE INDEX IF NOT EXISTS idx_obs_learner_ts ON observation(learner_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_skill ON observation(learner_id, skill_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_obs_session ON observation(session_id);

CREATE TABLE IF NOT EXISTS misconception (
  id             TEXT PRIMARY KEY,
  learner_id     TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  skill_id       TEXT REFERENCES skill(id) ON DELETE SET NULL,
  pattern        TEXT NOT NULL,   -- short, specific, falsifiable
  example        TEXT,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  first_seen     TEXT NOT NULL,
  last_seen      TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active',   -- active | fading | resolved
  strategy       TEXT             -- what has been tried / what worked
);
CREATE INDEX IF NOT EXISTS idx_misc_learner ON misconception(learner_id, status);

CREATE TABLE IF NOT EXISTS affect (
  id         TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  session_id TEXT,
  ts         TEXT NOT NULL,
  signal     TEXT NOT NULL,       -- frustration | delight | flow | fatigue | boredom | pride
  intensity  REAL NOT NULL DEFAULT 0.5,
  evidence   TEXT
);
CREATE INDEX IF NOT EXISTS idx_affect_learner ON affect(learner_id, ts DESC);

-- ------------------------------------------------------- generated surfaces ---

-- The memory of what interfaces worked for this child.
CREATE TABLE IF NOT EXISTS interface (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  kind          TEXT,             -- game | drill | story | canvas | manipulative | reader | quiz
  path          TEXT NOT NULL,    -- file on disk
  spec          TEXT,             -- JSON: the design decisions behind it
  target_skills TEXT,             -- JSON array
  created_at    TEXT NOT NULL,
  times_used    INTEGER NOT NULL DEFAULT 0,
  outcome_score REAL,             -- 0..1, derived from what happened inside it
  outcome_note  TEXT
);
CREATE INDEX IF NOT EXISTS idx_iface_learner ON interface(learner_id, created_at DESC);

CREATE TABLE IF NOT EXISTS artifact (
  id         TEXT PRIMARY KEY,
  learner_id TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  session_id TEXT,
  ts         TEXT NOT NULL,
  kind       TEXT NOT NULL,       -- audio | image | writing | drawing | video
  path       TEXT NOT NULL,
  mime       TEXT,
  caption    TEXT,
  skill_ids  TEXT                 -- JSON array
);
CREATE INDEX IF NOT EXISTS idx_artifact_learner ON artifact(learner_id, ts DESC);

-- ------------------------------------------------------------------ audit ---

CREATE TABLE IF NOT EXISTS event_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  ts      TEXT NOT NULL,
  actor   TEXT NOT NULL,          -- tutor:claude | cli | parent | import
  action  TEXT NOT NULL,
  target  TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_event_ts ON event_log(ts DESC);
