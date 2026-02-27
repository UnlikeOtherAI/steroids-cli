# Fix 3: Skip Coder-Phase Push in Pool Mode

**Design reference**: `docs/pool-workspace-path-fix.md`, Section 4, Fix 3

## Background

After the coder phase, `executeCoderDecision` pushes the task branch to the remote (in parallel mode). However in pool mode, the coder's commits are on the pool workspace branch, not the workstream branch. The push in `loop-phases-coder-decision.ts` sends the wrong branch from the wrong directory — it pushes the workstream branch (unchanged) while the actual task commits remain local inside the pool workspace.

The pool merge pipeline (`mergeToBase` in `git-lifecycle.ts`) already handles pushing the task branch correctly with `--force-with-lease`. The coder-phase push is redundant in pool mode and actively harmful.

## Changes Required

### File: `src/commands/loop-phases-coder-decision.ts`

**1. Add `hasPoolSlot` to `CoderExecutionContext` interface:**

```ts
export interface CoderExecutionContext {
  coderStdout: string;
  has_uncommitted: boolean;
  requiresExplicitSubmissionCommit: boolean;
  effectiveProjectPath: string;
  projectPath: string;
  branchName: string;
  leaseFence?: LeaseFenceContext;
  jsonMode: boolean;
  hasPoolSlot: boolean;   // NEW — true when running inside a pool workspace
}
```

**2. Update all three push guards to skip in pool mode:**

There are THREE push guards in this file (not one). All three must be updated identically:

- Line ~213: `case 'submit'` path
- Line ~264: `case 'stage_commit_submit'` / no-uncommitted subpath
- Line ~336: `case 'stage_commit_submit'` / after-auto-commit subpath

Change all three from:
```ts
if (leaseFence?.parallelSessionId) {
  const pushResult = pushToRemote(projectPath, 'origin', branchName);
  // ...
}
```

To:
```ts
// Skip push in pool mode: mergeToBase handles all pushing atomically.
// Only push in legacy workstream mode (no pool slot).
if (leaseFence?.parallelSessionId && !ctx.hasPoolSlot) {
  const pushResult = pushToRemote(projectPath, 'origin', branchName);
  // ...
}
```

### File: `src/commands/loop-phases-coder.ts`

**3. Populate `hasPoolSlot` in the context object:**

When building `CoderExecutionContext` (around lines 441–450), add the field explicitly:

```ts
const coderCtx: CoderExecutionContext = {
  coderStdout,
  has_uncommitted,
  requiresExplicitSubmissionCommit,
  effectiveProjectPath,
  projectPath,
  branchName,
  leaseFence,
  jsonMode,
  hasPoolSlot: poolSlotContext !== undefined,   // NEW
};
```

## Tests Required

Add tests in `tests/loop-phases-coder-decision.test.ts` (or extend existing):

- `executeCoderDecision` with `hasPoolSlot: true` and `leaseFence.parallelSessionId` set does NOT call `pushToRemote`
- `executeCoderDecision` with `hasPoolSlot: false` and `leaseFence.parallelSessionId` set DOES call `pushToRemote`
- Both `submit` and `stage_commit_submit` paths are tested (covering all three guard sites)

## Acceptance Criteria

- `CoderExecutionContext.hasPoolSlot: boolean` field added
- All THREE push guards have `&& !ctx.hasPoolSlot` condition
- Context constructor includes `hasPoolSlot: poolSlotContext !== undefined`
- Tests pass for both pool and non-pool push behavior
- `npm run build && npm test` passes
