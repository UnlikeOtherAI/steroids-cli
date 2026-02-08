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

## Project Structure Discovery

Before enabling multi-runner, help the user define their monorepo structure. LLM analyzes the codebase and suggests component boundaries.

### The Setup Flow

```bash
$ steroids init --monorepo

Analyzing project structure...

📁 Detected Monorepo Structure:
┌─────────────────────────────────────────────────────────────────┐
│                                                                 │
│  /apps                                                          │
│  ├── api/              → Backend API (Node.js/Express)          │
│  ├── admin/            → Admin Dashboard (React)                │
│  ├── web/              → Landing Page (Next.js)                 │
│  └── mobile/           → Mobile App (React Native)              │
│                                                                 │
│  /packages                                                      │
│  ├── shared-types/     → TypeScript types (SHARED)              │
│  ├── ui-components/    → Component library (SHARED)             │
│  └── utils/            → Utility functions (SHARED)             │
│                                                                 │
│  /infrastructure                                                │
│  └── terraform/        → Infrastructure as Code                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘

🔗 Detected Dependencies:
  • api         → shared-types, utils
  • admin       → shared-types, ui-components, utils
  • web         → shared-types, ui-components
  • mobile      → shared-types, ui-components

⚠️  Shared Packages:
  Changes to shared-types, ui-components, or utils affect multiple apps.
  Recommend: Run these tasks with exclusive lock.

Create sections from this structure? [Y/n]
```

### Auto-Generated Sections

Based on the analysis, Steroids creates sections:

```bash
$ steroids sections list

SECTIONS
──────────────────────────────────────────────────────────────────
ID        NAME                    PATH              ISOLATED  TASKS
──────────────────────────────────────────────────────────────────
a1b2c3d4  API                     apps/api/**       ✓         0
e5f6g7h8  Admin Dashboard         apps/admin/**     ✓         0
i9j0k1l2  Landing Page            apps/web/**       ✓         0
m3n4o5p6  Mobile App              apps/mobile/**    ✓         0
q7r8s9t0  Shared Types            packages/shared-* ⚠ EXCL    0
u1v2w3x4  UI Components           packages/ui-*     ⚠ EXCL    0
y5z6a7b8  Infrastructure          infrastructure/** ✓         0
```

- **ISOLATED (✓):** Can run in parallel with other isolated sections
- **EXCLUSIVE (⚠):** When active, no other runners can run

### How LLM Discovers Structure

**Input to analyzer:**
```typescript
interface ProjectAnalysisInput {
  directoryTree: string;           // Output of `tree` or `find`
  packageJsons: PackageJson[];     // All package.json files found
  workspaceConfig?: string;        // npm/yarn/pnpm workspace config
  tsConfigs?: string[];            // TypeScript configs (show references)
  dockerfiles?: string[];          // Dockerfile locations
  readmes?: string[];              // README content for context
}
```

**Analyzer prompt:**
```
Analyze this monorepo structure and identify:

1. COMPONENTS: Independent applications that could be developed in parallel
   - Look for: apps/, packages/, services/, modules/ directories
   - Look for: separate package.json files
   - Look for: Docker containers, deployment configs

2. SHARED CODE: Packages/modules used by multiple components
   - Look for: packages/shared*, packages/common*, libs/
   - Check package.json dependencies for internal references
   - TypeScript project references

3. DEPENDENCY GRAPH: Which components depend on which shared code
   - Parse package.json dependencies
   - Check import statements in entry files
   - TypeScript references

4. BOUNDARIES: Suggest isolation boundaries for parallel development
   - Components with no shared dependencies → fully parallel
   - Components sharing code → need coordination
   - Shared packages → exclusive access recommended

Output as JSON:
{
  "components": [
    {
      "name": "API",
      "path": "apps/api",
      "type": "backend",
      "framework": "express",
      "dependencies": ["shared-types", "utils"],
      "canRunParallel": true
    }
  ],
  "sharedPackages": [
    {
      "name": "shared-types",
      "path": "packages/shared-types",
      "usedBy": ["api", "admin", "web", "mobile"],
      "exclusive": true
    }
  ],
  "dependencyGraph": { ... },
  "suggestedSections": [ ... ]
}
```

### Task Assignment

When adding tasks, LLM suggests the appropriate section based on the spec:

```bash
$ steroids tasks add "Add user authentication endpoint" --auto-section

Analyzing task specification...

📍 Suggested Section: API
   Reason: Task mentions "endpoint", likely modifies apps/api/

   Files likely affected:
   • apps/api/src/routes/auth.ts
   • apps/api/src/middleware/auth.ts
   • packages/shared-types/src/user.ts (SHARED!)

   ⚠️  This task touches shared-types, which affects:
   • Admin Dashboard
   • Mobile App

   Options:
   [1] Add to API section (run when shared-types is free)
   [2] Add to Shared Types section (exclusive)
   [3] Specify section manually

   Choice [1]:
```

### Structure Configuration File

Store the discovered structure in `.steroids/structure.yaml`:

```yaml
# .steroids/structure.yaml
# Auto-generated by `steroids init --monorepo`
# Edit to customize component boundaries

version: 1
type: monorepo

components:
  - name: API
    paths:
      - apps/api/**
    dependencies:
      - shared-types
      - utils
    isolation: parallel

  - name: Admin Dashboard
    paths:
      - apps/admin/**
    dependencies:
      - shared-types
      - ui-components
      - utils
    isolation: parallel

  - name: Mobile App
    paths:
      - apps/mobile/**
    dependencies:
      - shared-types
      - ui-components
    isolation: parallel

shared:
  - name: shared-types
    paths:
      - packages/shared-types/**
    usedBy: [API, Admin Dashboard, Landing Page, Mobile App]
    isolation: exclusive

  - name: ui-components
    paths:
      - packages/ui-components/**
    usedBy: [Admin Dashboard, Landing Page, Mobile App]
    isolation: exclusive

# Rules for task auto-assignment
taskRouting:
  patterns:
    - match: "endpoint|route|API|backend"
      section: API
    - match: "admin|dashboard|backoffice"
      section: Admin Dashboard
    - match: "mobile|iOS|Android|React Native"
      section: Mobile App
    - match: "landing|marketing|SEO"
      section: Landing Page
    - match: "type|interface|schema"
      section: shared-types
```

### Re-analyze Command

As the project evolves, re-run analysis:

```bash
$ steroids structure analyze

Comparing current structure to .steroids/structure.yaml...

Changes detected:
  + New directory: apps/docs/  (not mapped to any section)
  + New package: packages/analytics/
  ~ Modified: apps/api/ now depends on packages/analytics/

Suggestions:
  1. Create new section "Documentation" for apps/docs/
  2. Create new section "Analytics" for packages/analytics/ (SHARED)
  3. Update API section dependencies

Apply suggestions? [Y/n]
```

### Why This Matters for Multi-Runner

With a defined structure:

| Without Structure | With Structure |
|-------------------|----------------|
| User guesses which sections are safe | System knows isolation boundaries |
| Conflicts discovered at runtime | Conflicts prevented by design |
| Manual task assignment | Auto-suggested sections |
| Unclear shared dependencies | Explicit shared package rules |

**The key insight:** Monorepos will become more popular with AI-assisted development. By understanding the structure upfront, Steroids can safely parallelize work across components while protecting shared code.

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

### Option D: LLM-Based Conflict Analysis (Recommended)

Use AI to analyze tasks and provide conflict recommendations - advisory, not enforced.

**Philosophy:** Don't hard-block the user. Analyze potential conflicts and surface recommendations. User decides whether to proceed.

```
┌─────────────────────────────────────────────────────────────────┐
│  MULTI-RUNNER ANALYSIS                                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  You want to start runners for:                                 │
│    • Section: API (12 pending tasks)                            │
│    • Section: Mobile (8 pending tasks)                          │
│                                                                 │
│  ⚠️  POTENTIAL CONFLICTS DETECTED                               │
│                                                                 │
│  File Conflicts (2 tasks):                                      │
│    • Task api-auth overlaps with mobile-auth                    │
│      Both modify: shared/types/user.ts                          │
│      Risk: MEDIUM - type changes may conflict                   │
│                                                                 │
│  Build Conflicts:                                               │
│    • Both sections depend on 'shared' package                   │
│      Risk: LOW - if builds are serialized                       │
│      Risk: HIGH - if builds run concurrently                    │
│                                                                 │
│  Recommendations:                                               │
│    1. Run api-auth before starting Mobile runner                │
│    2. Or: Move shared/types tasks to dedicated section          │
│    3. Or: Proceed anyway (conflicts will be caught at review)   │
│                                                                 │
│  [Proceed Anyway]  [Adjust Sections]  [Cancel]                  │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

**How it works:**

1. **User requests multi-runner setup**
   ```bash
   steroids runners analyze --sections "API,Mobile"
   # or
   steroids runners start --section API --analyze-conflicts
   ```

2. **Conflict Analyzer runs** (can use Claude or Codex)
   - Reads task specifications for all pending tasks in requested sections
   - Analyzes file paths mentioned in specs
   - Checks for overlapping dependencies
   - Considers build/test requirements
   - Evaluates timing (which tasks might run concurrently)

3. **LLM produces conflict report**
   ```typescript
   interface ConflictAnalysis {
     canRunInParallel: boolean;  // Overall assessment
     confidence: 'high' | 'medium' | 'low';

     fileConflicts: {
       taskA: string;
       taskB: string;
       files: string[];
       risk: 'high' | 'medium' | 'low';
       reason: string;
     }[];

     buildConflicts: {
       description: string;
       risk: 'high' | 'medium' | 'low';
       mitigation: string;
     }[];

     recommendations: string[];

     safeParallelGroups: string[][];  // Tasks that CAN safely run together
   }
   ```

4. **User reviews and decides**
   - Proceed with all runners
   - Adjust task order/sections
   - Run sequentially instead

**Analyzer Prompt (simplified):**

```
You are analyzing tasks for potential conflicts in a multi-runner setup.

SECTION A TASKS:
${sectionATasks.map(t => t.spec).join('\n---\n')}

SECTION B TASKS:
${sectionBTasks.map(t => t.spec).join('\n---\n')}

PROJECT STRUCTURE:
${directoryTree}

Analyze for:
1. FILE CONFLICTS - Tasks that might modify the same files
2. BUILD CONFLICTS - Shared dependencies, build artifacts, test resources
3. LOGICAL CONFLICTS - Tasks that depend on each other's output
4. TIMING RISKS - What if these tasks run at the exact same time?

For each conflict found, rate risk (high/medium/low) and suggest mitigation.

Provide your analysis as JSON matching this schema:
${conflictAnalysisSchema}
```

**Benefits:**
- No rigid rules - AI understands context
- Catches non-obvious conflicts (e.g., "Task A changes the user model, Task B assumes old model shape")
- User stays in control
- Improves over time with better prompts
- Can run both Claude and Codex for higher confidence

**When to run analysis:**
- `steroids runners start --section X` when another runner is active
- `steroids runners analyze` explicit analysis command
- Optionally: automatically before each task pickup in multi-runner mode

**Analysis cost:**
- One LLM call per analysis request
- Could cache results if tasks haven't changed
- Fast models (Haiku/GPT-4-mini) sufficient for analysis

**Example analysis session:**

```bash
$ steroids runners analyze --sections "API,Mobile,Web"

Analyzing 28 tasks across 3 sections...

✓ API ↔ Mobile: Safe to parallelize (no conflicts detected)
⚠ API ↔ Web: 2 potential conflicts
  • api/middleware/auth.ts used by both
  • shared/config.ts modified by both
✓ Mobile ↔ Web: Safe to parallelize (no conflicts detected)

Recommendation:
  Run API and Mobile in parallel.
  Run Web after API completes (or move web-auth to API section).

Proceed with API + Mobile? [Y/n]
```

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

**Combine Section-Based Isolation with LLM Conflict Analysis:**

### Step 1: Allow multi-section runners (no hard blocks)

Don't prevent the user from starting multiple runners. Instead:
- Warn if potential conflicts detected
- Provide recommendations
- Let user decide

### Step 2: Add `steroids runners analyze` command

Before starting parallel runners, user can run analysis:
```bash
steroids runners analyze --sections "API,Mobile,Web"
```

This invokes LLM to:
1. Read all pending task specs in those sections
2. Identify potential file/build/logic conflicts
3. Output recommendations (not enforcement)

### Step 3: Optional automatic analysis

When starting a second runner while one is active:
```bash
$ steroids runners start --section Mobile --detach

⚠️  Another runner is active (section: API)

Running conflict analysis...
✓ No conflicts detected between API and Mobile sections.

Proceed? [Y/n]
```

**Why this approach:**

| Aspect | Hard Rules | LLM Analysis |
|--------|-----------|--------------|
| Flexibility | Low - rigid zones | High - context-aware |
| False positives | Many - blocks safe work | Few - understands intent |
| User control | Low - system decides | High - user decides |
| Maintenance | High - rules need updates | Low - prompt evolves |
| Cost | Free | ~$0.01-0.05 per analysis |

**Implementation priority:**

1. **Phase 1:** Section isolation + manual multi-runner (user takes responsibility)
2. **Phase 2:** `steroids runners analyze` command with LLM analysis
3. **Phase 3:** Auto-analysis on runner start (optional, configurable)

The key insight: **Don't block, advise.** Users know their codebase better than any rule system. Give them information to make good decisions.

## Related Specs

- [Section Focus](./section-focus.md) - `--section` flag implementation
- [Section Skip](./section-skip.md) - Excluding sections from work
- [Locking System](./locking.md) - Task and section locks

## Discussion Notes

*Add discussion points and decisions here as the spec evolves.*
