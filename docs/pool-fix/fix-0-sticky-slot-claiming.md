# Fix 0: Sticky Slot Claiming — Task-ID Affinity in claimSlot

**Design reference**: `docs/pool-workspace-path-fix.md`, Section 4, Fix 0

## Background

Pool slots are partially released (back to idle) between the coder and reviewer phases to allow other runners to claim them. However `partialReleaseSlot` preserves the `task_id` so the reviewer can reclaim the exact same slot.

`claimSlot` today uses a bare `LIMIT 1` with no ordering, so the reviewer can claim any idle slot — not necessarily the one with the task's commits. This is the prerequisite for all other pool fixes.

## Changes Required

### File: `src/workspace/pool.ts`

**1. Update the primary idle-slot SELECT (lines 69–75)**

```sql
-- Before:
SELECT * FROM workspace_pool_slots
WHERE project_id = ? AND status = 'idle'
LIMIT 1

-- After:
SELECT * FROM workspace_pool_slots
WHERE project_id = ? AND status = 'idle'
ORDER BY CASE WHEN task_id = ? THEN 0 ELSE 1 END, id ASC
LIMIT 1
```

Update the `.get()` call to pass the second binding:
```ts
// Before (silently binds NULL to task_id = ?):
.get(projectId)

// After:
.get(projectId, taskId)
```

**2. Update the race-condition retry SELECT (lines 120–126)**

Same SQL and binding change as above. This is the path hit when a UNIQUE constraint fires during slot creation.

**3. Update `partialReleaseSlot` JSDoc**

Add explicit comment so future maintainers understand why `task_id` must NOT be cleared:

```ts
/**
 * Partially release a slot back to idle, preserving workspace fields
 * (task_id, task_branch, base_branch, starting_sha) so the reviewer phase
 * can reclaim this exact slot via the task-affine claimSlot SELECT.
 * Do NOT clear task_id — it is the primary affinity key for sticky claiming.
 *
 * Only clears runner-tracking fields (runner_id, claimed_at, heartbeat_at).
 */
```

## Tests Required

Create `tests/workspace-pool-slot-affinity.test.ts`:

1. **Basic affinity**: After `partialReleaseSlot`, `claimSlot(projectId, runnerId2, taskId)` returns the same slot ID
2. **Two-task isolation**: When two tasks each have their own idle slot, each `claimSlot` call reclaims the matching slot by task ID
3. **FIFO fallback**: A fresh task with no prior slot still gets a slot (creates new one or grabs FIFO)
4. **Retry path**: Force the UNIQUE constraint retry path and verify it also returns the task-matching slot

## Acceptance Criteria

- Both idle-slot SELECTs use `ORDER BY CASE WHEN task_id = ? THEN 0 ELSE 1 END, id ASC`
- Both `.get()` calls use `.get(projectId, taskId)` (not just `.get(projectId)`)
- `partialReleaseSlot` has the updated JSDoc explaining task_id preservation
- All tests in `tests/workspace-pool-slot-affinity.test.ts` pass
- `npm run build && npm test` passes
