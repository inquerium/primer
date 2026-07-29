-- 003: the child's own voice.
--
-- Reading fluency cannot be assessed from taps. You have to hear it — the pauses,
-- the self-corrections, whether they are reading in phrases or word by word. It is
-- also the thing a parent actually wants in five years, and no worksheet app keeps it.
--
-- The model cannot listen to these. A human can, and the record is built so a human
-- reviewing an artifact writes evidence back the same way any other observation does
-- (`observation.kind = 'artifact_review'`).

ALTER TABLE artifact ADD COLUMN duration_ms INTEGER;
ALTER TABLE artifact ADD COLUMN mime_type TEXT;
ALTER TABLE artifact ADD COLUMN prompt TEXT;          -- what they were asked to read or do
ALTER TABLE artifact ADD COLUMN transcript TEXT;      -- filled in by a human, or later by a model
ALTER TABLE artifact ADD COLUMN reviewed_at TEXT;
ALTER TABLE artifact ADD COLUMN reviewed_by TEXT;
ALTER TABLE artifact ADD COLUMN bytes INTEGER;

CREATE INDEX IF NOT EXISTS idx_artifact_kind ON artifact(learner_id, kind, ts DESC);

-- Recording a child is not a default. An adult turns this on deliberately, and the
-- change is written to the audit log like every other setting.
INSERT OR IGNORE INTO setting (key, value, updated_at, updated_by) VALUES
  ('audio_capture', 'false', datetime('now'), 'default'),
  ('artifact_retention_days', '0', datetime('now'), 'default');  -- 0 = keep forever
