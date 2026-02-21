-- Migration: Add follow-up task fields to support non-blocking improvements
-- Reviewers can suggest these instead of blocking approvals.

-- UP
ALTER TABLE tasks ADD COLUMN description TEXT CHECK(length(description) <= 4000);
ALTER TABLE tasks ADD COLUMN reference_commit TEXT;
ALTER TABLE tasks ADD COLUMN reference_commit_message TEXT;
ALTER TABLE tasks ADD COLUMN reference_task_id TEXT REFERENCES tasks(id);
ALTER TABLE tasks ADD COLUMN is_follow_up INTEGER NOT NULL DEFAULT 0 CHECK(is_follow_up IN (0, 1));
ALTER TABLE tasks ADD COLUMN requires_promotion INTEGER NOT NULL DEFAULT 0 CHECK(requires_promotion IN (0, 1));
ALTER TABLE tasks ADD COLUMN follow_up_depth INTEGER NOT NULL DEFAULT 0 CHECK(follow_up_depth >= 0);
ALTER TABLE tasks ADD COLUMN dedupe_key TEXT;

-- Indexes for follow-up management
CREATE INDEX IF NOT EXISTS idx_tasks_reference_task ON tasks(reference_task_id) WHERE reference_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_follow_up_state ON tasks(is_follow_up, requires_promotion) WHERE is_follow_up = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_dedupe ON tasks(dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_selection_followup ON tasks(status, is_follow_up, requires_promotion);

-- DOWN
-- SQLite doesn't support DROP COLUMN.
-- Migration is forward-only for existing table modification.
DROP INDEX IF EXISTS idx_tasks_selection_followup;
DROP INDEX IF EXISTS idx_tasks_dedupe;
DROP INDEX IF EXISTS idx_tasks_follow_up_state;
DROP INDEX IF EXISTS idx_tasks_reference_task;
