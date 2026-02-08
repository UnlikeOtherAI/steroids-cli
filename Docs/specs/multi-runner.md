# Multi-Runner Concurrency

> Safely running multiple runners in the same repository for monorepo workflows.

## Problem Statement

In monorepo projects, different teams or components (API, mobile app, web frontend) could benefit from parallel development. Currently, Steroids allows only one runner per project to avoid conflicts. This spec explores how to safely enable multiple concurrent runners.

## Use Cases

1. **Monorepo with isolated components**
   - `/api` - Backend team
   - `/mobile` - Mobile team
   - `/web` - Frontend team

2. **Parallel feature development**
   - Runner A: Working on authentication section
   - Runner B: Working on reporting section

3. **Accelerated single-section work**
   - Multiple coders on independent tasks within the same section

## Conflict Categories

### 1. File Conflicts (CRITICAL)

Two coders editing the same file simultaneously.

**Risk Level:** High - Can corrupt code or create merge conflicts.

**Scenarios:**
- Both tasks modify `src/utils/helpers.ts`
- One task adds a function, another removes it
- Shared config files (`package.json`, `tsconfig.json`)

**Mitigation Strategies:**

| Strategy | Description | Tradeoff |
|----------|-------------|----------|
| **File-level locking** | Lock files being edited | Reduces parallelism |
| **Directory isolation** | Each runner owns a directory subtree | Requires strict boundaries |
| **Optimistic concurrency** | Detect conflicts at commit time | May waste coder work |
| **Task dependency graph** | Only parallelize truly independent tasks | Complex to compute |

### 2. Git Conflicts (CRITICAL)

Concurrent commits and pushes to the same branch.

**Risk Level:** High - Push failures, lost work, diverged history.

**Scenarios:**
- Runner A pushes while Runner B is mid-commit
- Both runners commit changes to same file
- Rebase/merge conflicts

**Mitigation Strategies:**

| Strategy | Description | Tradeoff |
|----------|-------------|----------|
| **Serial git operations** | Global lock for all git ops | Bottleneck |
| **Branch per runner** | Each runner works on own branch | Merge complexity |
| **Branch per task** | Isolate at task level | Many branches to manage |
| **Atomic push with retry** | Retry on conflict with rebase | May fail repeatedly |

### 3. Task Conflicts (MODERATE)

Two runners picking the same task.

**Risk Level:** Moderate - Already mitigated by task locking.

**Current Solution:** Task lock table prevents duplicate pickup.

**Enhancement Needed:** Ensure lock checks are atomic under high concurrency.

### 4. Database Conflicts (MODERATE)

SQLite concurrent write access.

**Risk Level:** Moderate - SQLite handles this but can cause delays.

**Scenarios:**
- Simultaneous status updates
- Heartbeat writes from multiple runners
- Lock table contention

**Mitigation Strategies:**

| Strategy | Description | Tradeoff |
|----------|-------------|----------|
| **WAL mode** | Already enabled, allows concurrent reads | Write serialization |
| **Retry with backoff** | Retry on SQLITE_BUSY | Latency spikes |
| **Separate databases** | Per-runner state files | Coordination complexity |

### 5. Build/Test Conflicts (HIGH)

Shared build artifacts, compilation state, and test resources.

**Risk Level:** HIGH - Can cause false failures, corrupt builds, or inconsistent state.

**Scenarios:**

| Scenario | What Happens | Impact |
|----------|--------------|--------|
| **Partial build artifacts** | Runner A compiles half the files, Runner B runs tests | Tests fail on incomplete build |
| **Shared node_modules** | Both runners run `npm install` simultaneously | Corrupted dependencies, missing packages |
| **Lock file conflicts** | Both modify `package-lock.json` or `yarn.lock` | Merge conflicts, inconsistent deps |
| **TypeScript incremental** | `.tsbuildinfo` written by both runners | Corrupt incremental state, phantom errors |
| **Build cache collision** | Shared `dist/`, `.next/`, `build/` directories | Overwritten files, stale artifacts |
| **Test database** | Both runners seed/migrate test DB | Data corruption, flaky tests |
| **Port conflicts** | Both start dev servers on same port | One fails to bind |
| **Shared temp files** | Both write to `/tmp/myapp-*` | Overwritten state |

**Detailed Example - The Half-Build Problem:**

```
Timeline:
  T0: Runner A starts building API (npm run build)
  T1: Runner A compiles src/index.ts -> dist/index.js
  T2: Runner B finishes its task, runs tests (npm test)
  T3: Tests import dist/utils.js - NOT YET COMPILED
  T4: Tests FAIL - "Cannot find module dist/utils.js"
  T5: Runner A finishes build - but B already reported failure
```

This causes:
- False negatives (tests fail when code is fine)
- Wasted coder cycles fixing non-bugs
- Flaky CI that erodes trust

**Mitigation Strategies:**

| Strategy | Description | Tradeoff |
|----------|-------------|----------|
| **Isolated workdirs** | Git worktrees per runner, separate `node_modules` | Disk space (2-10GB per runner) |
| **Build locks** | Global lock during build/test phases | Serializes work, reduces parallelism |
| **Container isolation** | Each runner in Docker with own filesystem | Resource heavy, slower startup |
| **Monorepo tooling** | Use Nx/Turborepo with proper caching | Requires tooling adoption |
| **Output namespacing** | `dist-runner-1/`, `dist-runner-2/` | Config complexity |
| **Atomic build-test** | Lock held from build start through test end | Long lock duration |

**Recommended Approach for Monorepos:**

Use **component-level isolation** where each monorepo package has independent build:

```
my-monorepo/
├── packages/
│   ├── api/
│   │   ├── node_modules/    <- Independent
│   │   ├── dist/            <- Independent
│   │   └── package.json
│   ├── mobile/
│   │   ├── node_modules/    <- Independent
│   │   ├── build/           <- Independent
│   │   └── package.json
│   └── shared/
│       ├── node_modules/    <- Shared, needs locking
│       └── dist/            <- Shared, needs locking
```

**Rules:**
1. Runner in `api` zone only builds/tests `packages/api`
2. Runner in `mobile` zone only builds/tests `packages/mobile`
3. Changes to `shared` require exclusive lock (all runners pause)
4. Each package manages its own `node_modules` (npm workspaces or independent)

**Build Lock Protocol:**

```typescript
async function safeBuildAndTest(runner: Runner, task: Task): Promise<void> {
  // 1. Acquire build lock for affected packages
  const packages = getAffectedPackages(task);
  const locks = await acquireBuildLocks(packages);

  try {
    // 2. Install dependencies (if needed)
    await npmInstall(packages);

    // 3. Build
    await build(packages);

    // 4. Test
    await test(packages);

  } finally {
    // 5. Release locks
    await releaseBuildLocks(locks);
  }
}
```

**Database Isolation for Tests:**

```yaml
# Config per runner
test:
  database:
    strategy: isolated  # Options: isolated, shared, none
    prefix: runner-${RUNNER_ID}  # Creates test_runner_abc123 DB
```

## Proposed Architecture

### Option A: Directory Isolation (Recommended for Monorepos)

```
my-monorepo/
├── api/           <- Runner 1 owns this
├── mobile/        <- Runner 2 owns this
├── web/           <- Runner 3 owns this
└── shared/        <- Locked, requires coordination
```

**Configuration:**
```yaml
# .steroids/config.yaml
runners:
  isolation: directory
  zones:
    - name: api
      paths: ["api/**", "shared/api-types/**"]
      maxRunners: 1
    - name: mobile
      paths: ["mobile/**", "shared/mobile-types/**"]
      maxRunners: 1
    - name: web
      paths: ["web/**"]
      maxRunners: 1
    - name: shared
      paths: ["shared/**"]
      maxRunners: 1
      exclusive: true  # Only one runner in entire project when touching shared
```

**How it works:**
1. Each task is tagged with affected paths (explicit or inferred)
2. Runner claims a zone, only picks tasks in that zone
3. If task touches multiple zones, it requires coordination lock
4. `shared` zone is exclusive - blocks all other runners

**Pros:**
- Clear boundaries
- Low conflict risk
- Maps well to team structure

**Cons:**
- Cross-cutting tasks need special handling
- May underutilize capacity

### Option B: Branch Isolation

Each runner works on its own branch, merged by orchestrator.

```
main
├── runner-1/task-abc123
├── runner-2/task-def456
└── runner-3/task-ghi789
```

**How it works:**
1. Runner creates branch from main before starting task
2. All work happens on branch
3. On approval, orchestrator merges to main
4. Conflict resolution is explicit merge step

**Pros:**
- Git handles isolation naturally
- Can work on same files (merge resolves)
- Clear audit trail

**Cons:**
- Merge conflicts may require human intervention
- Branch proliferation
- CI/CD complexity

### Option C: Task Dependency Graph

Analyze tasks for file dependencies, only parallelize when safe.

```
Task A (modifies: api/routes.ts)     ─┬─> Can run in parallel
Task B (modifies: mobile/screens.ts) ─┘

Task C (modifies: shared/types.ts) ──> Must run alone
Task D (modifies: shared/types.ts) ──> Blocked by Task C
```

**How it works:**
1. Before task starts, analyze spec for affected files
2. Build conflict graph
3. Scheduler only dispatches non-conflicting tasks
4. Dynamic: as tasks complete, graph updates

**Pros:**
- Maximum parallelism
- No manual zone configuration
- Adapts to task content

**Cons:**
- Requires accurate file prediction
- Complex implementation
- Coder may touch unexpected files

## Implementation Phases

### Phase 1: Section-Based Isolation (Simple)

Use existing `--section` flag as isolation boundary.

**Rule:** Only one runner per section. Different sections can run in parallel.

```bash
steroids runners start --section "API" --detach
steroids runners start --section "Mobile" --detach
```

**Safeguards:**
- Reject runner start if section already has active runner
- Tasks must be strictly assigned to sections
- Cross-section tasks go to a "shared" section (serial)

**Implementation:**
- Add `hasActiveRunnerForSection(sectionId)` check
- Enforce one-runner-per-section at start time
- No file-level analysis needed

### Phase 2: Directory Zones (Moderate)

Add zone configuration for fine-grained control.

**New config:**
```yaml
runners:
  zones:
    api:
      paths: ["api/**"]
      sections: ["API Phase 1", "API Phase 2"]
```

**Implementation:**
- Zone config in schema
- Path matching at task pickup
- Zone locks in global database

### Phase 3: Smart Scheduling (Advanced)

Automatic conflict detection and scheduling.

**Implementation:**
- File impact analysis from task specs
- Conflict graph computation
- Dynamic scheduler with backpressure

## Safety Mechanisms

### 1. Pre-flight Check

Before coder starts, verify no conflicts:

```typescript
async function canStartTask(task: Task, runner: Runner): Promise<boolean> {
  // Check section isolation
  if (runner.sectionId && task.sectionId !== runner.sectionId) {
    return false;
  }

  // Check zone isolation
  const taskZone = getZoneForPaths(task.affectedPaths);
  if (taskZone !== runner.zone) {
    return false;
  }

  // Check file locks
  const lockedFiles = getLockedFiles();
  if (task.affectedPaths.some(p => lockedFiles.includes(p))) {
    return false;
  }

  return true;
}
```

### 2. File Locking (Optional Enhancement)

Track which files are being edited:

```sql
CREATE TABLE file_locks (
  path TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  locked_at TEXT NOT NULL
);
```

### 3. Git Coordination

Serialize git operations with advisory lock:

```typescript
async function withGitLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = await acquireGitLock();
  try {
    return await fn();
  } finally {
    await releaseLock(lock);
  }
}
```

### 4. Conflict Detection at Review

Reviewer checks for conflicts before approval:

```typescript
async function preApprovalCheck(task: Task): Promise<ConflictResult> {
  // Check if main has diverged
  const mainHead = await git.getMainHead();
  if (mainHead !== task.baseCommit) {
    // Attempt rebase
    const canRebase = await git.tryRebase(task.branch, 'main');
    if (!canRebase) {
      return { conflict: true, reason: 'Merge conflict with main' };
    }
  }
  return { conflict: false };
}
```

## Open Questions

1. **How to handle shared dependencies?**
   - `package.json` changes from multiple runners
   - Database migrations from parallel tasks
   - Shared type definitions

2. **What happens when a coder goes outside its zone?**
   - Fail the task?
   - Warn and continue?
   - Auto-reassign to correct runner?

3. **How to handle review of cross-zone changes?**
   - Single reviewer for all?
   - Zone-specific reviewers?

4. **Recovery from conflicts?**
   - Automatic rollback?
   - Human intervention queue?
   - Dispute mechanism?

5. **Performance vs Safety tradeoff?**
   - Aggressive parallelism with conflict handling?
   - Conservative isolation with guaranteed safety?

## Recommendation

**Start with Phase 1 (Section-Based Isolation)** because:

1. Already partially implemented (`--section` flag exists)
2. Low risk - sections are natural isolation boundaries
3. No new infrastructure needed
4. Good fit for monorepo team structure

**Rules for Phase 1:**
- One runner per section (enforced)
- Sections map to directories/components
- "Shared" section runs exclusively
- Git operations serialized globally

This gives 80% of the benefit with 20% of the complexity. Phase 2 and 3 can be added based on real-world feedback.

## Related Specs

- [Section Focus](./section-focus.md) - `--section` flag implementation
- [Section Skip](./section-skip.md) - Excluding sections from work
- [Locking System](./locking.md) - Task and section locks

## Discussion Notes

*Add discussion points and decisions here as the spec evolves.*
