# Section Focus Feature

> Allow runners to focus on a specific section, ignoring tasks from other sections.

## Prerequisites

**This feature depends on Phase 0.6 (Section Skip) being implemented first.**

The skip check in task queries (`s.skipped = 0 OR s.skipped IS NULL`) must exist before this feature can be added. If implementing before Phase 0.6, omit the skipped filtering.

## Overview

When starting a runner or loop with the `--section` flag, the orchestrator will only pull tasks from that specific section. This is useful for:

- Dedicating a runner to a specific phase/feature
- Parallel development with multiple runners on different sections
- Testing changes in isolation before moving to other sections

## Relationship to Section Skip

| Feature | Purpose | Scope |
|---------|---------|-------|
| **Section Skip** | Globally exclude a section from all runners | Project-wide |
| **Section Focus** | Limit a specific runner to one section | Per-runner |

These features complement each other:
- Skip = "nobody works on this section"
- Focus = "this runner ONLY works on this section"

## CLI Changes

### `steroids loop --section <id|name>`

Run the orchestrator loop focused on a single section.

```bash
steroids loop --section "Phase 2: Configuration"
steroids loop --section fd1fcbcc
steroids loop --section fd1f  # Prefix match
```

**Behavior:**
1. Resolve section by ID (exact or prefix) or name (exact match)
2. Task selector only considers tasks from that section
3. Display shows which section is focused
4. Exit when all tasks in that section are complete (not all project tasks)

### `steroids runners start --section <id|name>`

Start a runner daemon focused on a single section.

```bash
steroids runners start --section "Phase 3: Hooks" --detach
```

**Behavior:**
1. Runner only picks tasks from the specified section
2. Multiple runners can focus on different sections simultaneously
3. Section focus is stored with runner metadata

### Display Changes

When running with `--section`, show the focus in the header:

```
╔════════════════════════════════════════════════════════════╗
║                    STEROIDS ORCHESTRATOR                   ║
║              Focused: Phase 2: Configuration               ║
╚════════════════════════════════════════════════════════════╝

Task Status (Phase 2 only):
  Pending:     5
  In Progress: 1
  Review:      0
  Completed:   1
  ─────────────────
  Total:       7
```

## Implementation

### Task Selector Changes

Update `findNextTask()` and `findNextTaskSkippingLocked()` to accept an optional `sectionId` parameter:

```typescript
interface TaskSelectionOptions {
  runnerId: string;
  timeoutMinutes?: number;
  noWait?: boolean;
  sectionId?: string;  // NEW: Focus on this section only
}
```

### Query Changes

When `sectionId` is provided, add `AND t.section_id = ?` to WHERE clause:

```sql
-- Without focus (after Phase 0.6)
SELECT t.* FROM tasks t
LEFT JOIN sections s ON t.section_id = s.id
WHERE t.status = 'pending'
  AND (s.skipped = 0 OR s.skipped IS NULL)  -- Added by Phase 0.6
ORDER BY COALESCE(s.position, 999999), t.created_at

-- With focus (this feature adds section_id filter)
SELECT t.* FROM tasks t
LEFT JOIN sections s ON t.section_id = s.id
WHERE t.status = 'pending'
  AND (s.skipped = 0 OR s.skipped IS NULL)  -- From Phase 0.6
  AND t.section_id = ?                       -- Focus filter (this feature)
ORDER BY t.created_at
```

Note: When focused, section position ordering is unnecessary (single section).

**If implementing before Phase 0.6:** Omit the `s.skipped` filtering. The focus filter (`t.section_id = ?`) works independently.

### Loop Command Changes

Update `src/commands/loop.ts`:

1. Add `--section` option to parseArgs
2. Resolve section ID from input (ID, prefix, or name)
3. Pass `sectionId` to task selection
4. Update display header to show focus
5. Modify completion check to only consider focused section

### Runner Metadata

Store section focus in runner record. The runners table is in the **global database** (`~/.steroids/steroids.db`), not the per-project database.

Current schema in `src/runners/global-db.ts`:

```typescript
interface Runner {
  id: string;
  pid: number;
  project_path: string;
  section_id?: string;  // NEW: Focused section (add this column)
  started_at: string;
}
```

**To add the column:**
1. Update `GLOBAL_SCHEMA_SQL` in `src/runners/global-db.ts`
2. Bump `GLOBAL_SCHEMA_VERSION` from `'1'` to `'2'`
3. The global database uses `IF NOT EXISTS` patterns, so existing tables may need `ALTER TABLE` handling

## Edge Cases

### Focused section is skipped

If `--section` specifies a skipped section:
- Show warning: "Section 'X' is currently skipped"
- Offer to unskip: "Run `steroids sections unskip X` first"
- Exit with error

### Section has no pending tasks

If focused section has no actionable tasks:
- Show: "No pending tasks in section 'X'"
- If `--section` used with loop, exit cleanly
- Don't fall back to other sections

### Invalid section

If section ID/name not found:
- Error: "Section not found: X"
- Show available sections
- Exit with error code

## Implementation Tasks

**Dependency:** Phase 0.6 (Section Skip) should be completed first for full functionality.

1. **Loop command**: Add `--section` flag to `src/commands/loop.ts` with section resolution (by ID, prefix, or name)
2. **Runner start**: Add `--section` flag to `src/commands/runners.ts`
3. **Task selector**: Add `sectionId` parameter to `TaskSelectionOptions` and update selection functions
4. **Query update**: Modify task queries to add `AND t.section_id = ?` when sectionId is provided
5. **Display**: Update loop header to show focused section name
6. **Completion check**: Modify to check only focused section tasks when sectionId is set
7. **Validation**: Add section validation - error if section not found; if Phase 0.6 complete, also error if skipped
8. **Runner metadata**: Add `section_id` column to runners table in global database (`src/runners/global-db.ts`), bump schema version

## Testing

- Start loop with `--section`, verify only that section's tasks are picked
- Start two runners with different `--section` values, verify parallel operation
- Try to focus on a skipped section, verify error
- Focus on section with no tasks, verify clean exit
- Verify task counts only reflect focused section
