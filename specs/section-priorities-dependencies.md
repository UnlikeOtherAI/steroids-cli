# Section Priorities & Dependencies

## Overview
Allow sections to have priorities and dependencies on other sections.

## Database Schema

### Migration: Add priority to sections
```sql
ALTER TABLE sections ADD COLUMN priority INTEGER DEFAULT 50;
-- Priority 0 = highest, 100 = lowest, 50 = default
```

### Migration: Add section_dependencies table
```sql
CREATE TABLE section_dependencies (
  id TEXT PRIMARY KEY,
  section_id TEXT NOT NULL REFERENCES sections(id),
  depends_on_section_id TEXT NOT NULL REFERENCES sections(id),
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(section_id, depends_on_section_id)
);
```

## CLI Commands

### Set priority
```bash
steroids sections priority <section-id> <priority>
steroids sections priority <section-id> high    # Sets to 10
steroids sections priority <section-id> medium  # Sets to 50
steroids sections priority <section-id> low     # Sets to 90
steroids sections priority <section-id> 25      # Sets to 25
```

### Add dependency
```bash
steroids sections depends-on <section-id> <depends-on-section-id>
# Example: Phase 0.8 depends on Phase 0.7
steroids sections depends-on 52379b10 e01c44f6
```

### Remove dependency
```bash
steroids sections no-depends-on <section-id> <depends-on-section-id>
```

### View dependency graph
```bash
steroids sections graph
# Output:
# Phase 0.4: Global Runner Registry (priority: 10) [IN PROGRESS]
#   └─> Phase 0.7: Section Focus (priority: 20)
#       └─> Phase 0.8: Priorities & Dependencies (priority: 30)
# Phase 2: Configuration (priority: 50) [BLOCKED by Phase 0.5]
#   └─> Phase 3: Hooks System
```

### List with dependencies
```bash
steroids sections list --deps
# Shows dependencies inline
```

## Task Selection Changes

1. Order sections by: unmet dependencies (blocked last), then priority, then position
2. Skip sections where any dependency has incomplete tasks
3. Show [BLOCKED] indicator in section list

## Mermaid Output

```bash
steroids sections graph --mermaid
# Outputs Mermaid flowchart syntax:
# graph TD
#     A[Phase 0.4] --> B[Phase 0.7]
#     B --> C[Phase 0.8]
```

Can be pasted into GitHub markdown, Notion, or any Mermaid renderer.
