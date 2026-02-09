-- Migration: Add skipped column to sections table
-- Allows sections to be excluded from runner processing (e.g., "Needs User Input")

-- UP
ALTER TABLE sections ADD COLUMN skipped INTEGER DEFAULT 0;

-- DOWN
-- Note: SQLite doesn't support DROP COLUMN directly
-- Forward-only migration
