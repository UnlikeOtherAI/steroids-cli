# Design: Landing Verification & Merge Integrity

> **Revision 3 (FINAL)** — incorporates Round 1 + Round 2 adversarial reviews from Claude and Codex.

## Problem Statement

Tasks are marked `completed` even though their commits never land on the target branch (`origin/main`). Work appears "lost" — approved in workflow state but not durably landed.

## Root Cause

One bug in one line, amplified by an existing detector:

### The Bug: `clone.ts:349` sets origin to a local filesystem path

`src/parallel/clone.ts:344-354` — when seeding a workspace from a prior workstream, origin is reset to `projectPath`:

```typescript
if (options.fromPath) {
  execFileSync('git', ['-C', workspacePath, 'remote', 'set-url', 'origin', projectPath], ...);
}
```

If `projectPath` is a filesystem path (e.g., `/System/.../flatu`), the clone's origin becomes that local path.

### Second poisoning path: `ensureSlotClone` clones from local path

`src/workspace/pool.ts:295` — when `remoteUrl` is null, the pool clone also gets a local-path origin:

```typescript
const cloneSource = remoteUrl ?? projectPath;
execFileSync('git', ['clone', '--no-tags', cloneSource, slotPath], ...);
```

### The Amplifier: `resolveRemoteUrl()` treats filesystem origins as "no remote"

`src/workspace/pool.ts:25-44` returns `null` for filesystem paths → `localOnly = true` → push/verify skipped in `mergeToBase()` steps 6, 8, 10 → commits exist only in disposable workspace clone.

## Desired Behavior

**Hard invariant:** Pool-mode workspaces must always have their origin set to the real remote URL. The existing push + verify logic in `mergeToBase()` already enforces landing — it was just bypassed by `localOnly = true`.

**Policy change:** Pool mode requires a remote. If a project has no real remote, refuse to create pool slots.

## Design

### Fix 1: Resolve real remote when setting clone origin

**File:** `src/parallel/clone.ts` — lines 344-354

Replace the blind `projectPath` origin with a one-hop resolution:

```typescript
if (options.fromPath) {
  // Resolve the real remote URL from the source project, not the local path.
  // Workspace clone → projectPath → real remote (one hop).
  let originUrl = projectPath;
  try {
    const sourceRemote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectPath,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    if (sourceRemote && !sourceRemote.startsWith('/') && !sourceRemote.startsWith('.') && !sourceRemote.startsWith('~')) {
      originUrl = sourceRemote;
    }
  } catch {
    // Keep projectPath — resolveRemoteUrl will classify it correctly downstream.
  }
  execFileSync('git', ['-C', workspacePath, 'remote', 'set-url', 'origin', originUrl], { stdio: 'inherit' });
}
```

**Why one hop, not five:** The workspace nesting depth is architecturally bounded at 2 (workspace → project → remote). `createWorkspaceClone` is only called from `runners-parallel.ts:222` and `clone.ts:436` (`createIntegrationWorkspace`). Neither produces nesting deeper than 2. One hop covers the actual bug.

### Fix 2: Close second poisoning path in `ensureSlotClone`

**File:** `src/workspace/pool.ts` — `ensureSlotClone()` (lines 278-310)

The clone source must remain the local `projectPath` for performance (hardlinks, no network). But after cloning, set origin to the real remote URL. This is a **correctness fix**, not a performance concern.

```typescript
export function ensureSlotClone(
  slot: PoolSlot,
  remoteUrl: string | null,
  projectPath: string
): void {
  const slotPath = slot.slot_path;

  if (!existsSync(slotPath) || !existsSync(join(slotPath, '.git'))) {
    // Remove any partial directory
    if (existsSync(slotPath)) {
      rmSync(slotPath, { recursive: true, force: true });
    }

    // Create parent directories
    mkdirSync(resolve(slotPath, '..'), { recursive: true });

    // Always clone from local projectPath for speed (hardlinks).
    execFileSync('git', ['clone', '--no-tags', projectPath, slotPath], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 300_000,
    });

    // Then set origin to the real remote so push/verify targets the correct URL.
    if (remoteUrl) {
      execGit(slotPath, ['remote', 'set-url', 'origin', remoteUrl]);
    }
  } else if (remoteUrl) {
    // Existing clone — ensure origin points to the real remote (repair path).
    execGit(slotPath, ['remote', 'set-url', 'origin', remoteUrl], { tolerateFailure: true });
  }

  // If shallow, unshallow it
  if (isShallowRepository(slotPath)) {
    execGit(slotPath, ['fetch', '--unshallow'], { timeoutMs: 300_000 });
  }

  // Ensure .steroids symlink points to the source project
  ensureWorkspaceSteroidsSymlink(slotPath, projectPath);
}
```

Key differences from current code:
- Clone source is ALWAYS `projectPath` (local, fast) — never the remote URL
- After clone, set origin to `remoteUrl` if available
- For existing clones, also repair origin to `remoteUrl` (handles stale slots)
- Shallow check and symlink run for ALL paths (no early return)

### Fix 3: Self-heal poisoned slots in `prepareForTask`

**File:** `src/workspace/git-lifecycle.ts` — in `prepareForTask()`, after `ensureSlotClone()`

Existing slots in production DBs have `remote_url = NULL` from the old code path. The `ensureSlotClone` repair in Fix 2 handles the clone's git origin, but the DB record also needs updating. Add repair logic after `ensureSlotClone`:

```typescript
export function prepareForTask(
  globalDb: Database.Database,
  slot: PoolSlot,
  taskId: string,
  projectPath: string
): PrepareResult {
  const slotPath = slot.slot_path;
  let localOnly = slot.remote_url === null;  // ← CHANGED: const → let
  const remote = 'origin';

  // Ensure the clone exists
  try {
    ensureSlotClone(slot, slot.remote_url, projectPath);
  } catch (error) {
    return { ok: false, reason: `Failed to ensure slot clone: ${...}`, blocked: true };
  }

  // Self-heal: if slot has no remote_url, check if the clone's origin points to
  // a local repo that itself has a real remote. Repair both the clone and the DB.
  if (localOnly) {
    const cloneOrigin = execGit(slotPath, ['remote', 'get-url', 'origin'], { tolerateFailure: true });
    if (cloneOrigin && (cloneOrigin.startsWith('/') || cloneOrigin.startsWith('.') || cloneOrigin.startsWith('~'))) {
      try {
        const upstreamRemote = execFileSync('git', ['remote', 'get-url', 'origin'], {
          cwd: cloneOrigin,
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (upstreamRemote && !upstreamRemote.startsWith('/') && !upstreamRemote.startsWith('.') && !upstreamRemote.startsWith('~')) {
          // Repair: update the clone's origin and the DB record.
          execGit(slotPath, ['remote', 'set-url', 'origin', upstreamRemote]);
          globalDb.prepare('UPDATE workspace_pool_slots SET remote_url = ? WHERE id = ?')
            .run(upstreamRemote, slot.id);
          // Update in-memory slot to prevent re-clone fallback (line 121) from re-poisoning.
          (slot as { remote_url: string | null }).remote_url = upstreamRemote;
          localOnly = false;
        }
      } catch {
        // Can't resolve upstream — leave as localOnly.
      }
    }
  }

  // ... rest of prepareForTask unchanged, using the (possibly repaired) localOnly ...
```

**Implementation notes from Round 2 review:**
- `localOnly` changed from `const` to `let` to allow reassignment after repair
- `slot.remote_url` updated in memory so the re-clone fallback at line 121 passes the correct URL to `ensureSlotClone`
- Repair is a one-hop check (same as Fix 1), not chain-following

### Fix 4: Refuse pool mode without a real remote

**File:** `src/runners/orchestrator-loop.ts` — where `remoteUrl` is resolved (~line 441)

```typescript
const remoteUrl = resolveRemoteUrl(projectPath);
if (!remoteUrl) {
  log(`[pool] Skipping pool mode for ${projectPath}: no remote URL detected. Pool mode requires a pushable remote.`);
  poolSlotCtx = undefined;
  // Falls through to non-pool (legacy) path
}
```

**Note on parallel runners (from Codex R2):** In parallel runners, `projectPath` may be a workspace clone path whose origin is currently a local path (the pre-fix state). After Fix 1 deploys, new workspace clones will have real-remote origins. For existing workspace clones that haven't been repaired yet, this guard will refuse pool mode — which is correct behavior since those clones would produce false completions anyway.

### What we are NOT doing (and why)

| Rejected proposal | Why rejected | Round |
|---|---|---|
| **5-hop `resolveCanonicalRemoteUrl()`** | Over-engineered. Max depth is 2 hops. | R1 both |
| **`verifyLanding()` gate in `loop-phases.ts`** | Creates worse failure mode: 5 network blips → permanently blocked task with already-landed commits. `mergeToBase` step 10 already verifies. | R1 both |
| **Session-level landing guard** | Unimplementable: no `merged_sha` column, no session→task mapping after slot release. | R1 both |
| **Changing `resolveRemoteUrl()` in `pool.ts`** | Not the source of the bug. It correctly detects filesystem paths. Fix the source, not the detector. | R1 Claude |

### Known issues tracked separately (not in scope)

| Issue | Why deferred | Evidence |
|---|---|---|
| **`autoMergeOnCompletion` marks workstream completed before merge** | Different code path (parallel-session, not pool-mode). Does not interact with this fix. Pre-existing. | `daemon.ts:315` |
| **`sealWorkstreamsForMerge` sets completed before push** | Same parallel-session path. | `merge-sealing.ts:75` |
| **Legacy push path false success with local-path origin** | Non-pool path. This design fixes pool-mode only. Legacy push path needs its own fix. | `loop-phases.ts:1601` |
| **TOCTOU: merge lock released before verify in `mergeToBase`** | Pre-existing. Not introduced or worsened by this fix. Can tighten later by moving verify inside lock. | `git-lifecycle.ts:343-347` |
| **`file://` protocol URLs treated as real remotes** | Doesn't cause false-completion. | `pool.ts:36` |
| **Hardcoded `origin` remote** | Pre-existing inconsistency with merge.ts. | `pool.ts:27` |

## Implementation Order

All changes are single-phase — this is a focused 4-fix patch.

1. **`clone.ts` origin fix** — one-hop remote resolution when setting origin
2. **`pool.ts` `ensureSlotClone` fix** — clone local, set origin to remote
3. **`git-lifecycle.ts` self-heal** — repair poisoned slots on `prepareForTask`
4. **`orchestrator-loop.ts` guard** — refuse pool mode without remote
5. **Tests** — unit tests for origin resolution, integration test for merge-to-remote path

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Project has no remote at all | Pool mode refused (Fix 4). Legacy single-runner path still works. |
| Existing slot with `remote_url = NULL` | Self-healed on first `prepareForTask` (Fix 3). Clone origin also repaired by `ensureSlotClone` (Fix 2). |
| Source project directory deleted/moved | `execFileSync` throws ENOENT, caught by `catch`, slot stays `localOnly`. Safe. |
| `cloneOrigin` points to reclaimed workspace | Paths include project hash + UUID. Different project = different hash. Same project reclaimed = ENOENT. Safe. |
| Multiple runners hit repair for same slot | Slots are claimed exclusively via `BEGIN IMMEDIATE`. Only one runner processes a given slot at a time. Safe. |
| Network failure during push/verify in `mergeToBase` | Existing `pushWithRetries` + step-10 verify handles this. Task returned to pending via `handleMergeFailure`. |
| Another workstream races during push | Existing `pushWithRetries` handles. TOCTOU gap pre-existing, tracked separately. |

## Files Changed

| File | Change | ~Lines |
|------|--------|--------|
| `src/parallel/clone.ts` | One-hop remote resolution in origin reset | ~10 |
| `src/workspace/pool.ts` | `ensureSlotClone`: clone local, set origin to remote; repair existing clones | ~15 |
| `src/workspace/git-lifecycle.ts` | Self-heal poisoned slots in `prepareForTask` (`const` → `let`, in-memory slot update) | ~20 |
| `src/runners/orchestrator-loop.ts` | Refuse pool mode without remote | ~5 |
| `tests/landing-verification.test.ts` | Integration tests for origin resolution + merge path | ~80 |

**Total: ~50 lines of production code across 4 files.**

## Cross-Provider Review Trail

### Round 1 Findings & Disposition

| # | Finding | Source | Disposition |
|---|---------|--------|-------------|
| 1 | 5-hop chain is over-engineered; max depth is 2 | Both | **ADOPT** — reduced to 1-hop inline |
| 2 | `verifyLanding` creates worse failure mode | Both | **ADOPT** — removed entirely |
| 3 | Session guard unimplementable | Both | **ADOPT** — removed entirely |
| 4 | `resolve(url)` resolves relative to CWD, not repo | Both | **ADOPT** — moot (no chain-following) |
| 5 | Existing poisoned slots unaddressed | Both | **ADOPT** — self-heal in `prepareForTask` |
| 6 | `ensureSlotClone` with remote URL = network clone | Claude | **ADOPT** — clone local, set origin after |
| 7 | `claimSlot()` doesn't set `remote_url` | Claude | **ADOPT** — design targets `finalizeSlotPath` |
| 8 | Pool mode + local-only should be refused | Codex | **ADOPT** — guard in orchestrator-loop |
| 9 | `tolerateFailure: true` + fail-closed = contradiction | Both | **ADOPT** — no new verification added |
| 10 | `autoMergeOnCompletion` marks completed before merge | Codex | **DEFER** — different code path |
| 11 | `file://` URLs | Claude | **DEFER** — doesn't cause false-completion |
| 12 | Hardcoded `origin` remote | Codex | **DEFER** — pre-existing |
| 13 | `any` types in lock/slot handling | Codex | **DEFER** — pre-existing |

### Round 2 Findings & Disposition

| # | Finding | Source | Disposition |
|---|---------|--------|-------------|
| 14 | `localOnly` is `const`, can't reassign in Fix 3 | Claude | **ADOPT** — changed to `let` |
| 15 | Fix 3 doesn't update in-memory `slot.remote_url` | Claude | **ADOPT** — cast + assign |
| 16 | Fix 2 sketch early `return` skips shallow/symlink | Claude | **ADOPT** — restructured: no early return |
| 17 | Fix 2 is critical correctness, not optional perf | Both | **ADOPT** — elevated to Fix 2 |
| 18 | Pool guard may disable pool for parallel runners with stale workspace origins | Codex | **ACCEPT** — correct behavior for pre-fix state |
| 19 | Legacy push path also false-success | Codex | **DEFER** — different path, tracked separately |
| 20 | `sealWorkstreamsForMerge` completed before push | Codex | **DEFER** — parallel-session path |
| 21 | Self-healing repair brittle for moved/deleted repos | Codex | **ACCEPT** — fails gracefully (catch, stays localOnly) |
| 22 | `ensureSlotClone` sketch incomplete (no-tags, timeout) | Both | **ADOPT** — full implementation in sketch |
| 23 | TOCTOU gap real but deferable | Both | **DEFER** — pre-existing, tracked separately |

### Round 3 Findings & Disposition (post-implementation, Codex)

| # | Finding | Source | Severity | Disposition |
|---|---------|--------|----------|-------------|
| 24 | Fix 4 skips pool mode when `resolveRemoteUrl(projectPath)=null`; self-heal in Fix 3 only runs in pool mode; for parallel runners with stale workspace clones, self-heal never runs | Codex | Critical (claimed) | **REJECT** — False positive. In single-runner mode `projectPath` is the real project with a real remote; Fix 4 allows pool mode. For parallel runners with stale workspace clones, this is already accepted in Finding #18. |
| 25 | Self-heal uses `cloneOrigin` directly as `cwd`; relative origins (`../repo`) not normalized | Codex | Major | **ADOPT** — Added `resolve(slotPath, cloneOrigin)` for `.`-prefixed origins |
| 26 | `tolerateFailure: true` for existing-clone repair in `ensureSlotClone`; mismatch between DB `remote_url` and actual git origin if repair fails | Codex | Major | **DEFER** — Risk is narrow (repair failure is unusual; subsequent fetch also fails → prepareForTask returns ok=false → retry). Design chose lenient repair for stale slots. |
| 27 | Unnecessary `(slot as { remote_url: string | null }).remote_url = upstreamRemote` cast | Codex | Minor | **ADOPT** — `PoolSlot.remote_url` is not readonly; simplified to `slot.remote_url = upstreamRemote` |
| 28 | Tests lack coverage for Fix 4 guard, relative/tilde origin self-heal, and repair failure path | Codex | Major (test gap) | **DEFER** — Edge cases accepted in prior rounds. Follow-up task appropriate. |
