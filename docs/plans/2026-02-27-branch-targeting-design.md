# Branch Targeting — Per-Section Branch and Auto-PR

> **Status:** Draft (v2 — post cross-provider review)
> **Date:** 2026-02-27
> **Author:** Claude (design), Human (requirements)
> **Blocks:** [PR Watch Design](./2026-02-27-pr-watch-design.md) — must be implemented first

## Problem Statement

Today, all steroids task work pushes to a single branch (default: `main`). The `git.branch` config exists but is underused — the daemon path respects it, but the interactive `loop.ts` CLI path and most parameter defaults hardcode `'main'`. This creates two problems:

1. **No feature isolation.** All tasks across all sections push to the same branch. You can't work on "Auth System" and "Payment System" independently without merge conflicts.
2. **No PR workflow.** There's no way to have steroids create a feature branch, do work on it, and then create a PR when the section is complete.

## Current Behavior

**Single-project mode:**
- `git.branch` config defaults to `'main'` (`src/config/schema.ts:87`)
- `pushToRemote()` in `src/git/push.ts` accepts a branch parameter
- `daemon.ts:336` correctly reads `config.git?.branch` and passes it through
- BUT `loop.ts` (interactive CLI) does not pass `branchName` at all — falls through to `'main'` defaults in `orchestrator-loop.ts:137` and `loop-phases.ts:452`
- All tasks across all sections push to the same branch

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

1. **Project-level branch actually works everywhere.** `git.branch` is respected in all code paths.
2. **Section-level branch override.** Each section can target a different branch. If not set, inherits from project.
3. **Auto-PR on section completion.** When all tasks in a section are completed, optionally create a PR from the section's branch to the project's base branch.

## Design

### Branch Resolution

A single shared function resolves the effective branch for any task:

```typescript
// src/git/branch-resolver.ts
function resolveEffectiveBranch(db: Database, sectionId: string | null, config: SteroidsConfig): string {
  if (sectionId) {
    const section = db.prepare('SELECT branch FROM sections WHERE id = ?').get(sectionId);
    if (section?.branch) return section.branch;
  }
  return config.git?.branch ?? 'main';
}
```

That's it. No per-task branches. No mode toggles. One function, one rule.

All call sites that currently resolve `branchName` (`loop-phases.ts`, `orchestrator-loop.ts`, `loop.ts`, `daemon.ts`) must use `resolveEffectiveBranch()` instead of hardcoded defaults or scattered `config.git?.branch ?? 'main'` expressions.

### Configuration

**Project-level** (existing config, just enforce usage everywhere):
```yaml
git:
  remote: "origin"
  branch: "main"       # Base branch. All sections default to this.
```

**Section-level** (new DB columns):
```sql
ALTER TABLE sections ADD COLUMN branch TEXT;
-- NULL = inherit from project config

ALTER TABLE sections ADD COLUMN auto_pr INTEGER NOT NULL DEFAULT 0;
-- 0 = push only (current behavior)
-- 1 = create PR when section completes

ALTER TABLE sections ADD COLUMN pr_number INTEGER;
-- NULL = no PR created yet; non-NULL = PR exists
```

CLI:
```
steroids sections add "Auth System" --branch feature/auth --auto-pr
steroids sections update "Auth System" --branch feature/auth
```

When `--auto-pr` is used, validate `gh` CLI availability immediately and warn if missing. Don't let the user discover this hours later at section completion time.

When a section has a `branch` set:
- If the branch doesn't exist locally or remotely, create it from the project's base branch
- All tasks in that section push to this branch
- The branch name is shown in `steroids sections list` and the web UI

### Auto-PR on Section Completion

PR state is **derived, not stored as a status**. Sections have no `status` column today — completion is derived from task states. We follow the same pattern:

- `section.pr_number IS NOT NULL` means PR has been created
- `section.pr_number IS NULL` + all tasks completed + `auto_pr = 1` means PR needs creation

When all tasks in a section are completed:
1. Ensure all commits are pushed to the section's branch
2. Check if a PR already exists: `gh pr list --head {section_branch} --base {project_branch}`
3. If no PR: create via `gh pr create --base {project_branch} --head {section_branch} --title "Section: {name}" --body-file /tmp/pr-body.md`
4. Record the PR number in `sections.pr_number`

The PR body includes:
- Section name and description
- List of completed tasks with their commit SHAs

**Trigger location:** The section completion check must be an idempotent service function callable from both:
- The automated reviewer approval path in `loop-phases.ts`
- The manual `steroids tasks approve` CLI command

```typescript
// src/git/section-pr.ts
async function checkSectionCompletionAndPR(
  db: Database, projectPath: string, sectionId: string, config: SteroidsConfig
): Promise<void> {
  const section = getSection(db, sectionId);
  if (!section.auto_pr || !section.branch || section.pr_number) return;

  const counts = db.prepare(
    `SELECT COUNT(*) as total,
            SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as done
     FROM tasks WHERE section_id = ?`
  ).get(sectionId);

  if (counts.total > 0 && counts.total === counts.done) {
    await createSectionPR(projectPath, section, config);
  }
}
```

### What Happens to Existing Behavior

| Scenario | Before | After |
|---|---|---|
| No section branch set | Push to `main` | Push to `git.branch` (default `main`) — same |
| Section has `branch: feature/x` | N/A (new) | Push to `feature/x`; create from base if missing |
| `auto_pr = 1`, section done | N/A | Create PR from section branch to base branch |
| `auto_pr = 0`, section done | Normal (tasks complete) | Same — no PR created |

### Branch Creation

When a runner first pushes to a section branch that doesn't exist:

```typescript
// src/git/branch-resolver.ts — uses execFileSync (not exec) to prevent shell injection
function ensureBranchExists(projectPath: string, branch: string, baseBranch: string, remote: string): void {
  // Fetch latest from remote
  execFileSync('git', ['fetch', remote], { cwd: projectPath, stdio: 'pipe' });

  // Check if branch exists locally or remotely
  try {
    execFileSync('git', ['rev-parse', '--verify', branch], { cwd: projectPath, stdio: 'pipe' });
    // Branch exists locally — check it out
    execFileSync('git', ['checkout', branch], { cwd: projectPath, stdio: 'pipe' });
  } catch {
    try {
      execFileSync('git', ['rev-parse', '--verify', `${remote}/${branch}`], { cwd: projectPath, stdio: 'pipe' });
      // Branch exists on remote — track it
      execFileSync('git', ['checkout', '-b', branch, `${remote}/${branch}`], { cwd: projectPath, stdio: 'pipe' });
    } catch {
      // Branch doesn't exist anywhere — create from base
      execFileSync('git', ['checkout', '-b', branch, `${remote}/${baseBranch}`], { cwd: projectPath, stdio: 'pipe' });
    }
  }
}
```

This happens once per section branch, automatically. If the branch exists, check it out. If not, create from base.

### `branchName` Refactoring Scope

The `branchName` parameter currently flows through multiple layers:

1. `loop.ts` — does NOT pass branchName (uses defaults)
2. `daemon.ts:253` — passes `options.branchName` from config
3. `orchestrator-loop.ts:137` — destructures `branchName = 'main'` from options
4. `loop-phases.ts:452,1122` — receives `branchName = 'main'` as parameter default
5. `wakeup-runner.ts:79` — passes `--branch` to spawned runners

The fix is NOT mechanical replacement — `branchName` must be resolved **per task** (based on the task's section), not per loop invocation. The current architecture passes a single `branchName` to the entire loop run. With section branches, different tasks in the same loop iteration target different branches.

**Approach:** Remove `branchName` from the loop-level options. Instead, call `resolveEffectiveBranch(db, task.section_id, config)` inside `runCoderPhase()` and `runReviewerPhase()` for each task. This is a breaking change to the function signatures but makes branch resolution task-local and explicit.

## Implementation Order

### Phase 1: Wire `git.branch` Through Everything
1. Create `src/git/branch-resolver.ts` with `resolveEffectiveBranch()` and `ensureBranchExists()`
2. Audit ALL `branchName` resolution paths: `loop.ts`, `daemon.ts`, `orchestrator-loop.ts`, `loop-phases.ts`, `wakeup-runner.ts`
3. Replace loop-level `branchName` parameter with per-task resolution inside `runCoderPhase`/`runReviewerPhase`
4. Verify all callers of `runParallelMerge` pass `config.git.branch` for `mainBranch`
5. Tests: verify push targets the configured branch from both CLI and daemon paths

### Phase 2: Section Branch Column
6. DB migration: add `branch TEXT` column to `sections` table
7. CLI: `--branch` flag on `steroids sections add` and `steroids sections update`
8. Update `resolveEffectiveBranch()` to read `section.branch`
9. Update push logic to call `ensureBranchExists()` when section has a branch
10. Tests: section branch override, branch creation from base

### Phase 3: Auto-PR
11. DB migration: add `auto_pr INTEGER DEFAULT 0` and `pr_number INTEGER` to `sections`
12. CLI: `--auto-pr` flag with `gh` availability validation at config time
13. `checkSectionCompletionAndPR()` service function in `src/git/section-pr.ts`
14. Hook into both `loop-phases.ts` reviewer approval and `tasks approve` CLI command
15. Update `steroids sections list` to show branch and PR info
16. Tests: auto-PR creation, idempotency, existing PR detection

### Phase 4: Docs + Web UI
17. Update web API to include branch info in section/task responses
18. Update CLI help text for new flags
19. Update README

## Edge Cases

| Scenario | Handling |
|---|---|
| Two sections target the same branch | Works fine — both push to that branch. Tasks execute in section order. |
| Section branch deleted externally | Re-create from base on next push. Log a warning. |
| PR already exists for this branch | Detect via `gh pr list --head {branch}`. Skip creation, record existing PR number. |
| Section has branch but no tasks | No push, no PR. Section is immediately "complete." |
| Task in section with branch fails | Same as today — retry logic unchanged. Branch persists. |
| `auto_pr` but `gh` not installed | Warned at `--auto-pr` config time. At completion: skip PR, log warning. Commits still pushed. |
| Section branch diverged from base | Merge conflicts handled on the PR itself (GitHub shows them). |
| `auto_pr` section re-opened (new tasks added) | `pr_number` stays set. New tasks push to same branch. New commits appear on the existing PR. |

## Non-Goals

- **Per-task branches** — tasks are too small (1-3 files). Sections are the natural PR boundary.
- **Parallel mode + section branches** — deferred to a separate design. The parallel workstream branch model (`steroids/ws-*`) is architecturally different from persistent section branches. `runParallelMerge` auto-deletes source branches and merges to `mainBranch`, which would clobber persistent section branches. Merging these two systems requires its own design. For now, parallel mode continues to use ephemeral workstream branches.
- **Branch protection rule management** — use GitHub's own settings.
- **Merge strategy config per section** — use GitHub's PR merge settings.
- **Auto-merge PRs** — that's PR Watch's job (the next feature).
- **Branch cleanup after merge** — use GitHub's "auto-delete head branches" setting.

---

## Cross-Provider Review

> Reviewed by: **Codex** (gpt-5.3-codex) and **Claude Opus 4.6**
> Date: 2026-02-27
> Framework: AGENTS.md principles

### Findings and Decisions

**Codex CRITICAL #1: Parallel merge destroys section branches**
`runParallelMerge` auto-deletes source branches and merges to `mainBranch`, which would clobber persistent section branches.
**Decision: ADOPT — defer parallel mode entirely.** Added to Non-Goals with explicit rationale. The two branch models need their own design.

**Codex HIGH #2: Scattered hardcoded branch defaults**
Need a single shared resolver, not scattered replacements.
**Decision: ADOPT.** Created `resolveEffectiveBranch()` in `src/git/branch-resolver.ts`.

**Codex HIGH #3: Non-deterministic branch creation in clone path**
Clone creates branches from HEAD rather than explicit base.
**Decision: ADOPT.** Created `ensureBranchExists()` with explicit base branch parameter.

**Codex HIGH #4 + Claude HIGH #2: `pr_created` status violates existing pattern**
Sections have no status column. Completion is derived from task states.
**Decision: ADOPT.** Removed `pr_created` status. PR state derived from `pr_number IS NOT NULL`.

**Codex HIGH #5: Auto-PR trigger only fires from one path**
Must work from both automated reviewer approval and manual CLI approval.
**Decision: ADOPT.** Created idempotent `checkSectionCompletionAndPR()` callable from both paths.

**Codex MEDIUM #6: Multi-section-per-workstream cherry-pick**
Speculative complexity for an edge case.
**Decision: ADOPT — removed.** Deferred with parallel mode.

**Claude MEDIUM #3: `branchName` refactoring is not "mechanical"**
Branch must be resolved per-task, not per-loop. Signature change required.
**Decision: ADOPT.** Documented full refactoring scope.

**Claude MEDIUM #5: `gh` check should be at config time**
Don't let users discover `gh` is missing at section completion time.
**Decision: ADOPT.** Validate `gh` when `--auto-pr` flag is used.

**Claude LOW #6, #7: Config schema note + merge caller verification**
**Decision: ADOPT.** Added to Phase 1 audit checklist and Current Behavior section.
