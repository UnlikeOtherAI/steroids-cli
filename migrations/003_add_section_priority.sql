-- Migration: Add priority column to sections table
-- Priority 0 = highest, 100 = lowest, 50 = default

-- UP
ALTER TABLE sections ADD COLUMN priority INTEGER DEFAULT 50;

-- Create index for priority-based queries
CREATE INDEX IF NOT EXISTS idx_sections_priority ON sections(priority);

-- DOWN
-- Note: SQLite doesn't support DROP COLUMN directly
-- Would need to recreate table without the column
-- For now, this migration is considered forward-only
