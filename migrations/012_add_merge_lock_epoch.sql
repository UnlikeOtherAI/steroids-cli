-- Add lock epoch fencing to merge locks
ALTER TABLE merge_locks ADD COLUMN lock_epoch INTEGER NOT NULL DEFAULT 1;

-- Backfill existing rows to deterministic per-row epoch values
UPDATE merge_locks
SET lock_epoch = id
WHERE lock_epoch IS NULL OR lock_epoch = 1;

CREATE INDEX IF NOT EXISTS idx_merge_locks_epoch ON merge_locks(session_id, lock_epoch);
