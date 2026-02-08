-- Migration: Add section_dependencies table for section dependency tracking
-- Allows sections to declare dependencies on other sections

-- UP
CREATE TABLE section_dependencies (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id),
  depends_on_section_id TEXT NOT NULL REFERENCES sections(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(section_id, depends_on_section_id)
);

-- Create indexes for efficient dependency queries
CREATE INDEX IF NOT EXISTS idx_section_dependencies_section ON section_dependencies(section_id);
CREATE INDEX IF NOT EXISTS idx_section_dependencies_depends_on ON section_dependencies(depends_on_section_id);

-- DOWN
DROP TABLE IF EXISTS section_dependencies;
