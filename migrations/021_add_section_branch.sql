-- Migration: Add branch column to sections table
-- Allows per-section git branch targeting (branch-targeting Phase 2)

-- UP
ALTER TABLE sections ADD COLUMN branch TEXT;

-- DOWN
-- Note: SQLite doesn't support DROP COLUMN directly
-- Forward-only migration
