# Fix 2: Direct .steroids Symlink — Thread sourceProjectPath Through ensureSlotClone

**Design reference**: `docs/pool-workspace-path-fix.md`, Section 4, Fix 2

## Background

`ensureSlotClone` receives `projectPath` (a workstream clone path in parallel mode) and uses it for both:
1. **Git clone source** — cloning from the workstream is correct (fast, local, uses hardlinks)
2. **`.steroids` symlink target** — creating `pool-N/.steroids → workstream/.steroids` is wrong

The workstream's `.steroids` is itself a symlink to the real project's `.steroids`. This creates a two-hop chain that breaks when the workstream directory is cleaned up or the inner symlink is stale. The pool workspace then fails with "Steroids not initialized" when trying to access the database.

The fix separates the two roles by adding `sourceProjectPath` (the real project root) explicitly.

## Changes Required

### File: `src/workspace/pool.ts` — `ensureSlotClone` signature

Add a `sourceProjectPath` parameter (the real project root, used only for the `.steroids` symlink):

```ts
export function ensureSlotClone(
  slot: PoolSlot,
  remoteUrl: string | null,
  cloneSourcePath: string,      // git clone source (workstream clone or real project)
  sourceProjectPath: string,    // .steroids symlink target (always the real project root)
): void {
  // ... existing clone logic using cloneSourcePath ...

  // Symlink always targets real project, never the workstream clone
  ensureWorkspaceSteroidsSymlink(slotPath, sourceProjectPath);
}
```

### File: `src/workspace/git-lifecycle.ts` — `prepareForTask` signature

Add `sourceProjectPath` parameter and pass it to both calls to `ensureSlotClone`:

```ts
export function prepareForTask(
  globalDb: Database.Database,
  slot: PoolSlot,
  taskId: string,
  projectPath: string,          // clone source (workstream or project root for non-parallel)
  sourceProjectPath: string,    // symlink target (same as projectPath for non-parallel)
  sectionBranch: string | null = null,
  configBranch: string | null = null
): PrepareResult {
  // Primary call (line ~71):
  ensureSlotClone(slot, slot.remote_url, projectPath, sourceProjectPath);

  // Re-clone fallback (line ~162):
  ensureSlotClone(slot, slot.remote_url, projectPath, sourceProjectPath);
}
```

Both calls to `ensureSlotClone` within `prepareForTask` must pass `sourceProjectPath`.

### File: `src/commands/loop-phases-coder.ts` — pass sourceProjectPath to prepareForTask

The coder phase calls `prepareForTask`. Update to pass `sourceProjectPath` explicitly:

```ts
const prepResult = prepareForTask(
  poolSlotContext.globalDb,
  poolSlotContext.slot,
  task.id,
  projectPath,            // clone source (workstream clone path)
  sourceProjectPath,      // symlink target (real project root)
  sectionBranch,
  configBranch
);
```

`sourceProjectPath` is threaded from the orchestrator via the `runCoderPhase` signature. Add it as a parameter with a default fallback for non-parallel callers:

```ts
export async function runCoderPhase(
  db, task, projectPath, action, jsonMode,
  coordinatorCache, coordinatorThresholds, leaseFence, branchName,
  poolSlotContext?: PoolSlotContext,
  sourceProjectPath: string = projectPath   // defaults to projectPath for non-parallel
)
```

### File: `src/runners/orchestrator-loop.ts` — pass sourceProjectPath to runCoderPhase

After Fix 1, `sourceProjectPath` is already computed (as `parallelSourceProjectPath ?? projectPath`). Pass it as the last argument to `runCoderPhase`.

**Reviewer phase**: `runReviewerPhase` does NOT call `prepareForTask` or `ensureSlotClone` — confirmed in `loop-phases-reviewer.ts:132–142`. The `.steroids` symlink is established by the coder's `prepareForTask` and survives `partialReleaseSlot`. `runReviewerPhase` does not need a `sourceProjectPath` parameter.

## Tests Required

Create or extend `tests/workspace-pool-symlink.test.ts`:

- After `ensureSlotClone(slot, remoteUrl, cloneSourcePath, sourceProjectPath)`, verify that `pool-N/.steroids` resolves (via `realpathSync`) to `sourceProjectPath/.steroids`, NOT to `cloneSourcePath/.steroids`
- Verify this holds even when `cloneSourcePath` and `sourceProjectPath` differ

## Acceptance Criteria

- `ensureSlotClone` has 4 parameters: `slot, remoteUrl, cloneSourcePath, sourceProjectPath`
- `prepareForTask` has `sourceProjectPath` parameter and passes it to both `ensureSlotClone` calls (primary + re-clone fallback at line ~162)
- `runCoderPhase` has `sourceProjectPath` parameter (default = `projectPath`)
- `orchestrator-loop.ts` passes `sourceProjectPath` to `runCoderPhase`
- Pool workspace `.steroids` symlink resolves directly to `<real-project>/.steroids`
- `npm run build && npm test` passes
