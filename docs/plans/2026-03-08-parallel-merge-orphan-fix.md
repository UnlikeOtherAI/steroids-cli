# Parallel Merge Orphan Fix

## Problem Statement

Two completed workstreams in the Technician project had their commits silently dropped during auto-merge. The work was done, committed, and the sessions marked "completed" — but zero commits reached main. This is a data-loss class bug: the system reports success while discarding work.

**Affected workstreams:**
- `ws-0498dd8c-1` — `ec23b4a` "Implement Prisma schema, migration, seed, and verification" (6 files, 1,032 lines)
- `ws-9f24553d-2` — `c628bbb` "Add knowledge_sections table, seeder, migration, and unit tests" (14 files, 647 lines)

## Current Behavior

### Bug 1: Integration workspace cannot reach workstream branches pushed to canonical remote

**Affected:** `ws-9f24553d-2` (and `ws-9f24553d-1`)

**Git topology context — three separate repositories are involved:**

1. **Main project directory** (`/Technician`) — `origin` = GitHub
2. **Workspace clone** (`~/.steroids/workspaces/<hash>/ws-9f24553d-2/`) — `origin` = main project directory (local path). Created by `createWorkspaceClone()` with `--depth 1 --single-branch`.
3. **Pool slot** (`~/.steroids/workspaces/<hash>/pool-<N>/`) — `origin` = GitHub URL (set by `ensureSlotClone()` at `pool.ts:308`). Cloned from workspace clone, then origin re-pointed to GitHub.

**Code path:**
1. Pool slot is configured with `origin` = GitHub URL (`ensureSlotClone`, `pool.ts:308`). The `prepareForTask()` self-heal (`git-lifecycle.ts:101-129`) further ensures this by chaining through local intermediaries to find the real remote.
2. When a task is approved, `mergeToBase()` (`git-lifecycle.ts:318`) merges the task branch into the workstream base branch. Since `remote_url` is the GitHub URL (not null), `localOnly = false` and the pool slot pushes the workstream branch to GitHub (Steps 6 and 8, lines 395-448).
3. When `autoMergeOnCompletion()` (`daemon.ts:298`) runs, it calls `runParallelMerge()` which creates an integration workspace via `createIntegrationWorkspace()` (`clone.ts:447`). This clones from the **main project directory** (a local filesystem path).
4. The integration workspace's `origin` remote = main project directory (NOT GitHub). This is set implicitly by `git clone /path/to/Technician`.
5. `safeRunMergeCommand()` (`merge-git.ts:154`) does `git fetch --prune origin steroids/ws-9f24553d-2` — fetching from the main project directory's refs.
6. The workstream branch exists on **GitHub** (pushed by the pool slot) but NOT in the main project directory's local refs. The main project directory never fetched it from GitHub.
7. `isMissingRemoteBranchFailure()` returns true, `REMOTE_BRANCH_MISSING` is thrown.
8. `merge.ts:157-161` catches it, increments `summary.skipped`, and the workstream is excluded from `availableWorkstreams`.
9. `sealWorkstreamsForMerge()` is never called (sealed SHAs remain NULL).
10. Auto-merge reports "Success: 0 commits applied, 0 conflicts, 1 skipped" and marks the session completed.

**Root cause:** The integration workspace's `origin` points to the local project directory, but the workstream branch was pushed to GitHub (the project's canonical remote). The integration workspace cannot reach the branch because it fetches from the wrong location.

**Evidence:**
- `daemon-1772793327019.log:28`: `[AUTO-MERGE] Success: 0 commits applied, 0 conflicts, 1 skipped` (ws-9f24553d-1)
- `daemon-18445.log:5428`: `[AUTO-MERGE] Success: 0 commits applied, 0 conflicts, 1 skipped` (ws-9f24553d-2)
- DB: Both workstreams have `sealed_base_sha = NULL`, `sealed_head_sha = NULL`, `sealed_commit_shas = NULL`

**Why pool slots get the GitHub URL but integration workspaces don't:**
- Pool slots: `resolveRemoteUrl(sourceProjectPath)` is called on the main project path (`orchestrator-loop.ts:442`). The main project's `origin` = GitHub URL. `ensureSlotClone()` (`pool.ts:308`) sets `origin` to this URL. Additionally, `prepareForTask()` (`git-lifecycle.ts:101-129`) has a self-heal that chains through local remotes to find the real upstream.
- Integration workspaces: `createIntegrationWorkspace()` (`clone.ts:447`) clones from `projectPath` (the main project directory). No remote URL resolution or origin rewriting occurs. The clone's `origin` inherits the local filesystem path.

### Bug 2: Session prematurely completed due to spawn race condition

**Affected:** `ws-0498dd8c-1`

**Note:** This bug is independent of Bug 1. Even if Bug 1 is fixed, Bug 2 can still orphan workstreams.

**Code path:**
1. `launchParallelSession()` (`src/commands/runners-parallel.ts:175`) creates session `0498dd8c` at `01:43:03`, inserts workstream, spawns a detached runner. The launcher calls `claimWorkstreamLease()` (`runners-parallel.ts:258`) setting `lease_expires_at` to 120 seconds in the future.
2. Within the same second, a second launch attempt runs (session `878ed7f0` for the same project).
3. The second attempt calls `closeStaleParallelSessions()` (`src/runners/parallel-session-state.ts:11`) with `projectRepoId` filter.
4. Step 1 checks for alive runners via: `NOT EXISTS (SELECT 1 FROM runners r WHERE ... AND r.heartbeat_at > datetime('now', '-5 minutes'))`. This check ignores the workstream's `lease_expires_at` entirely.
5. The runner for `0498dd8c` was just spawned — it hasn't registered in the `runners` table or heartbeated yet. The query finds no alive runners.
6. Step 1 marks `ws-0498dd8c-1` as `failed`. Step 2 marks session `0498dd8c` as `completed`.
7. The `trg_parallel_sessions_active_insert` trigger is now satisfied. Session `878ed7f0` is inserted.
8. Meanwhile, the runner for `0498dd8c` starts up, begins processing tasks (activity log shows work at `02:31:28` and `02:50:49`).
9. Tasks fail/get disputed. The runner loop exits abnormally — `loopCompletedNormally = false`.
10. `autoMergeOnCompletion()` is only called when `loopCompletedNormally && options.parallelSessionId` (`daemon.ts:277`). Since the loop didn't complete normally, auto-merge is never invoked.
11. The workstream remains orphaned. Commits on the branch are unreachable from main.

**Evidence:**
- DB: Session `0498dd8c` has `created_at = completed_at = '2026-03-06 01:43:03'`
- DB: Session `878ed7f0` also has `created_at = '2026-03-06 01:43:03'` (same second, same project)
- DB: `ws-0498dd8c-1` has `status = 'running'` (never transitioned)
- Activity log: Tasks `4eab4e13` (failed at 02:31) and `7157b9c3` (disputed at 02:50) were processed AFTER the session was completed

## Desired Behavior

1. When a parallel runner finishes and calls `autoMergeOnCompletion()`, the workstream branch MUST be available for the integration workspace to fetch. All commits on the branch must be cherry-picked to main (or explicitly conflict-resolved).
2. A freshly-spawned session must not be closed by `closeStaleParallelSessions()` before its runners have time to register and heartbeat.
3. If auto-merge reports "0 commits applied, N skipped" with no conflicts, this should be treated as an anomaly requiring investigation — not silently reported as success.

## Design

### Fix 1: Resolve canonical remote URL for integration workspace

**Files:** `src/parallel/merge.ts` — `runParallelMerge()`, `src/parallel/clone.ts` — `createIntegrationWorkspace()`

Pass the canonical remote URL into `createIntegrationWorkspace()` so that origin is rewritten BEFORE the base branch fetch. This ensures both the base branch fetch (`git fetch origin main`) and subsequent workstream branch fetches (`safeRunMergeCommand`) use the canonical remote (GitHub), not the local project directory.

**In `merge.ts` — resolve the URL and pass it through:**

```typescript
// In runParallelMerge(), before createIntegrationWorkspace():
const canonicalRemoteUrl = resolveRemoteUrl(projectPath);

const integrationWorkspace = createIntegrationWorkspace({
  projectPath,
  sessionId,
  baseBranch: mainBranch,
  remote,
  workspaceRoot,
  integrationBranchName,
  canonicalRemoteUrl,  // NEW
});
```

Import `resolveRemoteUrl` from `../workspace/pool.js`.

**In `clone.ts` — add parameter and rewrite origin before fetch:**

```typescript
export interface IntegrationWorkspaceOptions {
  // ... existing fields ...
  /** Canonical remote URL (e.g. GitHub). When set, origin is re-pointed before any fetch. */
  canonicalRemoteUrl?: string;
}

export function createIntegrationWorkspace(options: IntegrationWorkspaceOptions): IntegrationWorkspaceResult {
  const remote = options.remote ?? 'origin';
  // ... createWorkspaceClone() call ...

  try {
    // Re-point origin to the canonical remote before fetching.
    // The clone inherited origin = local project directory, but pool slots push
    // workstream branches to the canonical remote (e.g. GitHub). Without this,
    // the base branch fetch and subsequent workstream fetches would target the
    // local directory, which may lack the workstream branches entirely.
    if (options.canonicalRemoteUrl) {
      execFileSync('git', ['-C', clone.workspacePath, 'remote', 'set-url', remote, options.canonicalRemoteUrl],
        { stdio: 'inherit' });
    }

    // Existing fetch/checkout (now targets canonical remote if URL was set):
    execFileSync('git', ['-C', clone.workspacePath, 'fetch', remote, options.baseBranch], ...);

    // Sync local base branch to match the (possibly rewritten) remote.
    // createWorkspaceClone's ensureMainOrMasterBranches() set local main from
    // the pre-rewrite origin (local project dir). After rewriting to GitHub,
    // origin/main may be ahead. getWorkstreamCommitList() uses the local main
    // branch (not origin/main) as the baseline for commit selection — a stale
    // local main produces a wider-than-necessary commit range. Force-update it.
    execFileSync('git', ['-C', clone.workspacePath, 'branch', '--force', options.baseBranch, `${remote}/${options.baseBranch}`], ...);

    execFileSync('git', ['-C', clone.workspacePath, 'checkout', '-B', integrationBranchName, `${remote}/${options.baseBranch}`], ...);
  } catch (error) {
    rmSync(clone.workspacePath, { recursive: true, force: true });
    throw new WorkspaceCloneError('Failed to bootstrap integration workspace branch', error);
  }
  // ...
}
```

**Why this location:**
- **Not in `autoMergeOnCompletion`**: The push-from-workspace-clone approach fails because in pool mode, the workspace clone does NOT have the latest commits — they live in the pool slot, which pushes to GitHub.
- **Not in `resolveRemoteUrl`**: That function's distinction between local and non-local paths is correct for pool slot semantics (determining whether `mergeToBase` should push). The integration workspace is a different consumer with different needs.
- **Inside `createIntegrationWorkspace` (revised from R1)**: R2 review identified that placing `set-url` after `createIntegrationWorkspace()` returns is too late for the base branch fetch inside that function. Passing the URL as a parameter keeps `clone.ts` decoupled from `pool.ts` — it accepts an optional string, with no import dependency. The caller (`merge.ts`) is responsible for resolution.
- **Resolution in `runParallelMerge`**: This is where pool-mode awareness belongs. The URL is resolved once and passed down.

**Behavior by mode:**
- **Pool mode (real remote exists):** Pool slot pushes branches to GitHub → `canonicalRemoteUrl` = GitHub URL → integration workspace origin re-pointed to GitHub before any fetch → base branch and workstream branch fetches from GitHub → local `main` force-updated to `origin/main` (so `getWorkstreamCommitList` uses the correct baseline) → cherry-pick succeeds → **push at `merge.ts:220` sends merged result to GitHub's `main`** (not the local project directory). The local project directory's `main` branch is not updated — it falls behind GitHub. The next integration workspace clones from local (for object transfer speed), rewrites origin, fetches `main` from GitHub, and force-updates the local `main` branch, so a stale local project `main` doesn't affect merge correctness.
- **Non-pool mode / no remote:** `resolveRemoteUrl` returns null → `canonicalRemoteUrl` not set → origin stays as local project directory → branches were pushed to local directory by reviewer phase's `pushToRemote` → cherry-pick succeeds → **push sends merged result to local project directory's `main`**. No behavioral change from current code.
- **Non-pool mode, push failure:** The reviewer phase's `pushToRemote` failed (soft warning) → branch not on local directory → `safeRunMergeCommand` fails → Fix 3 detects the anomaly.

**`--single-branch` interaction:** `createWorkspaceClone` uses `--single-branch` for the initial clone, which only fetches the default branch's tracking ref. However, `--single-branch` only restricts the initial `git clone` fetch — it does not prevent subsequent explicit `git fetch origin <branchname>` commands from retrieving other branches. The explicit fetches in `createIntegrationWorkspace` (base branch) and `safeRunMergeCommand` (workstream branches) work regardless of `--single-branch`.

### Fix 2: Respect workstream leases in stale session cleanup

**File:** `src/runners/parallel-session-state.ts` — `closeStaleParallelSessions()`

The launcher sets `lease_expires_at` on workstreams before spawning runners (`runners-parallel.ts:258`). But `closeStaleParallelSessions()` ignores this signal — it only checks the `runners` table for heartbeats. This creates a window where a freshly-spawned runner's workstream can be marked failed before the runner registers.

Add a lease-aware guard to Step 1 (orphaned workstream detection). A workstream with an unexpired lease is not orphaned:

```sql
-- Add to Step 1 WHERE clause (workstream update):
AND (workstreams.lease_expires_at IS NULL OR workstreams.lease_expires_at <= datetime('now'))
```

This references the target table column directly rather than using a self-join. The existing query already references `workstreams.session_id` directly, so this follows the established pattern.

Step 2 (session completion) does not need a separate guard because it already checks `AND NOT EXISTS (... workstreams ... status NOT IN terminal ...)`. If Step 1 correctly avoids marking leased workstreams as failed, Step 2 won't close the session.

**Why leases and not a `created_at` grace period:** The system already has an explicit per-workstream lease mechanism. Using it is more targeted than a blanket time-based filter on the session's creation time. It only protects workstreams that have an active lease (i.e., were recently launched or recently had their lease refreshed), rather than protecting ALL sessions created within the last N seconds including genuinely dead ones.

### Fix 3: Warn on zero-commit auto-merge "success"

**File:** `src/runners/daemon.ts` — `autoMergeOnCompletion()`

After `runParallelMerge()` returns successfully, check for the pathological case where ALL workstreams were skipped and zero commits were applied:

```typescript
if (result.success) {
  if (result.completedCommits === 0 && result.skipped > 0 && result.conflicts === 0) {
    console.warn(
      `[AUTO-MERGE] WARNING: All workstreams skipped, 0 commits applied ` +
      `(${result.skipped} skipped). Workstream branches may be unreachable ` +
      `from the integration workspace. Check remote URL configuration.`
    );
  }
  console.log(`[AUTO-MERGE] Success: ${result.completedCommits} commits applied, ${result.conflicts} conflicts, ${result.skipped} skipped`);
```

The `conflicts === 0` guard prevents false positives on conflict-resolution paths. `processWorkstream()` at `merge-process.ts:87,135` increments both `skipped` and `conflicts` during resolved conflict cycles — a success with `skipped > 0` and `conflicts > 0` is a valid conflict-resolution outcome, not the pathological "branches unreachable" case.

This is a detection-only measure. Fix 1 prevents the root cause; this log line alerts if it somehow recurs.

**Why warning and not `failed` status:** R2 review considered promoting this to `failed`. Rejected because: (a) Fix 1 eliminates the root cause — this is defense-in-depth only; (b) if some workstreams were successfully merged and this fires for a subset, failing the session would discard the successfully pushed commits; (c) in recovery scenarios (re-running merge after a prior partial success), previously-merged branches may be deleted from the remote, causing expected skips that would false-positive a `failed` status.

**Recovery scenario distinction:** The `REMOTE_BRANCH_MISSING` skip at `merge.ts:157-161` fires for both "branch was never reachable" (Bug 1) and "branch was already merged and deleted" (prior successful merge). Fix 1 eliminates the former. The latter is benign and expected during recovery — the warning helps operators distinguish between the two by checking sealed SHAs (NULL = never sealed = Bug 1; non-NULL = previously processed).

## Implementation Order

1. **Fix 1** (resolve remote URL for integration workspace) — eliminates the primary data-loss path
2. **Fix 3** (warning log) — immediate detection value, trivial change
3. **Fix 2** (lease-aware stale cleanup) — prevents the race condition that orphans sessions

Fix 1 and Fix 2 address independent bugs and can be implemented in parallel.

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Project has no remote URL (`resolveRemoteUrl` returns null) | Origin stays as local project directory — non-pool mode works as before |
| Pool slot push to GitHub failed | `mergeToBase` returns failure, task is not approved. Commits never reach any remote. No silent data loss — failure is explicit. |
| Integration workspace push to GitHub fails | `runParallelMerge` catches the push error (`merge.ts:220-224`), marks session `failed` |
| Workstream lease expires before runner registers | 120-second default lease covers spawn + registration. If exhausted on severely loaded systems, workstream is correctly treated as orphaned. |
| Lease and runner heartbeat both present | No conflict — Step 1's two NOT EXISTS clauses (runner alive OR lease unexpired) are additive |
| `resolveRemoteUrl` returns a stale/wrong URL | Same risk as existing pool slot setup. The `prepareForTask` self-heal handles stale URLs for pool slots; a similar regression in the integration workspace would manifest as a fetch failure (not silent data loss). |
| Clone cleanup runs before auto-merge (clone deleted) | `autoMergeOnCompletion` can't find its workstream clone → skips merge. Commits unrecoverable if only on the clone. **Mitigation:** Clone cleanup only runs after merge succeeds (`merge.ts:238-246`). |
| `--single-branch` clone prevents workstream fetch | `--single-branch` only restricts the initial `git clone` fetch. Explicit `git fetch origin <branch>` calls in `createIntegrationWorkspace` and `safeRunMergeCommand` are unaffected. |
| `pull --ff-only` after origin rewrite to canonical remote | With Fix 1, `pull --ff-only` now fetches main from the canonical remote (GitHub) instead of the local project directory. This is correct — it ensures the integration branch starts from the most up-to-date main. If local main was behind GitHub, this was previously a silent divergence; now it's resolved. |
| `config.git.remote` set to non-`origin` value (e.g., `upstream`) | **Pre-existing bug, not introduced by Fix 1.** Fresh integration workspace clones only have `origin` as a configured remote. If `config.git.remote` is `upstream`, all operations in `runParallelMerge` (`fetch`, `pull`, `push`, branch deletion) would fail because `upstream` doesn't exist in the clone. Fix 1's `set-url` targets the `remote` variable, which would also fail (`git remote set-url upstream <url>` — no such remote). This failure is explicit (exception), not silent data loss. The same issue affects pool slots — `ensureSlotClone` sets the `origin` remote, while `config.git.remote` controls the remote name for operations. **Known limitation** — follow-up to either force `origin` for integration workspaces or create the configured remote name. |
| Local project dir's `main` falls behind in pool mode | After Fix 1, `git push origin main` at `merge.ts:220` pushes to GitHub, not the local project dir. The local `main` is never updated by the merge pipeline. This is correct: (1) next integration workspace clones from local for speed but fetches `main` from GitHub; (2) pool slots already use GitHub as origin; (3) workstream clones don't depend on local `main`. The local dir is an object cache, not the source of truth. |
| Branch cleanup pushes (`merge.ts:228-235`) target canonical remote | The `git push origin --delete <workstream-branch>` calls at `merge.ts:231` also target the rewritten origin (GitHub in pool mode). This is correct — the workstream branches were pushed to GitHub by pool slots, so deletion should target GitHub too. |

## Non-Goals

- Making `mergeToBase()` always push regardless of `localOnly` — the pool slot's local-only behavior is not the root cause; the issue is the integration workspace's missing remote URL resolution
- Adding a wakeup reconciler defense-in-depth for completed sessions — this was considered but rejected as under-specified and unnecessary if Fix 1 is correct. The reconciler would need to: detect unmerged commits deterministically, avoid re-merging already-merged branches, handle existing sessions for the same repo, and decide whether to resurrect completed sessions (conflicting with the active-session trigger). These open questions introduce more risk than they mitigate.
- Retroactively recovering the orphaned commits from `ws-0498dd8c-1` and `ws-9f24553d-2` — the user confirmed these were superseded by later work

## Cross-Provider Review — Round 1

**Reviewers:** Claude (`superpowers:code-reviewer`), Codex (`codex exec`), Gemini

### Findings and Decisions

| # | Source | Finding | Decision |
|---|--------|---------|----------|
| 1 | All three | Original Fix 1 (push from workspace clone) pushes from the wrong repository — in pool mode, commits live in the pool slot, not the workspace clone | **Adopt.** Rewrote Fix 1 to resolve the canonical remote URL for the integration workspace instead. |
| 2 | Codex | `autoMergeOnCompletion` marks workstream `completed` before push/merge — if push fails, reconciler can't recover | **Adopt.** The revised Fix 1 doesn't push from `autoMergeOnCompletion` at all. The remote URL resolution in `runParallelMerge` occurs after the workstream is already marked completed, but a merge failure will mark the session `failed` (not silently lost). |
| 3 | Codex | Root cause analysis not tight enough — missing branch could come from ignored push failures in non-pool legacy path | **Adopt.** Expanded the root cause analysis to trace the full three-repo git topology and explain why pool slots get the GitHub URL but integration workspaces don't. |
| 4 | Codex | Fix 2 should use existing `lease_expires_at` instead of `created_at` grace period | **Adopt.** Rewrote Fix 2 to check `lease_expires_at > datetime('now')` instead of a blanket `created_at` filter. |
| 5 | All three | Fix 4 (wakeup reconciler) is under-specified and over-engineered | **Adopt.** Removed Fix 4 entirely. Moved to Non-Goals with justification. |
| 6 | Codex | Fix 1 hardcodes `'origin'` but `autoMergeOnCompletion` uses `config.git.remote` | **Adopt.** The revised Fix 1 uses the `remote` variable already scoped in `runParallelMerge` (defaults to `config.git.remote ?? 'origin'`). |
| 7 | Claude | Fix 1 and Fix 2 are independent fixes for independent bugs — should be stated explicitly | **Adopt.** Added explicit statement in Implementation Order. |
| 8 | Claude | Consider fixing root cause in `mergeToBase` for parallel runners | **Defer.** The root cause is not `mergeToBase`'s push behavior — it's the integration workspace's origin configuration. Pool slot pushes to GitHub work correctly. |
| 9 | Claude | Reference the `prepareForTask` self-heal logic and explain why it doesn't cover this scenario | **Adopt.** Added to the "Why pool slots get the GitHub URL but integration workspaces don't" section. |
| 10 | Gemini | Fix `resolveRemoteUrl` to not return null for local paths | **Reject.** The local-path null return is correct for pool slot semantics: it determines whether `mergeToBase` should push. The issue is that integration workspaces don't call `resolveRemoteUrl` at all. Changing `resolveRemoteUrl` would be a broader change with unclear side effects on pool slot isolation. |
| 11 | Gemini | Add `initializing` session status | **Defer.** The lease-based fix (Codex's recommendation) is simpler and uses existing infrastructure. An `initializing` status would require schema migration, trigger updates, and changes to all status-checking queries. |
| 12 | Claude | Clone cleanup before auto-merge is a data-loss path | **Adopt.** Added to edge case table with note that cleanup only runs after merge succeeds. |

## Cross-Provider Review — Round 2

**Reviewers:** Claude (`superpowers:code-reviewer`), Codex (`codex exec`)

### Findings and Decisions

| # | Source | Finding | Decision |
|---|--------|---------|----------|
| 1 | Codex | Fix 1 `set-url` runs too late — `createIntegrationWorkspace()` does `git fetch origin main` before `runParallelMerge()` regains control to rewrite the URL. Recommends passing canonical URL into `createIntegrationWorkspace()`. | **Adopt.** Revised Fix 1 to pass `canonicalRemoteUrl` as an optional parameter to `createIntegrationWorkspace()`. The remote is rewritten before the base branch fetch. Note: Claude R2 correctly identified that the original placement WAS sufficient for Bug 1 (the base branch fetch targets `main`, which exists locally; workstream fetches happen after the rewrite). Adopting Codex's approach anyway because it's more robust — it also ensures the base branch comes from the canonical remote, protecting against local main being stale relative to GitHub. |
| 2 | Codex | Fix 3 should promote 0-commit success to `failed` state, not just warn | **Reject.** Fix 1 eliminates the root cause. Promoting to `failed` would (a) discard successfully pushed commits if only some workstreams were skipped, (b) false-positive on recovery scenarios where previously-merged branches were already deleted. Warning is appropriate for defense-in-depth. |
| 3 | Codex | Three-repo topology slightly overgeneralized — seeded clones may have different origin resolution | **Adopt.** Added note on seeded clone path. Seeded clones (`fromPath` in `createWorkspaceClone`) resolve origin via a different mechanism (lines 349-370 of `clone.ts`) but this does not affect integration workspaces, which are never seeded. |
| 4 | Codex | Fix 2 is robust for the spawn race | **Confirmed.** No changes needed. |
| 5 | Claude | Fix 1 placement is correct for the actual failure path — workstream branch fetch at `merge.ts:154` happens after remote rewrite | **Confirmed.** See finding #1 — adopted Codex's approach for additional robustness despite Claude's correct observation that the original placement handled Bug 1. |
| 6 | Claude | `pull --ff-only` behavioral change with canonical remote should be documented | **Adopt.** Added to edge case table. With the canonical remote URL, `pull --ff-only` now fetches main from GitHub rather than local — this is correct behavior. |
| 7 | Claude | `--single-branch` clone interaction should be verified | **Adopt.** Added to edge case table and Fix 1 section. `--single-branch` only restricts `git clone`'s initial fetch; explicit `git fetch origin <branch>` is unaffected. |
| 8 | Claude | `resolveRemoteUrl` hardcodes `'origin'` while caller may use different remote name | **Defer (follow-up).** For both pool slots and integration workspaces, the remote is always `origin` in the clone. The `config.git.remote` option names the remote for operations, and in fresh clones this is always `origin`. Added to edge case table as known limitation with follow-up scope. |
| 9 | Claude | Fix 3 warning fires on recovery scenarios — need to distinguish "never-sealed" (sealed SHAs = NULL) vs "already-merged" | **Adopt.** Added distinction to Fix 3: operators can check sealed SHAs to differentiate Bug 1 (NULL = never sealed) from benign recovery skips (non-NULL = previously processed). |
| 10 | Claude | All Round 1 decisions are well-reasoned | **Confirmed.** No changes needed. |

## Cross-Provider Review — Round 3

**Reviewers:** Claude (`superpowers:code-reviewer`), Codex (`codex exec`)

### Findings and Decisions

| # | Source | Finding | Decision |
|---|--------|---------|----------|
| 1 | Claude | Fix 2 SQL uses unnecessary self-join; should use direct column reference `AND (workstreams.lease_expires_at IS NULL OR workstreams.lease_expires_at <= datetime('now'))` instead | **Adopt.** Simplified Fix 2 SQL. The self-join was semantically correct but unnecessarily obscure. The existing query already references `workstreams.session_id` directly, so a direct column reference follows the established pattern. |
| 2 | Claude | Fix 1 placement and timing confirmed correct — `ensureMainOrMasterBranches` fetches main from local dir before rewrite, but the explicit fetch in `createIntegrationWorkspace` supersedes it | **Confirmed.** No changes needed. |
| 3 | Claude | `--depth 1` shallow clone does not cause issues for cherry-pick merge — each commit is individually cherry-picked regardless of shallow boundary | **Confirmed.** No edge case entry needed. |
| 4 | Claude | `aborted` in `TERMINAL_WORKSTREAM_STATUSES` can never occur (CHECK constraint only allows running/completed/failed) — defensive but harmless | **Noted.** Does not affect Fix 2 correctness. |
| 5 | Claude | Authentication propagation works via `process.env` inheritance — same pattern as pool slots | **Confirmed.** No edge case entry needed; failure mode is explicit (exception). |
| 6 | Claude | Code sketches match actual source structure; `resolveRemoteUrl` import path is correct | **Confirmed.** |
| 7 | Claude | All prior round decisions hold up under scrutiny | **Confirmed.** |
| 8 | Claude | No negative interactions between the three fixes | **Confirmed.** |
| 9 | Codex | Fix 1 `set-url` must be inside the try/catch cleanup path — if `set-url` fails outside the try block, the integration workspace is leaked and a raw git error is thrown instead of `WorkspaceCloneError` | **Adopt.** Moved `set-url` inside the existing try/catch block in the code sketch, before the fetch/checkout. Now a `set-url` failure triggers the same `rmSync` + `WorkspaceCloneError` cleanup as a fetch/checkout failure. |
| 10 | Codex | Fix 3 predicate needs `result.conflicts === 0` — `processWorkstream()` at `merge-process.ts:87,135` increments both `skipped` and `conflicts` during conflict resolution; warning without the guard would false-positive on valid conflict-resolution outcomes | **Adopt.** Added `result.conflicts === 0` to the warning condition. The pathological case (Bug 1) has zero conflicts because workstream branches were never fetched. |
| 11 | Codex | Fix 1 timing now correctly addresses R2 issue; Fix 2 is semantically correct; prior decisions are correct; edge case table is complete | **Confirmed.** |

## Cross-Provider Review — Round 4

**Reviewers:** Claude (`superpowers:code-reviewer`), Codex (`codex exec`)

**Scope:** Standard adversarial review of R3 changes + broader stability audit of the merge pipeline.

### Findings and Decisions

| # | Source | Finding | Decision |
|---|--------|---------|----------|
| 1 | Codex | **Critical:** `getWorkstreamCommitList()` at `merge-git.ts:81` uses `main..origin/<workstream>` — the local `main` branch, not `origin/main`. After Fix 1 rewrites origin to GitHub, `origin/main` is up-to-date but local `main` was set by `ensureMainOrMasterBranches` from the pre-rewrite origin (local project dir). If local project dir's `main` is behind GitHub, the commit range is wider than correct and includes commits already on GitHub's `main`. | **Adopt.** Added `git branch --force <baseBranch> origin/<baseBranch>` to the Fix 1 code sketch in `createIntegrationWorkspace`, after the base branch fetch and before the checkout. This syncs local `main` with the (now-GitHub) `origin/main`. Also corrected the "Behavior by mode" text — the previous statement "nothing in pool mode reads `main` from the local project directory" was wrong. |
| 2 | Codex | **High:** `config.git.remote` set to non-`origin` value breaks the entire merge pipeline (pre-existing). Fresh clones only have `origin`. If `config.git.remote` is `upstream`, all fetch/pull/push/delete calls and Fix 1's `set-url` fail because `upstream` doesn't exist. Not just a `resolveRemoteUrl` follow-up — the pipeline itself breaks. | **Adopt (edge case update).** Revised the edge case table entry to clearly describe the full scope of the issue — it affects ALL operations, not just `resolveRemoteUrl`. Noted as a pre-existing bug with explicit failure mode (exception, not data loss). Follow-up scoped. |
| 3 | Codex | **Medium:** `autoMergeOnCompletion` marks workstream `completed` before merge — if merge fails, workstream stays `completed` with null sealed SHAs. | **Defer.** Already addressed in R1 finding #2. This is intentional: the workstream's status reflects task execution completion, not merge outcome. The session status (`failed`) reflects the merge outcome. Changing this would conflate two different concepts. |
| 4 | Claude | All R3 updates (behavior by mode, edge cases, code sketches) verified correct against source | **Confirmed.** |
| 5 | Claude | All git operations using `remote` variable after origin rewrite traced — all correctly targeted | **Confirmed.** |

### Broader Stability Audit (Follow-up Candidates)

Both reviewers audited the broader merge pipeline. These are concrete issues that don't block the three fixes but should be addressed:

| # | Source | Issue | Files | Severity | Suggested Approach |
|---|--------|-------|-------|----------|--------------------|
| F-1 | Claude | `isNoPushError` at `merge-git.ts:176-179` uses broad string matching (`includes('error:')`) on push output. A successful push whose output contains "error:" (e.g., in a commit message or remote hook output) would be misclassified as failure, marking the session `failed` despite commits being pushed. | `merge-git.ts` | High | Return structured `{ exitCode, output }` from `runGitCommand` for the push call, or check exit code instead of string matching. |
| F-2 | Claude | `autoMergeOnCompletion` matches workstreams by `clone_path = workspacePath`. Path normalization differences (symlinks, trailing slashes) could cause silent skip. The log message gives no diagnostic info. | `daemon.ts:305-308` | Medium | Log the actual `workspacePath` being matched so operators can diagnose path mismatches. |
| F-3 | Claude | Duplicated `resolveGitSha` function in `merge-sealing.ts` (private) and `merge-commit-checks.ts` (exported). If either is updated without the other, they diverge silently. | `merge-sealing.ts`, `merge-commit-checks.ts` | Low | Remove private copy, import from `merge-commit-checks.ts`. |
| F-4 | Claude | Heartbeat timer catch block at `merge.ts:138-145` silently swallows all errors. If heartbeat consistently fails, the merge lock expires and another runner could acquire it. No failed-heartbeat counter or abort signal exists. | `merge.ts` | Medium | Add a consecutive-failure counter; after N failures, set an abort flag checked at the next `assertMergeLockEpoch`. |
| F-5 | Claude | `cleanTreeHasConflicts` at `merge-git.ts:53-56` uses `line.includes('U')` which matches filenames containing 'U'. Currently unused function but latent defect. | `merge-git.ts` | Low | Match on the two-character status prefix only: `line.substring(0, 2).includes('U')`. |
| F-6 | Claude | Dead `openGlobalDatabase` imports in `merge-sealing.ts` and `merge-conflict.ts`. | `merge-sealing.ts`, `merge-conflict.ts` | Trivial | Remove unused imports. |

## Cross-Provider Review — Round 5

**Reviewers:** Claude (`superpowers:code-reviewer`), Codex (`codex exec`)

**Scope:** Final adversarial review after R4 changes (local `main` force-update, edge case corrections).

### Findings and Decisions

| # | Source | Finding | Decision |
|---|--------|---------|----------|
| 1 | Claude | Clean bill of health. All R4 changes verified: `git branch --force` placement correct, behavior-by-mode text accurate, edge case table entries match source. All callers of `getWorkstreamCommitList` traced (`merge-sealing.ts:48`, `merge-process.ts:38`) — both use local `main` which is now force-updated. No critical, important, or suggestive findings. **"Ready for implementation."** | **Confirmed.** |
| 2 | Codex | **Theoretical:** Post-`pull --ff-only` drift — after `git pull --ff-only origin main` at `merge.ts:178`, the integration branch advances but local `main` doesn't move. `processWorkstream()` at `merge.ts:200` calls `getWorkstreamCommitList()` using local `main`, which is now behind the integration branch tip. If GitHub's `main` advanced between workspace creation and the pull, the commit range would be wider than expected. | **Reject (pre-existing, non-actionable).** Analysis: (1) The merge lock prevents concurrent merges — the window between `createIntegrationWorkspace` and `processWorkstream` is seconds. (2) `git branch --force` in Fix 1 syncs local `main` to `origin/main` at workspace creation time. The pull at line 178 advances the integration branch but NOT local `main` — this is identical to pre-Fix-1 behavior. (3) A wider commit range means cherry-pick sees more commits, not fewer — extra already-applied commits produce empty cherry-picks that are skipped, not data loss. (4) Sealing at line 166 happens BEFORE the pull; processing at line 200 happens AFTER — but both use the same local `main` as baseline, which hasn't changed between the two calls. (5) This is a pre-existing characteristic of the pipeline, not introduced by Fix 1. Not a data-loss path. |

**Round 5 conclusion:** No actionable findings. The design is ready for implementation.
