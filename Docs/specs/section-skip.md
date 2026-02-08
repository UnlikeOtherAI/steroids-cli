# Section Skip Feature

> Allow marking sections as "skipped" to defer their tasks during development.

## Overview

When a section is marked as **skipped**, the orchestrator loop will not pull tasks from that section. This is useful for:

- Future development phases not ready to start
- Temporarily parking work on a feature
- Focusing the loop on specific priorities

## Database Changes

### Migration: 003_add_section_skipped.sql

```sql
-- UP
ALTER TABLE sections ADD COLUMN skipped INTEGER NOT NULL DEFAULT 0;

-- DOWN
-- SQLite doesn't support DROP COLUMN, so we recreate the table
CREATE TABLE sections_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sections_new SELECT id, name, position, created_at FROM sections;
DROP TABLE sections;
ALTER TABLE sections_new RENAME TO sections;
```

## CLI Commands

### `steroids sections skip <id|name>`

Mark a section as skipped.

```bash
steroids sections skip "Phase 10: Web UI"
steroids sections skip abc123
```

**Behavior:**
1. Find section by ID (exact or prefix match) or by name (exact match)
2. Set `skipped = 1` in database
3. Print confirmation: `Section "Phase 10: Web UI" is now skipped`

### `steroids sections unskip <id|name>`

Re-enable a skipped section.

```bash
steroids sections unskip "Phase 10: Web UI"
```

**Behavior:**
1. Find section by ID or name
2. Set `skipped = 0` in database
3. Print confirmation: `Section "Phase 10: Web UI" is now active`

### `steroids sections list` changes

- **Default behavior**: Hide skipped sections
- **`--all` flag**: Show all sections including skipped ones
- **Display**: Skipped sections show `[SKIPPED]` marker

```
SECTIONS
──────────────────────────────────────────────────────────────
ID        NAME                                          TASKS
──────────────────────────────────────────────────────────────
fd1fcbcc  Phase 2: Configuration                        7
dc781391  Phase 0.5: CLI Contract                       8
af1af290  Phase 10: Web UI [SKIPPED]                    23
```

## Task Selector Changes

Update `src/orchestrator/task-selector.ts` to exclude tasks from skipped sections.

### Current query (example):
```sql
SELECT t.* FROM tasks t
LEFT JOIN sections s ON t.section_id = s.id
WHERE t.status = 'pending'
ORDER BY COALESCE(s.position, 999999), t.created_at
```

### Updated query:
```sql
SELECT t.* FROM tasks t
LEFT JOIN sections s ON t.section_id = s.id
WHERE t.status = 'pending'
  AND (s.skipped = 0 OR s.skipped IS NULL)
ORDER BY COALESCE(s.position, 999999), t.created_at
```

Apply this to all three task queries:
1. Review tasks query
2. In-progress tasks query
3. Pending tasks query

## Watch Command Changes

Update `src/commands/watch.ts` to display `[SKIPPED]` indicator for skipped sections in the real-time status display.

## Implementation Tasks

1. **Migration**: Create `migrations/003_add_section_skipped.sql`
2. **Manifest**: Update `migrations/manifest.json`
3. **Queries**: Add `skipSection()`, `unskipSection()`, `getSectionByName()` to queries.ts
4. **Skip command**: Implement in sections.ts
5. **Unskip command**: Implement in sections.ts
6. **List update**: Add `--all` flag and hide skipped by default
7. **Task selector**: Update all three queries to exclude skipped sections
8. **Watch display**: Show `[SKIPPED]` indicator

## Testing

- Skip a section with tasks, verify `loop` doesn't pick those tasks
- Unskip the section, verify tasks become available
- Verify `sections list` hides/shows skipped sections correctly
- Verify `--all` flag works
