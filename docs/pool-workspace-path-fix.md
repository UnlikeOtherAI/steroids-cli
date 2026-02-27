# Pool Workspace Path Fix

**Status**: Draft — Round 2 adversarial review complete; ready for implementation
**Related**: `src/workspace/pool.ts`, `src/runners/orchestrator-loop.ts`, `src/commands/loop-phases-coder-decision.ts`, `src/workspace/git-lifecycle.ts`

---

## 1. Problem Statement

Commits made by the coder are silently lost when running in parallel workstream mode. A task completes, a commit exists in the pool workspace, yet the reviewer cannot find it — triggering commit recovery that also fails. The task loops until it is abandoned.

This was confirmed in production on task `db888493` (docgen project, 2026-02-27).

---

## 2. Current Behavior

### How workstream runners work

When a parallel session runs, each workstream gets a **clone** of the project at a path like:

```
/path/to/docgen/31e854b162c3b924/ws-c1131d72-1/
```

This clone path becomes `projectPath` inside the runner (`orchestrator-loop.ts:131`).

### How pool slots are set up

Each loop iteration, before invoking the coder or reviewer, the runner claims a pool slot (`orchestrator-loop.ts:436–465`):

```ts
const projectId = getProjectHash(projectPath);          // line 440
const remoteUrl = resolveRemoteUrl(projectPath);        // line 441
const slot = claimSlot(gdb.db, projectId, ...);
const finalSlot = finalizeSlotPath(gdb.db, slot.id, projectPath, remoteUrl);
```

`projectPath` here is the **workstream clone path**, not the source project root.

### Bug 1 — Pool identity based on workstream path

`getProjectHash` computes `SHA1(resolve(projectPath)).slice(0, 16)`. When `projectPath` is the workstream clone, each parallel session gets a **unique hash** for its pool. Session `c1131d72` created pool `2df84f038e271516/pool-0`. Recovery session `247c78a8` created `f7f7b163288b88bb/pool-0`. Neither can see the other's git objects.

Expected: all runners for the same project share a pool namespace keyed by the **source project path** (`31e854b162c3b924`), so idle slots are reused across sessions.

The source project path is already resolved at the top of `runOrchestratorLoop` (`orchestrator-loop.ts:140`):

```ts
const parallelSourceProjectPath = resolveParallelSourceProjectPath(options.parallelSessionId);
// → '/path/to/docgen'  (looked up from parallel_sessions.project_path in global DB)
```

It is never passed to the pool setup code.

### Bug 2 — `.steroids` symlink points to workstream, not project

`ensureSlotClone(slot, remoteUrl, projectPath)` (pool.ts:317, called from git-lifecycle.ts:71) creates a symlink:

```
pool-0/.steroids  →  <projectPath>/.steroids
                 =  ws-c1131d72-1/.steroids  (workstream symlink, not the real project)
```

`ws-c1131d72-1/.steroids` is itself a symlink to `docgen/.steroids`. The pool symlink target follows a two-hop chain. If the workstream directory is cleaned up or the inner symlink is stale, `pool-0/.steroids` becomes a dangling link. When the coder or reviewer process (running inside the pool workspace) tries `steroids` CLI commands, it fails with:

```
Steroids not initialized. Expected database at: …/pool-0/.steroids/steroids.db
```

The coder tolerates this (non-fatal); the reviewer exits on it (fatal), killing the runner.

Expected: `pool-0/.steroids` is a **direct** symlink to the real project's `.steroids` directory — always `docgen/.steroids`, never going through the workstream.

### Bug 3 — Push sends wrong branch from wrong directory

After the coder phase, when submitting a task to review in parallel mode, `executeCoderDecision` pushes to the remote (`loop-phases-coder-decision.ts:213–227`):

```ts
if (leaseFence?.parallelSessionId) {
  const pushResult = pushToRemote(projectPath, 'origin', branchName);
  // projectPath = workstream clone (ws-c1131d72-1)
  // branchName  = workstream branch (steroids/ws-c1131d72-1)
```

The coder's commits are on the **pool slot** at `effectiveProjectPath` on branch `steroids/task-<taskId>`. The workstream clone has no knowledge of those commits. This push succeeds silently — it pushes the unchanged workstream branch — while the task commits remain local-only inside the pool workspace.

The pool merge pipeline (`mergeToBase` in `git-lifecycle.ts`) already handles pushing the task branch correctly (step 6: push task branch with `--force-with-lease`; step 8: push base branch after ff-merge). This push in `loop-phases-coder-decision.ts` is **completely redundant in pool mode** and actively harmful because it bypasses the merge pipeline.

Expected: the pre-review push is skipped when a pool slot context is active.

---

## 3. Desired Behavior

- All pool slots for a project share a single namespace keyed by the **source project path** (`SHA1(real-project-path)`). Idle slots are reused across parallel sessions.
- `pool-N/.steroids` is always a direct symlink to `<real-project>/.steroids`. No chains.
- In pool mode, the coder-phase push is skipped. The pool merge pipeline is the sole authority for pushing commits to the remote.
- Commit loss is structurally impossible **in the normal flow**: commits are pushed via `mergeToBase` before the slot is released, and the reviewer operates on the same slot (same git objects). (Edge case: if a crash or reconciliation zeroes out `task_id` before the reviewer phase, Fix 0's affinity logic falls back to FIFO — same behavior as today, no regression.)

---

## 4. Design

### Fix 0 — Sticky slot claiming (prerequisite for all other fixes)

This fix is prerequisite: without it, the reviewer may claim a different pool slot than the coder used, making commits unreachable regardless of all other fixes.

`claimSlot` currently uses a bare `SELECT ... WHERE project_id = ? AND status = 'idle' LIMIT 1` with no ordering and no task affinity (`pool.ts:69–75`). After `partialReleaseSlot`, the coder's slot is `idle` but has `task_id` preserved. If multiple slots exist for the same project, the reviewer could claim any of them.

`claimSlot` already accepts `taskId`. There are **two** idle-slot SELECT queries that need updating: the primary one at line 69–75, and the race-condition retry path at line 120–126. Both must be updated identically.

Change **both** idle-slot SELECTs to prefer the slot whose `task_id` matches the current task:

```sql
SELECT * FROM workspace_pool_slots
WHERE project_id = ? AND status = 'idle'
ORDER BY CASE WHEN task_id = ? THEN 0 ELSE 1 END, id ASC
LIMIT 1
```

The `.get()` call must bind **both** parameters:

```ts
// Before (wrong — only binds project_id, task_id binding is missing)
.get(projectId)

// After (correct — binds project_id, then taskId for the CASE expression)
.get(projectId, taskId)
```

The `claimSlot` function signature does not change. `taskId` is already a parameter. If no task-matching slot exists (e.g., fresh task start), the fallback is FIFO by `id ASC`, which is deterministic.

Additionally, add an explicit comment to `partialReleaseSlot` explaining why `task_id` is **not** cleared on partial release:

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

This makes slot reuse **task-affine**: the reviewer will always reclaim the coder's slot (with its task branch and commits) unless it was somehow taken by another runner, which cannot happen since partial release sets `runner_id = NULL` and the slot is only claimed by one runner at a time per the `IMMEDIATE` transaction.

### Fix 1 — Use source project path for pool identity

In `orchestrator-loop.ts`, the pool setup block becomes:

```ts
// Before (wrong):
const projectId = getProjectHash(projectPath);
const remoteUrl = resolveRemoteUrl(projectPath);
const finalSlot = finalizeSlotPath(gdb.db, slot.id, projectPath, remoteUrl);

// After (correct):
const sourceProjectPath = parallelSourceProjectPath ?? projectPath;
const projectId = getProjectHash(sourceProjectPath);
const remoteUrl = resolveRemoteUrl(sourceProjectPath);
const finalSlot = finalizeSlotPath(gdb.db, slot.id, sourceProjectPath, remoteUrl);
```

`parallelSourceProjectPath` is already computed at line 140. This is a three-line change. No new state, no new functions.

**Effect**: Slots for docgen will always be under `~/.steroids/workspaces/31e854b162c3b924/pool-N/`. All sessions share the same pool. Idle slots from previous sessions are reused rather than orphaned.

### Fix 2 — Thread source project path through ensureSlotClone / prepareForTask

`ensureSlotClone` and `prepareForTask` currently receive one path that serves two roles: git clone source and `.steroids` symlink target. These must be separated.

#### `pool.ts` — add `sourceProjectPath` parameter

```ts
export function ensureSlotClone(
  slot: PoolSlot,
  remoteUrl: string | null,
  cloneSourcePath: string,      // used for: git clone (can be workstream — fast, local)
  sourceProjectPath: string,    // used for: .steroids symlink (always real project root)
): void {
  // ... existing clone logic using cloneSourcePath ...

  // Symlink always targets real project, never a workstream
  ensureWorkspaceSteroidsSymlink(slotPath, sourceProjectPath);
}
```

#### `git-lifecycle.ts` — add `sourceProjectPath` to `prepareForTask`

```ts
export function prepareForTask(
  globalDb: Database.Database,
  slot: PoolSlot,
  taskId: string,
  projectPath: string,          // workstream clone (or project root for non-parallel)
  sourceProjectPath: string,    // real project root (same as projectPath for non-parallel)
  sectionBranch: string | null = null,
  configBranch: string | null = null
): PrepareResult {
  ensureSlotClone(slot, slot.remote_url, projectPath, sourceProjectPath);
  // ... rest unchanged ...
}
```

#### `loop-phases-coder.ts` — pass source project path

```ts
const prepResult = prepareForTask(
  poolSlotContext.globalDb,
  poolSlotContext.slot,
  task.id,
  projectPath,              // clone source (workstream or project)
  sourceProjectPath,        // symlink target (always real project root)
  sectionBranch,
  configBranch
);
```

`sourceProjectPath` is threaded explicitly from `orchestrator-loop.ts` where `parallelSourceProjectPath` is already available. This is the cleanest approach: the contract is explicit with no hidden lookups or DB queries.

`runCoderPhase` signature gains one **required** parameter (not optional — making it optional would allow silent regressions where a caller omits it and falls back to the wrong path):

```ts
export async function runCoderPhase(
  db, task, projectPath, action, jsonMode,
  coordinatorCache, coordinatorThresholds, leaseFence, branchName,
  poolSlotContext?: PoolSlotContext,
  sourceProjectPath: string = projectPath  // required with fallback for non-parallel callers
)
```

For non-parallel runners, `sourceProjectPath` defaults to `projectPath` — same behavior as today.

**Re-clone fallback**: Inside `prepareForTask` there is a second call to `ensureSlotClone` at `git-lifecycle.ts:162` (the re-clone fallback path when the slot directory is corrupted). Since `sourceProjectPath` is now an in-scope parameter of `prepareForTask`, this second call must also pass it:

```ts
// Re-clone fallback (line ~162 in git-lifecycle.ts)
ensureSlotClone(slot, slot.remote_url, projectPath, sourceProjectPath);
//                                     ^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^
//                                     clone source symlink target
```

Both calls to `ensureSlotClone` within `prepareForTask` must pass `sourceProjectPath`.

**Reviewer phase note**: `runReviewerPhase` does **not** call `prepareForTask` or `ensureSlotClone` (confirmed `loop-phases-reviewer.ts:132–142`). It only sets `effectiveProjectPath = slot.slot_path` and runs commit resolution. The `.steroids` symlink was established by the coder's `prepareForTask` and is preserved across `partialReleaseSlot` (symlinks survive `git clean -fd -e .steroids`). Therefore, `runReviewerPhase` does **not** need a `sourceProjectPath` parameter.

### Fix 3 — Skip coder-phase push in pool mode

There are **three** push guards in `loop-phases-coder-decision.ts` (not one), all with the same pattern:

- Line 213: `case 'submit'` path
- Line 264: `case 'stage_commit_submit'` / no-uncommitted subpath
- Line 336: `case 'stage_commit_submit'` / after-auto-commit subpath

All three must be updated identically.

In `loop-phases-coder-decision.ts`, the `CoderExecutionContext` interface gains one field:

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

All three push guards become:

```ts
// Skip push in pool mode: mergeToBase handles all pushing atomically.
// Only push in legacy workstream mode (no pool slot).
if (leaseFence?.parallelSessionId && !ctx.hasPoolSlot) {
  const pushResult = pushToRemote(projectPath, 'origin', branchName);
  // ...
}
```

`hasPoolSlot` is set in `loop-phases-coder.ts` when building the `CoderExecutionContext` passed to `executeCoderDecision`. The context object construction (around lines 441–450) must include the field explicitly:

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

Without this explicit assignment, TypeScript will reject the call (the field is required).

---

## 5. Implementation Order

Fixes are sequenced by dependency, not independence. Fix 0 is prerequisite for structural safety.

| Phase | Change | Files | Risk |
|-------|--------|-------|------|
| 0 | Sticky slot claiming (task-id affinity in SQL) | `src/workspace/pool.ts` | Low — 2-line SQL change |
| 1 | Fix pool identity (source project path) | `src/runners/orchestrator-loop.ts` | Low — 3 lines |
| 2 | Fix `.steroids` symlink (thread sourceProjectPath) | `src/workspace/pool.ts`, `src/workspace/git-lifecycle.ts`, `src/commands/loop-phases-coder.ts`, `src/runners/orchestrator-loop.ts` | Medium — new parameter across 4 files |
| 3 | Skip push in pool mode (all 3 guards) | `src/commands/loop-phases-coder-decision.ts`, `src/commands/loop-phases-coder.ts` | Low — 3 guard conditions + 1 interface field |

Phases 0 and 1 together make the pool namespace correct and slot assignment deterministic. Phase 2 eliminates the `.steroids` failure mode. Phase 3 removes the redundant/harmful push. All four are required for structural commit safety.

---

## 6. Edge Cases

| Scenario | Handling |
|----------|----------|
| Non-parallel runner (no `parallelSessionId`) | `parallelSourceProjectPath` is `null`; `sourceProjectPath = projectPath` — behavior unchanged |
| Project has no remote URL | Pool mode is already skipped (`!remoteUrl` → `console.warn` and no slot claimed); no change needed |
| Existing stale pool slots from wrong hash | On next run, the correct hash produces a new slot. Old slots sit idle forever. A follow-up `steroids workspaces clean` command can purge orphaned slots. |
| Reviewer claims different slot than coder used | Fixed by Fix 0. Task-id affinity in `claimSlot` ensures the reviewer always reclaims the coder's slot (which has `task_id` preserved via `partialReleaseSlot`). If no task-matching slot is idle, FIFO fallback applies — only possible for first-time tasks with no prior slot. |
| Multiple idle slots for same project | Fix 0 handles this: the slot with matching `task_id` wins regardless of insertion order. |
| `prepareForTask` re-clone fallback | Step 7 (`rmSync + ensureSlotClone`) passes `sourceProjectPath` through, so the re-clone also gets the correct symlink target. |
| Pool slot `slot_path` already set with wrong hash in DB | Stale slots will have wrong paths stored. `claimSlot` picks by `project_id` (now correct hash). Old slots with old `project_id` will never be claimed again — naturally orphaned. |

---

## 7. Non-Goals

- **Path prettification**: Changing `~/.steroids/workspaces/<16-char-hash>/` to `~/.steroids/workspaces/<project-name>/` is cosmetic. The fix above does not change the path scheme — it just ensures the correct hash is used. Path prettification is a separate follow-up.
- **Commit recovery for already-lost commits**: The commit `41964a0b` stranded in pool `2df84f038e271516/pool-0` is not recovered by this fix. Manual cherry-pick is the only option for already-lost work.
- **Removal of legacy workstream push code**: The `pushToRemote` call in `loop-phases-coder-decision.ts` still runs for non-pool parallel mode (legacy workstream flow; `hasPoolSlot = false`). Removing it entirely is a future simplification after pool mode is the only supported parallel path.
- **Storing `source_project_path` in DB**: An alternative to parameter threading is adding a `source_project_path` column to `workspace_pool_slots`. This is cleaner long-term but requires a schema migration. Deferred — the parameter threading approach is sufficient and reversible.

---

## 8. Tests

Tests are **mandatory** (not optional) before shipping. This is a data-integrity fix; untested changes in this area have caused production commit loss.

| Test | Description | File |
|------|-------------|------|
| Slot affinity — same task reclaims its slot | `partialReleaseSlot` then `claimSlot(projectId, runnerId2, taskId)` returns the same slot | `tests/workspace-pool-slot-affinity.test.ts` |
| Slot affinity — different task gets different slot | When two tasks each have their own idle slot, each task reclaims its own | same file |
| Slot affinity — retry path | UNIQUE constraint path in `claimSlot` also uses task-id affinity | same file |
| Pool identity (Fix 1) | `getProjectHash(sourceProjectPath)` ≠ `getProjectHash(workstreamPath)` for the bug scenario | `tests/workspace-pool-identity.test.ts` |
| `.steroids` symlink target (Fix 2) | After `ensureSlotClone(slot, remoteUrl, cloneSource, sourceProjectPath)`, the symlink resolves to `sourceProjectPath/.steroids`, not `cloneSource/.steroids` | `tests/workspace-pool-symlink.test.ts` |
| Push guard skipped in pool mode (Fix 3) | `executeCoderDecision` with `hasPoolSlot: true` does NOT call `pushToRemote`; with `hasPoolSlot: false` it does call `pushToRemote` (mocked) | `tests/loop-phases-coder-decision.test.ts` |

---

## 9. Cross-Provider Review

### Round 1 — Codex findings and assessments

| Finding | Codex Claim | Assessment | Decision |
|---------|-------------|------------|----------|
| Logic gap: reviewer claims wrong slot | `claimSlot` LIMIT 1 with no task affinity — commit loss still possible after all 3 fixes | **VALID AND CRITICAL** | ADOPT — Fix 0 added: task-id affinity SQL in `claimSlot` |
| Architectural regression: namespace collapse without sticky claiming | Sharing one pool namespace without ownership makes reviewer claim wrong slot | **VALID** (same as above) | Fixed by Fix 0 |
| Logic gap: `prepareForTask` not called in reviewer | Design incorrectly claimed `prepareForTask` handles wrong-slot case | **VALID** — confirmed in `loop-phases-reviewer.ts:132` | Design corrected; reviewer phase note added |
| Missing pieces: three push guards not one | Lines 213, 264, 336 all need guarding | **VALID** | ADOPT — Fix 3 now explicitly covers all three |
| Type safety: `sourceProjectPath` optional allows silent regressions | Optional param means callers can silently omit it | **VALID** | ADOPT — made required with default for non-parallel callers |
| AGENTS compliance: deferring slot affinity while claiming structural safety | Violates Root-Cause First and Determinism First | **VALID** | ADOPT — Fix 0 added; removed false "structurally impossible" claim |

### Round 1 — Claude findings and assessments

| Finding | Claude Claim | Assessment | Decision |
|---------|-------------|------------|----------|
| Reviewer phase missing `sourceProjectPath` | `runReviewerPhase` also needs the param | **PARTIALLY VALID** — reviewer doesn't call `prepareForTask` or `ensureSlotClone` (confirmed `loop-phases-reviewer.ts:132`). Symlink persists across partial release. | REJECT — reviewer phase does not need the param |
| `hasPoolSlot` context field unspecified | Design calls for it but doesn't show CoderExecutionContext update | **VALID** | ADOPT — Fix 3 now shows full interface definition |
| Slot selection nondeterministic | LIMIT 1 with no ORDER BY | **VALID** | ADOPT — Fix 0 adds task-id affinity + FIFO fallback |
| Parameter threading increases complexity (DB column alternative) | Store `source_project_path` in slot record instead of threading | **INTERESTING** — valid long-term design | DEFER — noted in Non-Goals; threading is sufficient now |
| Fix 1 alone insufficient | Commit still lost if reviewer claims wrong slot | **VALID** | ADOPT — Fix 0 (slot affinity) is now prerequisite for Fix 1 |
| Re-clone call site not covered | git-lifecycle.ts:162 second `ensureSlotClone` call | **VALID** | ADOPT — covered in Fix 2 since `sourceProjectPath` is in scope within `prepareForTask` |

### Round 2 — Codex findings and assessments

| Finding | Codex Claim | Assessment | Decision |
|---------|-------------|------------|----------|
| Fix 0: retry path missing task affinity | Race-condition retry SELECT at `pool.ts:122` also has bare `LIMIT 1`, same issue as primary SELECT | **VALID AND CRITICAL** | ADOPT — Fix 0 spec updated: both SELECTs (line 69 and 122) must use ORDER BY CASE + `.get(projectId, taskId)` |
| Fix 0: `partialReleaseSlot` implicit behavior | SQL preserves `task_id` silently; no comment explaining why, making it a maintenance trap | **VALID** | ADOPT — Fix 0 spec now includes explicit JSDoc comment requirement |
| "Structurally impossible" overclaim | If crash or reconciliation clears `task_id`, Fix 0 affinity fails → FIFO fallback (no regression, but claim was too strong) | **VALID** | ADOPT — Desired Behavior section qualified |
| Pool guard may disable pool for parallel runners | `resolveRemoteUrl(projectPath)` where `projectPath` is workstream clone returns null → pool disabled | **ALREADY FIXED BY FIX 1** — Fix 1 changes the call to `resolveRemoteUrl(sourceProjectPath)`. The workstream clone's remote URL is irrelevant. | REJECT — Fix 1 addresses this correctly |
| `autoMergeOnCompletion` marks completed before merge | In `daemon.ts:315`, workstream is marked `completed` before `runParallelMerge` succeeds | **VALID but OUT OF SCOPE** — this is the parallel-session merge path, not the pool-mode path. Separate bug, separate fix. | DEFER — separate follow-up task |
| One-hop chain still not fixed in `clone.ts` | Multiple origin-poisoning paths exist in non-pool clone paths | **OUT OF SCOPE** — this design only fixes the pool workspace path. `clone.ts` workstream clones are pre-existing behavior with a separate fix if needed. | REJECT — out of scope |

### Round 2 — Claude findings and assessments

| Finding | Claude Claim | Assessment | Decision |
|---------|-------------|------------|----------|
| Fix 0 SQL binding: `.get(projectId)` misses second `?` | `ORDER BY CASE WHEN task_id = ?` adds a second binding, but `.get(projectId)` only passes one | **VALID AND CRITICAL** — SQLite silently treats unbound `?` as NULL, so `task_id = NULL` never matches. The ORDER BY is silently broken without this fix. | ADOPT — Fix 0 spec updated to show `.get(projectId, taskId)` for both queries |
| Fix 2: re-clone fallback at `git-lifecycle.ts:162` | Second call to `ensureSlotClone` in re-clone fallback path must also pass `sourceProjectPath` | **VALID** | ADOPT — Fix 2 spec now explicitly calls out the re-clone fallback path |
| Fix 3: `hasPoolSlot` constructor not shown | Design specifies the interface field but doesn't show the context object population | **VALID** | ADOPT — Fix 3 spec now shows explicit `hasPoolSlot: poolSlotContext !== undefined` assignment |
| Tests are mandatory, not optional | Data-integrity fixes without tests risk silent regression | **VALID** | ADOPT — Tests section added (Section 8) |
| `partialReleaseSlot` comment | Same as Codex finding | **VALID** | ADOPT — see Codex row above |
| DB column alternative (simplification) | Store `source_project_path` in `workspace_pool_slots` instead of parameter threading | **INTERESTING — deferred** | DEFER — already in Non-Goals; threading is sufficient and reversible |

---

## Appendix — Confirmed Bug Evidence

**Session**: `c1131d72` (docgen, 2026-02-27)
**Runner log**: `~/.steroids/runners/logs/daemon-23506.log`

Timeline:
1. Runner claims pool slot 35 → `project_id = 2df84f038e271516` (SHA1 of workstream path, not project)
2. Coder runs in `pool-0`, commits `41964a0b` to `steroids/task-db888493-...`
3. "Steroids not initialized" — pool symlink is a two-hop chain or missing
4. Push executes: `pushToRemote(ws-c1131d72-1, origin, steroids/ws-c1131d72-1)` — sends nothing useful
5. Reviewer crashes on "Steroids not initialized" — runner dies
6. Recovery session `247c78a8` creates new pool `f7f7b163288b88bb/pool-0` — different slot, commit `41964a0b` not present
7. `resolveSubmissionCommitWithRecovery` checks local + `git fetch origin` + workstream clone paths — none have the commit
8. Commit permanently lost
