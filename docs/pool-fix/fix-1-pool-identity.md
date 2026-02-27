# Fix 1: Correct Pool Identity — Use Source Project Path

**Design reference**: `docs/pool-workspace-path-fix.md`, Section 4, Fix 1

## Background

Pool slots are namespaced by `getProjectHash(projectPath)`. In parallel workstream mode, `projectPath` is the workstream clone path (e.g., `docgen/31e854b162c3b924/ws-c1131d72-1`), not the real project root. Each workstream session therefore gets a unique pool namespace — isolation that should not exist. The real project root is already resolved at the top of `runOrchestratorLoop` as `parallelSourceProjectPath`.

## Change Required

**File**: `src/runners/orchestrator-loop.ts` — pool setup block (~lines 440–447)

```ts
// Before (wrong — uses workstream clone path for pool identity):
const projectId = getProjectHash(projectPath);
const remoteUrl = resolveRemoteUrl(projectPath);
const slot = claimSlot(gdb.db, projectId, options.runnerId, task.id);
const finalSlot = finalizeSlotPath(gdb.db, slot.id, projectPath, remoteUrl);

// After (correct — uses real project root for pool identity):
const sourceProjectPath = parallelSourceProjectPath ?? projectPath;
const projectId = getProjectHash(sourceProjectPath);
const remoteUrl = resolveRemoteUrl(sourceProjectPath);
const slot = claimSlot(gdb.db, projectId, options.runnerId, task.id);
const finalSlot = finalizeSlotPath(gdb.db, slot.id, sourceProjectPath, remoteUrl);
```

`parallelSourceProjectPath` is already computed at line 140 via `resolveParallelSourceProjectPath(options.parallelSessionId)`. No new state, no new DB calls.

**Effect**: All pool slots for the docgen project will live under `~/.steroids/workspaces/31e854b162c3b924/pool-N/` regardless of which workstream session runs them. Idle slots are shared and reused across sessions.

## Tests Required

Add a test in `tests/workspace-pool-identity.test.ts` (or a relevant existing test file):

- Verify that `getProjectHash(sourceProjectPath)` differs from `getProjectHash(workstreamClonePath)` for a realistic workstream path, confirming the bug exists and the fix addresses the right thing.

## Acceptance Criteria

- Pool setup block uses `parallelSourceProjectPath ?? projectPath` for both `getProjectHash` and `resolveRemoteUrl`
- `finalizeSlotPath` receives `sourceProjectPath` not `projectPath` (workstream clone)
- `npm run build && npm test` passes
