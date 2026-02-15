# Parallelism: Clone & Conquer

> Run independent sections in parallel using isolated git clones. Each clone is a regular runner on its own branch. Merge via cherry-pick. Conflicts become tasks.

---

## Problem

Steroids processes one task at a time, in one directory, on one branch. If a project has 5 independent sections with 4 tasks each, it takes 20 serial cycles. Independent sections sit idle while unrelated work finishes.

---

## Goal

Run N independent sections simultaneously, each in its own clone, each on its own branch. When all clones finish, cherry-pick their commits onto `main` one by one. If a cherry-pick conflicts, the conflict becomes a task — the coder resolves it, the reviewer reviews the resolution. No human intervention, no special merge machinery.

---

## Prerequisites

- `.steroids/` **must be in `.gitignore`**. Clones replace this directory with a symlink. If git tracks it, the symlink would be committed, breaking the project for everyone.
- Git remote must be configured (branches need to be pushed).
- Sufficient API credits for parallel invocations.

---

## Core Concepts

### Section Dependency Graph

Sections declare dependencies. Two sections are **independent** if neither depends on the other, directly or transitively.

**Convention:** `A ──depends-on──► B` means A requires B first. B runs before A.

```
Section A ──depends-on──► Section C
Section B (no dependencies)
Section D ──depends-on──► Section A
```

- **C** starts immediately (no prerequisites)
- **A** waits for C
- **D** waits for A
- **B** is independent of everything

Chain: **C → A → D** (sequential, one clone). B runs in its own clone, in parallel.

#### Cycle Detection

Before scheduling, validate with topological sort. Cycles are a hard stop:

```
Error: Cyclic dependency detected: Section A → Section C → Section A
Fix the dependency declarations before running in parallel mode.
```

### Workstream Partitioning

The scheduler groups sections into **workstreams**:

1. Topological sort all sections
2. Find **connected components** in the dependency graph (edges treated as undirected)
3. Each connected component = one workstream
4. Within a workstream, sections are ordered by topological sort

```
Input:  Sections [A, B, C, D, E]
Deps:   A depends-on C, D depends-on A

Workstreams:
  Workstream 1: C → A → D  (one clone)
  Workstream 2: B           (one clone)
  Workstream 3: E           (one clone)
```

Each workstream gets one clone and one runner. Within a workstream, sections execute in dependency order. Across workstreams, execution is fully parallel.

### Workspace Clones

Each runner gets a full clone:

```
~/.steroids/workspaces/
├── <project-hash>/
│   ├── ws-abc123/                 # clone for Workstream 1
│   │   ├── .git/
│   │   ├── src/
│   │   └── .steroids/            # symlink → original .steroids/ DIRECTORY
│   └── ws-def456/                 # clone for Workstream 2
│       ├── .git/
│       ├── src/
│       └── .steroids/
```

**Why full clones, not worktrees?** Git worktrees share `.git` internals — `HEAD.lock`, index locks, ref locks. Parallel operations deadlock. Full clones are completely independent. `git clone --local` hardlinks objects, so disk overhead is just the working tree.

#### Database Sharing

All clones share the original `.steroids/` **directory** via symlink. This is critical because SQLite WAL mode creates companion files (`-wal`, `-shm`) next to the database. Symlinking only the `.db` file would create separate WAL files per clone, breaking shared state.

By symlinking the directory, all runners see the same tasks, locks, audit trail, and rejection history.

### Branch Strategy

Each clone works on a dedicated branch:

```
main:                    ──●──────────────────────────────●── (cherry-picks land here)
                            \                             ↑
steroids/ws-abc123:          ●──●──●──●──●──●──●         │ (cherry-pick each commit)
                                                         │
steroids/ws-def456:          ●──●──●──●──────────────────┘
```

Branch naming: `steroids/ws-<workstream-id>`

Each branch forks from `main` at clone time. All task commits land on the branch sequentially. When the runner finishes, it pushes its branch to the remote.

---

## Lifecycle

### 1. Analyze

When `steroids runners start --parallel` is invoked:

1. Load all sections and their dependencies
2. Validate: topological sort, abort on cycles
3. Partition into workstreams (connected components)
4. Skip workstreams with no pending tasks
5. Respect `--max N` limit
6. If `--dry-run`, print the plan and exit

### 2. Clone

For each workstream:

1. Create workspace: `~/.steroids/workspaces/<project-hash>/ws-<id>/`
2. Clone:
   - **Same filesystem:** `git clone --local <project-path> <workspace-path>` (hardlinked objects)
   - **Cross-filesystem:** `git clone <project-path> <workspace-path>` (full copy). Detected via `fs.statfs()` comparing `f_fsid`.
3. `git checkout -b steroids/ws-<id>`
4. Symlink `.steroids/`: since `.steroids/` is gitignored, the clone won't have it. Simply create the symlink: `ln -s <original>/.steroids <clone>/.steroids`. If it exists (non-gitignored edge case), remove it first. Resolve the original path via `realpath()` to avoid symlink chains.
5. Verify symlink: confirm the database is readable

### 3. Execute

Each clone spawns a **regular runner** — the same runner used in sequential mode. The only differences:

- **Scoped to its workstream sections** (processes them in dependency order)
- **Commits to its branch** (not `main`)
- **Pushes its branch** to remote when all sections are done

The runner inherits config, environment variables, API keys. It acquires task locks, runs the coder/reviewer loop, handles rejections and disputes — exactly like today.

```
Runner in ws-def456 (Section B):
  ├── Select next pending task in Section B
  ├── Acquire task lock (shared DB)
  ├── Coder phase → commit to steroids/ws-def456
  ├── Reviewer phase
  ├── On approval: mark completed, next task
  ├── On rejection: cycle as usual
  └── All done → git push origin steroids/ws-def456
```

**Multi-section workstreams** (e.g., C→A→D): the runner receives the ordered list `[C, A, D]` and processes all tasks in C, then A, then D — all on the same branch.

#### Runner Parameterization

Existing `DaemonOptions` and `TaskSelectionOptions` need extensions:

- `sectionIds: string[]` — ordered list of sections (replaces single `sectionId`)
- `branchName: string` — push target (replaces hardcoded `main`)
- `parallelSessionId: string` — links runner to its parallel session

The task selector advances through `sectionIds` in order: process all tasks in `sectionIds[0]`, then `sectionIds[1]`, etc. Each section is fully completed before the next begins.

#### Completion Detection

When a runner finishes all its sections:

1. Push its branch: `git push origin steroids/ws-<id>`
2. Update its workstream status to `completed` in the database
3. Check: are ALL workstreams in this parallel session `completed` (or `failed`)?
4. If yes → this runner transitions into the merge phase (acquires merge lock)
5. If no → runner exits. Another runner will trigger merge when it finishes last.

The last runner to finish becomes the merge executor. Race condition is prevented by the merge lock — if two runners finish simultaneously and both try to merge, only one acquires the lock. The other sees the lock is held and exits.

`steroids merge` exists as a manual fallback if no runner triggers the merge (e.g., all runners crashed after pushing their branches).

### 4. Merge (Cherry-Pick)

The merge runs in the **original project directory** (not in any clone). It is triggered either by the last runner to finish (automatic) or by `steroids merge` (manual fallback).

**Merge ordering:** Workstreams are cherry-picked in the order they completed (first-finished, first-merged). This is deterministic and natural — earlier-finishing workstreams tend to be smaller with fewer potential conflicts.

1. Acquire the **merge lock** (only one process cherry-picks at a time)
2. **Verify clean working tree:** `git status --porcelain` must be empty. If dirty, check if a cherry-pick is in progress (`.git/CHERRY_PICK_HEAD` exists) and resume via crash recovery. If unrelated changes exist, abort: "Commit or stash changes before merging."
3. Fetch workstream branches: `git fetch origin steroids/ws-<id>` for each completed workstream
4. Ensure `main` is up to date: `git pull --ff-only`. If this fails (local commits exist), abort with guidance to `git pull --rebase` first. If remote is ahead, the pull succeeds normally.
5. For each completed workstream branch, in completion order:
   a. List commits: `git log main..origin/steroids/ws-<id> --format=%H --reverse`
   b. If no commits → skip (workstream produced no work). Log and continue.
   c. Cherry-pick each commit onto `main`: `git cherry-pick <sha>`
   d. If cherry-pick succeeds → record in merge progress, continue
   e. If cherry-pick conflicts → **resolve inline** (see below)
6. After all commits from all branches are cherry-picked:
   a. `git push origin main`
   b. Enumerate and delete remote branches individually (tolerate already-deleted)
   c. Clean up workspace clones

**Note on "independent sections":** Independent sections have no *logical* dependency, but they may touch shared files (configs, schemas, lock files). Cherry-pick conflicts between independent sections are expected and handled — the conflict-as-task mechanism exists precisely for this.

#### Why Cherry-Pick?

- **Linear history** on `main` — no merge commits, no branch topology
- **Granular conflict resolution** — per commit, not per branch. If commit 5 of 7 conflicts, commits 1-4 are already on `main`
- **Partial adoption** — can cherry-pick some commits and defer others
- **Each commit stands alone** — reviewable, revertible, bisectable

#### Merge-Conflict Resolution (Inline)

When a cherry-pick conflicts, the merge process resolves it inline — in the same process, in the original project directory. No abort, no separate runner.

1. The cherry-pick leaves conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`) in the working tree
2. Capture context:
   - Conflicted files: `git diff --name-only --diff-filter=U`
   - Original commit's clean patch (intent): `git show <sha>` (NOT `git diff HEAD`, which includes conflict markers)
   - Original commit message
3. Create a merge-conflict task in the database:
   - **Title:** `Merge conflict: cherry-pick <short-sha> from <branch>`
   - **Section:** auto-created "merge-conflicts" section
   - **Source:** conflicted file list, original patch, commit message
4. Run the coder/reviewer loop **inline** (same process, same directory, on `main`):
   - The coder receives the conflicted files with markers and the original commit's intent
   - The coder edits files to resolve ALL conflict markers and runs `git add <resolved-files>`
   - **The coder does NOT commit.** The cherry-pick remains in progress across retries.
5. The reviewer reviews the **staged diff** (`git diff --cached`), not a commit
6. On rejection → coder re-edits and re-stages. Loop back to step 5.
7. On approval → the merge process runs `git -c core.editor=true cherry-pick --continue` to finalize the commit (the `-c core.editor=true` prevents an interactive editor in headless mode)
8. Merge progress updated, continue with next cherry-pick

**This differs from the normal coder/reviewer loop:** normally the coder commits and the reviewer reviews the commit. Here, the coder only stages. The commit is created by `cherry-pick --continue` after reviewer approval. This preserves the original commit's authorship and message.

**This is the key simplification:** conflicts are not a special failure mode. They're tasks resolved by the same coder/reviewer loop that handles all other work.

#### Merge Progress Tracking

The merge process persists its progress in the `merge_progress` table (project DB):

```
session_id | workstream_id | position | commit_sha | status
-----------+---------------+----------+------------+--------
sess-001   | ws-abc123     | 0        | a1b2c3d    | applied
sess-001   | ws-abc123     | 1        | d4e5f6g    | applied
sess-001   | ws-def456     | 0        | h7i8j9k    | conflict  (task pending)
```

On crash and restart, `steroids merge` reads this table and resumes from the next position after the last applied commit. The `position` column makes recovery fully local — no need to re-derive ordering from remote refs. If a conflict task is pending and `.git/CHERRY_PICK_HEAD` exists, the coder/reviewer loop resumes for that conflict.

#### Merge Lock

Only one process can cherry-pick onto `main` at a time. The lock is acquired before cherry-picking starts and released after the push.

Implementation: `merge_locks` table in the project database with expiry and heartbeat (same pattern as task locks). Long timeout (2 hours) with periodic heartbeat updates during conflict resolution. If the merge process crashes, the lock's heartbeat goes stale. `steroids merge` (or the wakeup cron) checks for stale locks (heartbeat older than `staleTimeout`), reclaims them, and resumes from `merge_progress`.

### 5. Cleanup

After successful cherry-pick + push:

1. Push `main` to remote
2. Delete remote branches (tolerate already-deleted errors): enumerate via `git for-each-ref`, delete each individually
3. Delete workspace clones: `rm -rf ~/.steroids/workspaces/<project-hash>/ws-*`
4. Prune stale remote-tracking refs: `git remote prune origin`
5. Log summary: workstreams processed, wall-clock time, conflicts encountered

Each step is idempotent. `steroids workspaces clean` retries any incomplete cleanup.

**Clone preservation:** Until all commits are cherry-picked and pushed, workspace clones must not be deleted — they're the only location of completed work. Cleanup only runs after a successful push.

---

## Configuration

```yaml
runners:
  parallel:
    enabled: false                    # opt-in
    maxClones: 3                      # max simultaneous workstreams
    workspaceRoot: ~/.steroids/workspaces
    cleanupOnSuccess: true            # delete clones after successful merge + push
    cleanupOnFailure: false           # keep failed clones for debugging

  # existing settings unchanged
  maxConcurrent: 1                    # sequential mode only — ignored during parallel
  heartbeatInterval: 30s
  staleTimeout: 5m
```

`--max N` on CLI overrides `parallel.maxClones`.

**`maxConcurrent` vs `maxClones`:** `maxConcurrent` applies only to sequential mode (one runner per project). In parallel mode, `maxClones` controls the number of simultaneous workstreams. The per-project "one runner" constraint is lifted for runners that belong to a parallel session.

### Cost Controls

Parallel runners multiply API costs linearly:

- `maxClones` caps the multiplier
- Existing credit exhaustion detection pauses individual runners
- Default `maxClones: 3` keeps costs manageable

---

## CLI Interface

```bash
# Start parallel runners
steroids runners start --parallel

# Limit parallelism
steroids runners start --parallel --max 2

# Dry run: show workstreams, then exit
steroids runners start --parallel --dry-run

# See all runners including clones
steroids runners list
# ID        STATUS    PID    PROJECT              SECTION       BRANCH
# a47dd5a7  running   61623  /path/to/project     Section C     steroids/ws-abc123
# b945449a  running   28681  /path/to/project     Section B     steroids/ws-def456

# Trigger merge (usually automatic, manual fallback)
steroids merge

# Check workspace status
steroids workspaces list

# Clean up workspaces
steroids workspaces clean
steroids workspaces clean --all

# Stop all parallel runners
steroids runners stop --all
```

---

## Database Schema

### Project DB (`.steroids/steroids.db`) — New Tables

| Table | Columns | Purpose |
|-------|---------|---------|
| `merge_locks` | `id`, `session_id`, `runner_id`, `acquired_at`, `expires_at`, `heartbeat_at` | Prevents concurrent merge operations |
| `merge_progress` | `id` (auto), `session_id`, `workstream_id`, `position`, `commit_sha`, `status` (applied/conflict/skipped), `conflict_task_id`, `created_at`, `applied_at` | Tracks cherry-pick state for crash recovery |

### Global DB (`~/.steroids/steroids.db`) — New Tables

| Table | Columns | Purpose |
|-------|---------|---------|
| `parallel_sessions` | `id`, `project_path`, `status` (running/merging/completed/failed), `created_at`, `completed_at` | Tracks parallel execution sessions |
| `workstreams` | `id`, `session_id` (FK), `branch_name`, `section_ids` (JSON array), `clone_path`, `status` (running/completed/failed), `runner_id`, `completed_at` | Tracks each workstream within a session |

### Modified Tables

**`runners`** (Global DB): add `parallel_session_id TEXT REFERENCES parallel_sessions(id)`. Clone runners use the **original project path** in `runners.project_path` (so project-level queries work). The clone's actual filesystem path is stored in `workstreams.clone_path`. The per-project "one runner" check skips runners with non-null `parallel_session_id`. The wakeup cron skips projects with an active parallel session.

---

## Failure Modes

### Clone Fails

- Same filesystem: `git clone --local` fails → log error, skip workstream
- Cross-filesystem: automatic fallback to `git clone` without `--local`
- Disk full: skip workstream, continue with remaining clones
- Skipped workstreams' tasks remain pending for later sequential processing

### Runner Crashes

- Task locks expire after timeout (existing behavior)
- Workspace clone persists
- Partially completed tasks are visible in the shared database
- The runner can be restarted in the same clone (branch and commits still exist)

### Cherry-Pick Conflict

Not a failure — it's a task. See **Merge-Conflict Tasks** above. The coder/reviewer loop resolves it automatically.

### Credit Exhaustion

- Affected runner pauses (existing behavior)
- Other runners continue
- Paused runners simply take longer to complete

### Network Failure During Push

- Push fails → retry. All work is local, nothing is lost.
- `steroids merge --retry-push` to retry just the push.

---

## Shared State & SQLite Contention

| Resource | Strategy | Contention |
|----------|----------|------------|
| Project DB (`.steroids/`) | Symlinked directory | Medium |
| Global DB (`~/.steroids/`) | Direct access | Low |
| Git objects | Hardlinked via `--local` | None |
| Working tree / Config | Isolated per clone / Read-only | None |
| API credits | Shared pool | High (N× burn rate) |

WAL mode handles 3-5 runners well: ~10 heartbeat writes/minute, each <1ms, `busy_timeout = 5000ms`. Stagger heartbeats by `(spawnOrder * 5)` seconds. Beyond ~10 runners, SQLite becomes a bottleneck. Phase 1 caps at `maxClones: 3`.

---

## Constraints

### Phase 1 Scope

- No PR creation — cherry-pick directly onto `main`
- Local clones only — no cross-machine parallelism
- No partial section parallelism — a section runs entirely in one clone
- Dependency chains are sequential (one workstream, no chain-internal parallelism)

### Throughput Expectations

Not a guaranteed N× speedup. Only truly independent sections parallelize; cherry-pick + conflict resolution adds time; API rate limits may throttle. **Realistic:** 2-4× on projects with 3+ independent sections.

### Disk Space

Full clones with hardlinked objects: mostly working tree overhead. 500MB project × 5 clones ≈ 2.5GB. `cleanupOnSuccess: true` reclaims space after merge.

---

## Design Decisions

### 1. Regular Runners, Not Parent/Child

Each clone runs the same runner used in sequential mode. No special "parent" or "child" runner types. The only difference is scope (which sections) and branch (not `main`). This means zero new runner infrastructure — just parameterization.

### 2. Cherry-Pick, Not Merge

Cherry-pick gives linear history, per-commit conflict resolution, and partial adoption. Merge commits add noise and surface conflicts at branch granularity (harder to resolve). Cherry-pick is `git merge` at commit granularity — simpler and more precise.

### 3. Conflicts Are Tasks, Not Failures

The existing coder/reviewer loop already resolves code problems. A merge conflict is just another code problem. Creating a task for it means:
- No human intervention needed
- Same quality gates (reviewer reviews the resolution)
- Same audit trail
- Same rejection/retry loop if the resolution is bad

### 4. Full Clones, Not Worktrees

Worktrees share git internals (index locks, HEAD locks, ref locks). Parallel operations deadlock. Full clones are fully isolated. `git clone --local` hardlinks objects, so disk overhead is just the working tree — same as worktrees.

### 5. Lightweight Progress, Not a State Machine

The old design had 11 merge states, recovery commands (`--continue`, `--retry`, `--abort`), rollback logic, and metadata.json tracking. Cherry-pick + conflict-as-task eliminates most of this. What remains is a simple `merge_progress` table that tracks which commits have been applied — enough for crash recovery without the complexity of a full state machine. On restart, `steroids merge` reads the table and picks up where it left off.

---

## Implementation Checklist

### New Files
- `src/parallel/scheduler.ts` — workstream partitioning (topological sort, connected components, cycle detection)
- `src/parallel/clone.ts` — workspace clone creation, symlink setup, cross-filesystem detection
- `src/parallel/merge.ts` — cherry-pick loop, conflict-as-task creation, merge progress tracking
- `src/commands/merge.ts` — `steroids merge` CLI command
- `src/commands/workspaces.ts` — `steroids workspaces list/clean` CLI commands
- `src/prompts/merge-conflict.ts` — coder prompt variant for conflict resolution. Key constraints: coder must NOT commit (only `git add`), must NOT run `cherry-pick --continue`, must fully remove all conflict markers. Reviewer reviews staged diff, not a commit.

### Modified Files
- `src/commands/runners.ts` — add `--parallel`, `--max`, `--dry-run` flags
- `src/orchestrator/task-selector.ts` — accept `sectionIds: string[]` (ordered list). Multi-section advancement logic lives in the orchestrator loop wrapper, not in `findNextTask` itself (preserves existing single-section behavior)
- `src/runners/global-db.ts` — add `parallel_sessions`, `workstreams` tables, `parallel_session_id` column on `runners`
- `src/database/schema.ts` — add `merge_locks`, `merge_progress` tables
- `src/git/push.ts` — parameterize branch name (already accepts `branch` param, needs wiring)
- `src/commands/loop.ts` / `loop-phases.ts` — pass `branchName` and `sectionIds` through to orchestrator
- `src/runners/wakeup.ts` — skip projects with active parallel sessions
- `src/runners/daemon.ts` — update `hasActiveRunnerForProject()` to exclude runners with non-null `parallel_session_id`; update `canStartRunner()` to skip singleton check for parallel runners

### Migrations
- Project DB: `merge_locks` table, `merge_progress` table
- Global DB: `parallel_sessions` table, `workstreams` table, `runners.parallel_session_id` column

---

## Related Documentation

- [RUNNERS.md](./cli/RUNNERS.md) — Current runner architecture
- [GIT-WORKFLOW.md](./cli/GIT-WORKFLOW.md) — Current git operations
- [LOCKING.md](./cli/LOCKING.md) — Task and section locking
- [ROADMAP.md](./ROADMAP.md) — Feature roadmap
