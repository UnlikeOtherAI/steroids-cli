# Branch Targeting — Per-Section Branch and Auto-PR

> **Status:** Draft (v4 — post third cross-provider review)
> **Date:** 2026-02-27
> **Author:** Claude (design), Human (requirements)
> **Blocks:** [PR Watch Design](./2026-02-27-pr-watch-design.md) — must be implemented first

## Problem Statement

Today, all steroids task work pushes to a single branch (default: `main`). The `git.branch` config exists but is underused — the daemon path respects it, but the interactive `loop.ts` CLI path and most parameter defaults hardcode `'main'`. This creates two problems:

1. **No feature isolation.** All tasks across all sections push to the same branch. You can't work on "Auth System" and "Payment System" independently without merge conflicts.
2. **No PR workflow.** There's no way to have steroids create a feature branch, do work on it, and then create a PR when the section is complete.

## Current Behavior

**Single-project mode (non-pool, legacy):**
- `git.branch` config defaults to `'main'` (`src/config/schema.ts:87`)
- `pushToRemote()` in `src/git/push.ts:40` accepts a branch parameter but constructs the git command with template string interpolation — a shell injection risk for non-standard branch names
- `daemon.ts:336` correctly reads `config.git?.branch` and passes it through
- `loop.ts` (interactive CLI) does not pass `branchName` at all — falls through to `'main'` defaults
- `branchName` flows as a parameter through multiple files in this path:
  - `loop-phases-coder.ts:59` — `branchName = 'main'` parameter default
  - `loop-phases-coder-decision.ts:161` — receives and passes `branchName`; calls `pushToRemote()` at lines 214, 265, 323
  - `loop-phases-reviewer.ts:118` — `branchName: string = 'main'` default; calls `pushToRemote()` at lines 408, 451
  - `orchestrator-loop.ts:377` — calls `pushToRemote()` in batch mode
- All tasks across all sections push to the same branch

**Single-project mode (pool path, primary daemon path):**
- When a runner has a `runnerId`, tasks are processed using the workspace pool (`~/.steroids/workspaces/<hash>/pool-N/`)
- `prepareForTask()` in `src/workspace/git-lifecycle.ts:128` calls `resolveBaseBranch(slotPath, remote)` which auto-detects `main` or `master`
- The detected branch is stored as `slot.base_branch` in the global DB
- `mergeToBase()` in `git-lifecycle.ts:264` reads `slot.base_branch` and pushes to it — this path does **not** use `pushToRemote()` or `branchName` at all
- **This is the primary execution path for all daemon-mode runners.**

**Parallel mode:**
- Auto-creates `steroids/ws-${sessionId}-${index}` branches per workstream
- Cherry-picks commits back to `main` via integration workspace
- Branch names are ephemeral and auto-cleaned

**Config (existing):**
```yaml
git:
  remote: "origin"    # Used in parallel merge and daemon
  branch: "main"      # Used in daemon auto-merge; ignored by loop.ts
```

No changes to `CONFIG_SCHEMA` in `schema.ts` are needed — `git.branch` and `git.remote` are already defined.

## Desired Behavior

1. **Project-level branch actually works everywhere.** `git.branch` is respected in all code paths, including the pool path.
2. **Section-level branch override.** Each section can target a different branch. If not set, inherits from project config.
3. **Auto-PR on section completion.** When all tasks in a section reach a terminal state and at least one is `completed`, optionally create a PR from the section's branch to the project's base branch.

## Design

### Branch Resolution

A single shared function resolves the effective branch for any task:

```typescript
// src/git/branch-resolver.ts
export function resolveEffectiveBranch(
  db: Database,
  sectionId: string | null,
  config: SteroidsConfig
): string {
  if (sectionId) {
    const section = db
      .prepare('SELECT branch FROM sections WHERE id = ?')
      .get(sectionId) as { branch: string | null } | undefined;
    if (section?.branch) return section.branch;
  }
  return config.git?.branch ?? 'main';
}
```

That's it. No per-task branches. No mode toggles. One function, one rule.

**Phase 1 implementation note:** In Phase 1, `resolveEffectiveBranch()` returns `null` (return type: `string | null`) — there is no section-level override yet. Callers treat `null` as "use project base branch." The `sections.branch` DB query (lines 71–73 above) is NOT included yet because migration `021` has not run. Phase 2 step 11 adds the DB query and changes the return type to `string` (with `config.git?.branch ?? 'main'` as the final fallback, moved inside the function). When Phase 2 lands, callers must remove the `?? config.git?.branch ?? 'main'` nullish-chain fallbacks currently applied to the `null` return in `loop-phases-reviewer.ts`.

All call sites that currently resolve `branchName` must use `resolveEffectiveBranch()` instead of hardcoded defaults. The full audit scope is: `loop-phases-coder.ts`, `loop-phases-coder-decision.ts`, `loop-phases-reviewer.ts`, `orchestrator-loop.ts`, `daemon.ts`, `loop.ts`, `wakeup-runner.ts`, and the pool path in `git-lifecycle.ts` (see next section).

### Branch Resolution in Pool Mode

The pool path is the **primary execution path** for all daemon runners. It must be explicitly handled.

**How the pool path currently works:**
1. `runCoderPhase()` calls `prepareForTask(globalDb, slot, taskId, projectPath)` in `git-lifecycle.ts`
2. `prepareForTask()` calls `resolveBaseBranch(slotPath, remote, configBranch)` (line 131) — checks `configBranch` first, then auto-detects `main` or `master` by probing the remote
3. The detected branch is stored in `slot.base_branch` via `updateSlotStatus()` (line 192)
4. `mergeToBase()` reads `slot.base_branch` (line 264) and pushes all task commits to it

**What must change:**
`prepareForTask()` must accept a `sectionBranch: string | null` parameter. When provided:

1. Use `configBranch` (a new parameter passed by the caller as `config.git?.branch ?? null`) as the fork point for the section branch. `configBranch` is passed as the third argument to `resolveBaseBranch()`, which checks it first on the remote before falling back to `main`/`master` auto-detection. The caller also passes the result as `sectionBranch` to use as `slot.base_branch`.
2. Call `ensureBranchExists(slotPath, sectionBranch, projectBase, remote)` to set up the section branch in the isolated slot clone (see "Branch Creation" section — `slotPath` is safe because it is an isolated clone, not the user's working tree)
3. Use `sectionBranch` as `baseBranch` for `updateSlotStatus()` — this makes `mergeToBase()` push to the section branch automatically without any changes to `mergeToBase()` itself

```typescript
// src/workspace/git-lifecycle.ts — prepareForTask signature change
export function prepareForTask(
  globalDb: Database.Database,
  slot: PoolSlot,
  taskId: string,
  projectPath: string,
  sectionBranch: string | null = null,   // NEW: section's target branch
  configBranch: string | null = null // NEW: config.git.branch from caller
): PrepareResult {
  // ...existing steps 1-3 (clone, rebase guard, fetch)...

  // Step 4: Resolve project base branch (configBranch takes priority over auto-detect)
  const projectBase = resolveBaseBranch(slotPath, localOnly ? null : remote, configBranch);
  if (!projectBase) {
    return {
      ok: false,
      reason: 'No valid base branch (neither main nor master found)',
      blocked: true,
    };
  }

  // Step 4b: If section branch set, ensure it exists in slot; use as base
  let baseBranch = projectBase;
  if (sectionBranch && !localOnly) {
    ensureBranchExists(slotPath, sectionBranch, projectBase, remote);
    baseBranch = sectionBranch;
  }

  // Step 5: Reset to effective base (unchanged logic, updated variable)
  const baseRef = localOnly ? baseBranch : `${remote}/${baseBranch}`;
  execGit(slotPath, ['checkout', baseBranch], { tolerateFailure: true });
  execGit(slotPath, ['reset', '--hard', baseRef]);
  // ...steps 6-10 unchanged...
}
```

**Caller change (done):** `runCoderPhase()` calls `resolveEffectiveBranch(db, task.section_id, config)` and passes:
- the result as `sectionBranch` to `prepareForTask()` (null when equal to project base, to skip section-branch setup)
- `config.git?.branch ?? null` as `configBranch` to `prepareForTask()`

This avoids threading `SteroidsConfig` through `resolveBaseBranch()`. The config is consulted in `resolveBaseBranch()` via the `configBranch` parameter.

**`mergeToBase()` requires no changes** — it already uses `slot.base_branch`, which will now contain the section branch when applicable.

**`resolveBaseBranch()` update:** The function now accepts `configBranch: string | null = null` as a third parameter (`git-helpers.ts:79`). When `configBranch` is non-null and not `main`/`master`, it is checked first on the remote before falling back to `main` then `master`. Callers pass `config.git?.branch ?? null` as `configBranch` to `prepareForTask()`, which passes it through to `resolveBaseBranch()`. This correctly supports projects using `config.git.branch: develop` or other custom base branches.

### Configuration

**Project-level** (existing config, enforce usage everywhere):
```yaml
git:
  remote: "origin"
  branch: "main"       # Base branch. All sections default to this.
```

**Section-level** (new DB columns):

Migration `021_add_section_branch.sql`:
```sql
ALTER TABLE sections ADD COLUMN branch TEXT;
-- NULL = inherit from project config
```

Migration `022_add_section_auto_pr.sql`:
```sql
ALTER TABLE sections ADD COLUMN auto_pr INTEGER NOT NULL DEFAULT 0;
-- 0 = push only (current behavior)
-- 1 = create PR when section completes

ALTER TABLE sections ADD COLUMN pr_number INTEGER;
-- NULL = no PR created yet; non-NULL = PR exists
```

Each migration must be registered in `migrations/manifest.ts` with sequential IDs `021` and `022`.

CLI:
```
steroids sections add "Auth System" --branch feature/auth --auto-pr
steroids sections update "Auth System" --branch feature/auth
```

Note: `steroids sections update` does not currently exist in `src/commands/sections-commands.ts` (only `add`, `priority`, `depends-on`, `no-depends-on` exist). Implementing it requires a new subcommand handler, a new DB update query, and wiring in the sections command dispatcher.

**Branch name validation:** Branch names stored via `--branch` must be validated at input time to contain only `[a-zA-Z0-9/_.-]`. This prevents injection through `pushToRemote()` in `src/git/push.ts`, which must be updated to use `execFileSync` with argument arrays (see `git-helpers.ts` for the established pattern) rather than template string concatenation.

When `--auto-pr` is used, validate `gh` CLI availability immediately and warn if missing. Don't let the user discover this hours later at section completion time.

**GitHub-only limitation:** The `auto_pr` feature uses `gh` CLI, which is GitHub-specific. GitLab, Bitbucket, and other remotes are not supported in this design. This is documented in Non-Goals.

When a section has a `branch` set:
- If the branch doesn't exist locally or remotely in the pool slot, create it from the project's base branch
- All tasks in that section push to this branch via `mergeToBase()`
- The branch name is shown in `steroids sections list` and the web UI

### Auto-PR on Section Completion

PR state is **derived, not stored as a status**. Sections have no `status` column today — completion is derived from task states. We follow the same pattern:

- `section.pr_number IS NOT NULL` means PR has been created
- `section.pr_number IS NULL` + section is "done" + `auto_pr = 1` means PR needs creation

**Section completion semantics:** A section is "done for PR purposes" when all tasks are in terminal states AND at least one has `completed`. Terminal states: `completed`, `skipped`, `failed`, `disputed`, `blocked_error`, `blocked_conflict`. Non-terminal states (must be zero): `pending`, `in_progress`, `review`, `partial`.

```typescript
// src/git/section-pr.ts
export async function checkSectionCompletionAndPR(
  db: Database,
  projectPath: string,
  sectionId: string,
  config: SteroidsConfig
): Promise<void> {
  const section = getSection(db, sectionId);
  if (!section.auto_pr || !section.branch || section.pr_number) return;

  const counts = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status IN ('pending','in_progress','review','partial') THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
    FROM tasks WHERE section_id = ?
  `).get(sectionId) as { total: number; active: number; completed: number };

  // All tasks terminal AND at least one completed
  if (counts.total > 0 && counts.active === 0 && counts.completed > 0) {
    await createSectionPR(db, projectPath, section, config);
  }
}
```

**PR detection — deterministic output:** Use `gh pr list` with `--json` flag to avoid parsing human-readable CLI output (required by the Determinism First principle in AGENTS.md). Do not parse unstructured text from `gh`:

```typescript
// Structured JSON output — deterministic, not fragile text parsing
let existingPrNumber: number | null = null;
try {
  const output = execFileSync('gh', [
    'pr', 'list',
    '--head', section.branch,
    '--base', projectBranch,
    '--json', 'number',
    '--jq', '.[0].number',
  ], { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  existingPrNumber = output ? parseInt(output, 10) : null;
} catch {
  existingPrNumber = null; // gh not available or no PRs
}
```

**PR creation — no shared temp files:** Pass the PR body inline via an argument array to avoid any race condition with a shared temp file path (multiple sections completing simultaneously would collide on a shared `/tmp` file):

```typescript
const prBody = [
  `## ${section.name}`,
  section.description ? `\n${section.description}\n` : '',
  `### Completed tasks`,
  completedTasks.map(t => `- ${t.title}`).join('\n'),
].join('\n');

execFileSync('gh', [
  'pr', 'create',
  '--base', projectBranch,
  '--head', section.branch,
  '--title', `Section: ${section.name}`,
  '--body', prBody,
], { cwd: projectPath, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
```

The `createSectionPR()` function records the returned PR number in `sections.pr_number`.

**Trigger locations (explicit hook sites):**

`checkSectionCompletionAndPR()` must be called from ALL three approval paths:

1. **Pool approval path:** in `src/commands/loop-phases-reviewer.ts`, after `approveTask(db, task.id, 'orchestrator', decision.notes, mergeResult.mergedSha || commitSha)` at line 390. This is the pool path (mergedSha comes from `mergeToBase()`). This hook site does not currently exist.

2. **Non-pool reviewer approval path:** in `src/commands/loop-phases-reviewer.ts`, after `approveTask(db, task.id, 'orchestrator', decision.notes, commitSha)` at line 397. This is the non-pool path (no mergedSha). This hook site does not currently exist.

Note: `src/commands/loop-phases.ts` is a 14-line barrel re-export file — do not add hooks there.

3. **Manual CLI approval:** in `src/commands/tasks.ts`, `approveTaskCmd()` at line 1145. A `checkSectionCompletion()` stub exists at line 1009 but does not create PRs and uses the flawed "only counts `completed`" semantics. Replace it with `checkSectionCompletionAndPR()`.

### What Happens to Existing Behavior

| Scenario | Before | After |
|---|---|---|
| No section branch set | Push to `main` | Push to `git.branch` (default `main`) — same |
| Section has `branch: feature/x` | N/A (new) | Push to `feature/x`; create from project base if missing |
| `auto_pr = 1`, section done | N/A | Create PR from section branch to project base branch |
| `auto_pr = 0`, section done | Normal (tasks complete) | Same — no PR created |
| Pool path — no section branch | Push to auto-detected `main`/`master` | Push to `config.git.branch` (now correctly used) |
| Pool path — section branch set | Push to auto-detected `main`/`master` | Push to section branch via `slot.base_branch` |

### Branch Creation

`ensureBranchExists()` is called on **pool slot paths only** (`slotPath`, an isolated clone under `~/.steroids/workspaces/<hash>/pool-N/`). It must NOT be called on `projectPath` (the user's actual working tree), as that would corrupt the working tree with an unexpected `git checkout` while tasks have uncommitted changes. The workspace pool was introduced precisely to eliminate this class of working-tree mutation.

```typescript
// src/git/branch-resolver.ts — operates on slotPath, NEVER on projectPath
export function ensureBranchExists(
  slotPath: string,
  branch: string,
  baseBranch: string,
  remote: string
): void {
  // 1. Remote branch exists — check out tracking it (authoritative)
  const hasRemote = execGit(slotPath, ['rev-parse', '--verify', `${remote}/${branch}`], {
    tolerateFailure: true,
  });
  if (hasRemote !== null) {
    execGit(slotPath, ['checkout', '-B', branch, `${remote}/${branch}`]);
    return;
  }

  // 2. No remote — check for local branch (may be freshly created and not yet pushed)
  const hasLocal = execGit(slotPath, ['rev-parse', '--verify', branch], {
    tolerateFailure: true,
  });
  if (hasLocal !== null) {
    execGit(slotPath, ['checkout', branch]);
    return;
  }

  // 3. Neither — create from project base and push to remote
  execGit(slotPath, ['checkout', '-B', branch, `${remote}/${baseBranch}`]);
  execGit(slotPath, ['push', remote, branch]);
}
```

Edge cases: remote branch deleted externally → local branch may exist from prior run (path 2); neither exists → created fresh from project base and pushed (path 3).

`execGit()` from `src/workspace/git-helpers.ts` uses `execFileSync` with an argument array — no shell injection risk. All git operations are passed as arrays, not template strings.

### `branchName` Refactoring Scope

The `branchName` parameter flows through multiple files. The complete call-site audit:

**Non-pool path (must switch to per-task resolution):**
1. `loop-phases-coder.ts:59` — `branchName = 'main'` parameter default
2. `loop-phases-coder-decision.ts:161,214,265,323` — receives `branchName`; 3 `pushToRemote()` calls
3. `loop-phases-reviewer.ts:118,408,451` — `branchName: string = 'main'` default; 2 `pushToRemote()` calls
4. `orchestrator-loop.ts:377` — `pushToRemote()` in batch mode path
5. `loop.ts` — does NOT pass branchName (uses defaults)
6. `daemon.ts:253` — passes `options.branchName` from config

**Pool path (new — pass sectionBranch to prepareForTask):**
7. `src/workspace/git-lifecycle.ts` — `prepareForTask()` must accept `sectionBranch` parameter

**Parallel workstream restart (leave untouched):**
8. `wakeup-runner.ts:79` — passes `--branch ws.branchName` carrying the workstream's ephemeral `steroids/ws-<sessionId>-<index>` branch from the global DB. This must NOT be changed — removing it would break restart of existing parallel sessions. Since parallel mode + section branches is deferred, this code path remains unchanged.

**`pushToRemote()` is already updated** (Phase 1 step 2 complete) to use `execFileSync` with an argument array, preventing shell injection. Note: there is no `execFileNoThrow` utility in this codebase — the established pattern is `execFileSync` from `node:child_process` wrapped in try/catch, as used throughout `git-helpers.ts`.

**Approach:** Remove `branchName` from loop-level options for the non-pool path. Instead, call `resolveEffectiveBranch(db, task.section_id, config)` inside `runCoderPhase()` and `runReviewerPhase()` for each task. For the pool path, pass the result as `sectionBranch` to `prepareForTask()`.

### Phase 4 Web UI Specification

**API contract:** `GET /api/sections` response must include `branch: string | null` and `pr_number: number | null` for each section object. No new polling endpoint is needed — these fields piggyback on the existing section data the UI already fetches.

**PR URL derivation:** When `pr_number` is set, derive the GitHub PR URL from the git remote URL: strip `.git` suffix from `git remote get-url origin`, append `/pull/{pr_number}`. This derivation lives in the API layer, not the DB.

**UI elements (section card):**
- When `section.branch` is set: show a small branch badge (e.g., `⎇ feature/auth`) below the section name in the section card header. Use muted/secondary styling — it is contextual info, not a primary action.
- When `section.pr_number` is set: show a `PR #123` link badge next to or below the branch badge, clickable, opens the GitHub PR URL in a new tab.
- When `section.pr_number` is null but `section.auto_pr = 1` and section is not yet complete: show a subtle `Auto-PR` indicator so users know a PR will be created on completion.

**Implementation tasks (1–3 files each):**
1. Add `branch` and `pr_number` to `/api/sections` DB query and response type (1–2 files: API handler + query)
2. Render branch badge and PR link in section card component (1–2 files: web UI component)
3. Update README and CLI help text for new flags (1–2 files)

## Implementation Order

### Phase 1: Wire `git.branch` Through Everything
1. ✅ **Done** — Created `src/git/branch-resolver.ts` with `resolveEffectiveBranch()` (Phase 1 stub: returns `null` — `string | null` type — no section override yet) and `ensureBranchExists()` (3-path logic: remote → local → create)
2. ✅ **Done** — Updated `src/git/push.ts:pushToRemote()` to use `execFileSync` with argument array; branch name validation at input
3. ✅ **Done** — Updated `prepareForTask()` in `src/workspace/git-lifecycle.ts` to accept `sectionBranch` and `configBranch` parameters with `null` defaults; updated `resolveBaseBranch()` in `git-helpers.ts` to accept `configBranch` as third parameter
4. ✅ **Done** — Updated `loop-phases-coder.ts` to call `resolveEffectiveBranch()` per task for the pool path (returns `null` in Phase 1, so `sectionBranch` passed to `prepareForTask()` is always `null` until Phase 2)
5. 🔄 **Partial** — `loop-phases-reviewer.ts` imports `resolveEffectiveBranch` and calls it conditionally; `branchName` parameter with `'main'` default remains for backward compat. Full migration in Phase 2.
6. ❌ **To do** — Audit `daemon.ts`, `loop.ts`, `orchestrator-loop.ts:377` (batch mode push) — replace with `resolveEffectiveBranch()`
7. ✅ **Done** — `loop-phases-coder.ts` pool path already passes both `sectionBranch` (null when equal to project base) and `configBranch` to `prepareForTask()`. Note: `loop-phases-reviewer.ts` imports `prepareForTask` but does NOT call it directly — preparation always happens in the coder phase before the reviewer runs.
8. ✅ **Done** — `Section` interface in `src/database/queries.ts:59` already includes `branch?: string | null`, `auto_pr?: number`, and `pr_number?: number | null`
9. ❌ **To do** — Tests: verify push targets the configured branch from non-pool path (pool path tests are in Phase 2 step 15 — pool caller wiring is deferred until the DB column exists)

### Phase 2: Section Branch Column
10. Create `migrations/021_add_section_branch.sql`; register in `migrations/manifest.ts`
11. Update `resolveEffectiveBranch()` to read `section.branch` (requires Phase 1 complete)
12. CLI: `--branch` flag on `steroids sections add`; validate branch name format at input time
13. Implement `steroids sections update` subcommand (new handler in `sections-commands.ts`, new DB update query, wired in sections dispatcher)
14. Update pool path: pass `resolveEffectiveBranch()` result as `sectionBranch` to `prepareForTask()`; call `ensureBranchExists()` on slot path
15. Tests: section branch override, branch creation from project base, pool path pushes to section branch

### Phase 3: Auto-PR
16. Create `migrations/022_add_section_auto_pr.sql`; register in `migrations/manifest.ts`
17. CLI: `--auto-pr` flag on `steroids sections add`/`update` with `gh` availability validation at config time
18. Create `src/git/section-pr.ts` with `checkSectionCompletionAndPR()` using terminal-state completion semantics, `gh --json` for detection, and inline body for creation
19. Hook `checkSectionCompletionAndPR()` into: `loop-phases-reviewer.ts` line 390 (pool path, after `approveTask()` with mergedSha), `loop-phases-reviewer.ts` line 397 (non-pool path, after `approveTask()` with commitSha), and `tasks.ts:approveTaskCmd()` line 1145 (manual CLI)
20. Add `steroids sections reset-pr "Section Name"` CLI command that clears `pr_number` for the given section (allows re-triggering auto-PR after a PR has been merged externally)
21. Update existing `checkSectionCompletion()` in `tasks.ts:1009` to use terminal-state semantics (active === 0 AND completed > 0); align the `triggerSectionCompleted()` hook behavior accordingly
22. Update `steroids sections list` to show branch and PR info
23. Tests: auto-PR creation, idempotency, existing PR detection via `gh --json`, failed-task semantics, concurrent completion safety, `reset-pr` command

### Phase 4: Docs + Web UI
24. Add `branch` and `pr_number` to `/api/sections` query and response type
25. Render branch badge and PR link in section card (per Web UI spec above)
26. Update CLI help text for new flags
27. Update README

## Edge Cases

| Scenario | Handling |
|---|---|
| Two sections target the same branch | Works fine — both push to that branch via pool slots. Rebase at task completion time handles ordering. |
| Section branch deleted externally | Re-create from project base on next `ensureBranchExists()` call. Log a warning. |
| PR already exists for this branch | Detect via `gh pr list --json number`. Skip creation, record existing PR number. |
| Section has branch but no tasks | No push, no PR. `counts.total === 0` prevents trigger. |
| Task in section with branch fails | Same as today — retry logic unchanged. Section branch persists. PR not triggered until all tasks are terminal. |
| `auto_pr` but `gh` not installed | Warned at `--auto-pr` config time. At completion: skip PR, log warning. Commits still pushed to section branch. |
| Section branch diverged from base | Merge conflicts handled on the PR itself. `mergeToBase()` rebases task branch onto section branch at task completion. |
| `auto_pr` section re-opened (new tasks added) | `pr_number` stays set. New tasks push commits to same branch. New commits appear on the existing open PR. |
| PR merged externally, new tasks added | `pr_number` is set so no new PR is created. New commits push to the already-merged branch. User clears via `steroids sections reset-pr "Name"` (Phase 3 CLI command) or automatic detection via `gh pr view {pr_number} --json state`. |
| Section has `failed` or `skipped` tasks | PR triggers only when `active === 0 AND completed > 0`. A section with all-`skipped` tasks and zero `completed` never triggers. |
| Project uses `develop` not `main`/`master` | Phase 2 callers pass `config.git.branch` as `configBranch` to `prepareForTask()`. This takes priority over `resolveBaseBranch()` auto-detection. Without this fix, `prepareForTask()` would default to `main`/`master`. |
| Non-GitHub remote (GitLab, Bitbucket) | `auto_pr` feature is GitHub-only (uses `gh` CLI). Flagged at `--auto-pr` config time. Branch push works regardless of remote type. |

## Non-Goals

- **Per-task branches** — tasks are too small (1-3 files). Sections are the natural PR boundary.
- **Parallel mode + section branches** — deferred to a separate design. The parallel workstream branch model (`steroids/ws-*`) is architecturally different from persistent section branches. `runParallelMerge` auto-deletes source branches and merges to `mainBranch`, which would clobber persistent section branches. Merging these two systems requires its own design. For now, parallel mode continues to use ephemeral workstream branches.
- **GitLab / Bitbucket auto-PR** — `auto_pr` uses `gh` CLI, which is GitHub-only. GitLab and Bitbucket MR creation is out of scope for this design.
- **Non-pool mode branch auto-creation** — `ensureBranchExists()` operates on pool slot clones only. In non-pool mode (interactive `steroids loop`), `resolveEffectiveBranch()` is still called and the section branch is used in `pushToRemote()`. However, the branch must pre-exist — non-pool mode will NOT auto-create it. If the branch does not exist, `git push` will fail and the coder will receive an error. Users of non-pool mode with section branches must create the branch manually before running `steroids loop`.
- **Branch protection rule management** — use GitHub's own settings.
- **Merge strategy config per section** — use GitHub's PR merge settings.
- **Auto-merge PRs** — that's PR Watch's job (the next feature).
- **Branch cleanup after merge** — use GitHub's "auto-delete head branches" setting.

---

## Cross-Provider Review — Round 1

> Reviewed by: **Codex** (gpt-5.3-codex) and **Claude Opus 4.6**
> Date: 2026-02-27

### Findings and Decisions

**Codex CRITICAL #1: Parallel merge destroys section branches**
Decision: ADOPT — defer parallel mode entirely.

**Codex HIGH #2: Scattered hardcoded branch defaults**
Decision: ADOPT. Created `resolveEffectiveBranch()` in `src/git/branch-resolver.ts`.

**Codex HIGH #3: Non-deterministic branch creation in clone path**
Decision: ADOPT. Created `ensureBranchExists()` with explicit base branch parameter.

**Codex HIGH #4 + Claude HIGH #2: `pr_created` status violates existing pattern**
Decision: ADOPT. Removed `pr_created` status. PR state derived from `pr_number IS NOT NULL`.

**Codex HIGH #5: Auto-PR trigger only fires from one path**
Decision: ADOPT. Created idempotent `checkSectionCompletionAndPR()` callable from both paths.

**Codex MEDIUM #6: Multi-section-per-workstream cherry-pick**
Decision: ADOPT — removed. Deferred with parallel mode.

**Claude MEDIUM #3: `branchName` refactoring is not "mechanical"**
Decision: ADOPT. Documented full refactoring scope.

**Claude MEDIUM #5: `gh` check should be at config time**
Decision: ADOPT. Validate `gh` when `--auto-pr` flag is used.

**Claude LOW #6, #7: Config schema note + merge caller verification**
Decision: ADOPT. Added to Phase 1 audit checklist and Current Behavior section.

---

## Cross-Provider Review — Round 2

> Reviewed by: **Claude Sonnet 4.6** (subagent) and **Codex** (gpt-5.3-codex)
> Date: 2026-02-27
> Source files read: `git-lifecycle.ts`, `push.ts`, `loop-phases-*.ts`, `git-helpers.ts`

### Findings and Decisions

**Claude CRITICAL #1 (NEW): Pool push path completely ignored**
`prepareForTask()` calls `resolveBaseBranch()` at line 131 and stores the result as `slot.base_branch`. `mergeToBase()` reads `slot.base_branch` and pushes to it. The entire previous design focused on `pushToRemote()` call sites but missed the primary daemon execution path. A correct implementation that only fixed `branchName` in the non-pool path would silently push to `main` for all daemon runners.
**Decision: ADOPT.** Added "Branch Resolution in Pool Mode" section. `prepareForTask()` gains `sectionBranch` parameter. Pool path fixed without changes to `mergeToBase()`.

**Claude CRITICAL #2 (NEW): `ensureBranchExists()` called on user working tree**
The original design called `ensureBranchExists()` on `projectPath`. A `git checkout` call on the user's actual working tree while tasks have uncommitted changes corrupts the working directory.
**Decision: ADOPT.** Restricted `ensureBranchExists()` to pool slot paths only. Added non-pool limitation to Non-Goals.

**Codex + Claude HIGH: `/tmp/pr-body.md` race condition**
Shared literal temp file path causes collision when two sections complete concurrently.
**Decision: ADOPT.** Replaced temp file with inline `--body` string passed via argument array. No temp file needed.

**Codex + Claude HIGH: Only `completed` tasks counted as done**
`counts.total === counts.done` never triggers if any task is `skipped`, `failed`, `disputed`, or `blocked_*`. PR creation deadlocks permanently.
**Decision: ADOPT.** Updated query to count `active` (non-terminal) tasks. Condition: `active === 0 AND completed > 0`.

**Claude HIGH #3 (NEW): Auto-PR hook missing from pool approval path**
`checkSectionCompletion()` in `tasks.ts` is only called from manual CLI approval. Both the pool approval path and non-pool reviewer approval path in `src/commands/loop-phases-reviewer.ts` (lines 390 and 397 respectively) have no section completion hook.
**Decision: ADOPT.** Documented all three hook sites explicitly.

**Codex + Claude HIGH: `wakeup-runner.ts --branch` cannot be simply removed**
`wakeup-reconcile.ts` uses `--branch` to pass the workstream's ephemeral branch when restarting parallel sessions. Removing it breaks existing parallel session restarts.
**Decision: ADOPT.** `--branch` argument stays for parallel workstream restarts. Per-task section branch resolution is internal to the loop phases.

**Codex HIGH: `gh pr list` output parsing violates Determinism First**
Parsing human-readable CLI output is fragile. AGENTS.md requires deterministic structured output.
**Decision: ADOPT.** All `gh` invocations use `--json` flag with specific field selection.

**Claude MEDIUM #2 (NEW): `loop-phases-coder.ts` and `loop-phases-coder-decision.ts` missed**
The previous design mentioned `loop-phases.ts` as a single file. The actual codebase has 4 loop-phases files; `loop-phases-coder-decision.ts` has 3 `pushToRemote()` calls.
**Decision: ADOPT.** Updated branchName refactoring scope to list all 7 call-site locations accurately.

**Claude MEDIUM #3 (NEW): `Section` interface in `queries.ts` not mentioned**
TypeScript callers would get type errors accessing `section.branch` without updating the interface first.
**Decision: ADOPT.** Added explicit Phase 1 task (step 8) to update `Section` interface.

**Claude MEDIUM: `pushToRemote()` uses template string interpolation**
`src/git/push.ts:40` constructs git command via template string — shell injection risk for branch names with special characters.
**Decision: ADOPT.** Phase 1 includes updating `pushToRemote()` to use `execFileSync` with argument array (same pattern as `git-helpers.ts`). Branch names validated at input time.

**Claude MEDIUM #5 (NEW): `resolveBaseBranch()` ignores `config.git.branch`**
Projects using `config.git.branch: develop` would fail `prepareForTask()` because `resolveBaseBranch()` only checks `main`/`master`.
**Decision: ADOPT.** `resolveBaseBranch()` now accepts `configBranch: string | null = null` as a third parameter and checks it on the remote first. `prepareForTask()` passes this through from the caller's `config.git?.branch ?? null`. This correctly supports non-`main`/`master` base branches like `develop`.

**Claude MEDIUM #4 (NEW): Batch mode `pushToRemote` not in audit**
`orchestrator-loop.ts:377` has a `pushToRemote()` call in batch mode that was missing from the audit list.
**Decision: ADOPT.** Added to Phase 1 step 6.

**Codex LOW: DB migrations must use numbered files**
The project uses numbered SQL migration files (`001`–`020`) with a manifest. Raw `ALTER TABLE` in the design doesn't align with project conventions.
**Decision: ADOPT.** Specified `021_add_section_branch.sql` and `022_add_section_auto_pr.sql` with manifest registration.

**Claude LOW #1 (NEW): Phase 4 Web UI not implementable from 3 bullet points**
No API contract, no UI element description, no data source specification.
**Decision: ADOPT.** Added "Phase 4 Web UI Specification" section.

**Claude LOW #2 (NEW): `steroids sections update` does not exist**
The design assumed a one-line CLI addition. It requires a new subcommand handler, a new DB update query, and dispatch wiring.
**Decision: ADOPT.** Noted in Configuration section. Sized as its own Phase 2 task (step 13).

**Claude LOW #3 (NEW): Migration version numbers not specified**
Coders cannot write migrations without knowing the current highest ID.
**Decision: ADOPT.** Specified `021` and `022` in Configuration section.

**Codex + Claude LOW: `pr_number` stale after external PR merge**
When a PR is merged on GitHub and new tasks are added, `pr_number` remains set, preventing a new PR. No escape hatch existed.
**Decision: ADOPT.** Added to Edge Cases with `steroids sections reset-pr` CLI command placeholder.

**Codex LOW: GitHub-only limitation not documented**
`auto_pr` uses `gh` CLI (GitHub-specific). GitLab/Bitbucket users had no warning.
**Decision: ADOPT.** Added to Non-Goals as an explicit limitation.
