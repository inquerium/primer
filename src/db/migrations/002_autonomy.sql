-- 002: autonomous tutoring.
--
-- The tutor stops being something a human drives turn by turn and becomes
-- something that runs on its own between sessions. Three things that needs:
-- a queue of what the child will meet next, a log of what the tutor did and
-- what it cost, and somewhere to put the settings that govern both.

-- What is waiting for the child. The child's screen reads from here and
-- nothing else — they never see a model, a prompt, or a URL someone had to
-- hand them.
CREATE TABLE IF NOT EXISTS planned_activity (
  id            TEXT PRIMARY KEY,
  learner_id    TEXT NOT NULL REFERENCES learner(id) ON DELETE CASCADE,
  interface_id  TEXT REFERENCES interface(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  -- Written for the adult, not the child: why this, why now.
  rationale     TEXT,
  target_skills TEXT,              -- JSON array
  position      INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'pending_review',
  -- pending_review | ready | delivered | done | skipped | rejected
  planned_for   TEXT,              -- ISO date this is meant for, if any
  created_by    TEXT NOT NULL DEFAULT 'tutor:claude',
  created_at    TEXT NOT NULL,
  reviewed_by   TEXT,
  reviewed_at   TEXT,
  review_note   TEXT,
  delivered_at  TEXT,
  completed_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_planned_learner
  ON planned_activity(learner_id, status, position);

-- Every autonomous run, what triggered it, what it decided, what it cost.
-- A parent must be able to ask "what has this thing been doing" and get an
-- answer with numbers attached.
CREATE TABLE IF NOT EXISTS agent_run (
  id             TEXT PRIMARY KEY,
  learner_id     TEXT REFERENCES learner(id) ON DELETE CASCADE,
  trigger        TEXT NOT NULL,    -- session_ended | scheduled | manual | backlog_empty
  started_at     TEXT NOT NULL,
  ended_at       TEXT,
  status         TEXT NOT NULL DEFAULT 'running',  -- running | ok | error | skipped | over_budget
  model          TEXT,
  turns          INTEGER NOT NULL DEFAULT 0,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd       REAL NOT NULL DEFAULT 0,
  activities     INTEGER NOT NULL DEFAULT 0,
  summary        TEXT,
  error          TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_started ON agent_run(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_run_learner ON agent_run(learner_id, started_at DESC);

-- Per-install configuration. Deliberately a table and not a config file: the
-- settings that govern an autonomous system belong in the audited record.
CREATE TABLE IF NOT EXISTS setting (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT
);

INSERT OR IGNORE INTO setting (key, value, updated_at, updated_by) VALUES
  -- An adult approves each generated activity before a child ever sees it.
  -- On by default. Turning it off is a deliberate act, and it is logged.
  ('review_required',    'true',  datetime('now'), 'default'),
  ('daily_budget_usd',   '1.00',  datetime('now'), 'default'),
  ('monthly_budget_usd', '15.00', datetime('now'), 'default'),
  ('queue_target',       '3',     datetime('now'), 'default'),
  ('model',              'claude-opus-5', datetime('now'), 'default'),
  ('effort',             'high',  datetime('now'), 'default'),
  ('min_hours_between_runs', '4', datetime('now'), 'default');
