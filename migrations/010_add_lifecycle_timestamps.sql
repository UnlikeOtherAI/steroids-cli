-- Migration: Add lifecycle timestamps to task_invocations
-- Tracks invocation start/completion separately from created_at so we can show live running state.

-- UP

-- Add start/complete timestamps to track invocation lifecycle
ALTER TABLE task_invocations ADD COLUMN started_at_ms INTEGER;
ALTER TABLE task_invocations ADD COLUMN completed_at_ms INTEGER;
ALTER TABLE task_invocations ADD COLUMN status TEXT DEFAULT 'completed'
  CHECK(status IN ('running', 'completed', 'failed', 'timeout'));

-- Backfill existing rows (all are completed)
UPDATE task_invocations
SET started_at_ms = CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER),
    completed_at_ms = CAST((julianday(created_at) - 2440587.5) * 86400000 AS INTEGER),
    status = 'completed'
WHERE started_at_ms IS NULL;

-- Index for finding running invocations
CREATE INDEX IF NOT EXISTS idx_task_invocations_task_status
  ON task_invocations(task_id, status, started_at_ms DESC);

-- DOWN
-- Note: SQLite doesn't support DROP COLUMN in older versions.
-- This migration is effectively forward-only; rollback only removes the index.
DROP INDEX IF EXISTS idx_task_invocations_task_status;

