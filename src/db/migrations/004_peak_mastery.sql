-- 004: remember the high-water mark of what a child once knew.
--
-- Without it, "lapsed" cannot mean what the word means. A child who has had three
-- correct answers among many wrong ones was being reported as having *lost* a skill
-- she never held — a false statement about a child, shown to their parent.
--
-- Existing rows are seeded from current belief, which is the best guess available
-- for history already written. Anything reconstructed by `primer recompute` gets
-- the true peak.
ALTER TABLE mastery ADD COLUMN peak_p_known REAL;
UPDATE mastery SET peak_p_known = p_known WHERE peak_p_known IS NULL;
