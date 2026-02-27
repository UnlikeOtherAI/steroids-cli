-- Migration: Add auto_pr and pr_number columns to sections table
-- Enables per-section auto-PR creation when all tasks complete (branch-targeting Phase 3)

-- UP
ALTER TABLE sections ADD COLUMN auto_pr INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sections ADD COLUMN pr_number INTEGER;

-- DOWN
-- Note: SQLite doesn't support DROP COLUMN directly
-- Forward-only migration
