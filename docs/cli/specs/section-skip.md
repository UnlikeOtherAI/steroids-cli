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
-- Must disable foreign keys and wrap in transaction due to section_locks FK
PRAGMA foreign_keys=OFF;
BEGIN TRANSACTION;
CREATE TABLE sections_new (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    position INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
INSERT INTO sections_new SELECT id, name, position, created_at FROM sections;
DROP TABLE sections;
ALTER TABLE sections_new RENAME TO sections;
COMMIT;
PRAGMA foreign_keys=ON;
```

### TypeScript Interface Update

Update `Section` interface in `src/database/queries.ts`:

```typescript
export interface Section {
  id: string;
  name: string;
  position: number;
  skipped: number;  // 0 = active, 1 = skipped
  created_at: string;
}
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

Update task selection queries in **TWO locations**:

1. **`src/database/queries.ts`** - `findNextTask()` function (3 queries)
2. **`src/orchestrator/task-selector.ts`** - `findNextTaskSkippingLocked()` function (3 queries)

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

Apply this WHERE clause addition to all SIX queries across both files:
- Review tasks query (status = 'review')
- In-progress tasks query (status = 'in_progress')
- Pending tasks query (status = 'pending')

## Watch Command Changes

If `steroids watch` command exists, update it to display `[SKIPPED]` indicator for skipped sections. Otherwise, skip this task.

## Implementation Tasks

1. **Migration**: Create `migrations/003_add_section_skipped.sql`
2. **Manifest**: Update `migrations/manifest.json` (bump latestDbVersion to 3)
3. **Interface & Queries**: Update `Section` interface to add `skipped` field, add `skipSection()` and `unskipSection()` functions to queries.ts (note: `getSectionByName()` already exists)
4. **Skip command**: Implement in sections.ts
5. **Unskip command**: Implement in sections.ts
6. **List update**: Add `--all` flag, hide skipped by default, update `listSections()` query
7. **Task selector**: Update queries in BOTH `queries.ts` AND `task-selector.ts` (6 queries total)
8. **Watch display**: Show `[SKIPPED]` indicator (if watch command exists)

## Testing

- Skip a section with tasks, verify `loop` doesn't pick those tasks
- Unskip the section, verify tasks become available
- Verify `sections list` hides/shows skipped sections correctly
- Verify `--all` flag works
