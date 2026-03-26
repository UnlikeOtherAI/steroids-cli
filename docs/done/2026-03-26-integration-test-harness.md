# Integration Test Harness: 50-Ticket Full Pipeline Verification

## Problem Statement

The orchestration pipeline (task selection -> coder -> orchestrator parse -> reviewer -> merge) has dozens of edge cases spread across 10+ files. Unit tests cover individual functions, but no test exercises the full pipeline end-to-end with realistic task populations. Bugs in state transitions, retry caps, dependency gating, and decision routing only surface in production when real providers are involved.

We need an integration test that:
1. Creates 50 tickets on a fresh database
2. Runs the full loop pipeline with mock provider responses
3. Verifies every task reaches the correct terminal state
4. Catches regressions in status transitions, retry escalation, and dependency gating

## Current Behavior

- Provider invocations spawn real CLI processes (claude, codex, gemini)
- No way to run the loop without live AI providers
- Edge cases (15-rejection escalation, parse retry caps, credit exhaustion) are only tested in isolated unit tests, never as part of a flowing pipeline

## Desired Behavior

A single test file (`tests/integration-pipeline.test.ts`) that:
- Boots a fresh in-memory SQLite database with the full schema
- Creates 50 tasks across sections with dependencies
- Mocks provider invocations to return scripted responses
- Runs the orchestration loop phases for each task
- Asserts final DB state (task status, rejection counts, audit trail, disputes)
- Runs in ~5 seconds (no real AI calls, no filesystem git operations)

## Design

### Mock Injection Strategy

Mock at the **module boundary** using `jest.unstable_mockModule()`. This is the established pattern in the codebase (see `tests/hook-integration-intake.test.ts`, `tests/wakeup-sanitise-recovery.test.ts`).

**Modules to mock (external I/O boundaries only):**

| Module | Mock Returns | Purpose |
|--------|-------------|---------|
| `../src/orchestrator/coder.js` | `CoderResult` per scenario | Fake coder CLI spawn |
| `../src/orchestrator/reviewer.js` | `ReviewerResult` per scenario + real `getReviewerConfigs` / `resolveDecision` | Fake reviewer CLI spawn while keeping production review policy real |
| `../src/orchestrator/coordinator.js` | `CoordinatorResult` per scenario | Fake coordinator CLI spawn |
| `../src/orchestrator/invoke.js` | Orchestrator parse string | Fake LLM calls for coder/reviewer orchestrator |
| `../src/git/status.js` | Controlled git state | Fake commits, uncommitted changes |
| `../src/git/push.js` | Success/failure | Fake push results |
| `../src/git/submission-durability.js` | null | Fake durable ref filesystem reads |
| `../src/git/submission-resolution.js` | Resolved SHA | Fake git reachability checks |
| `../src/providers/registry.js` | Mock classifyResult | Fake provider availability |
| `../src/runners/global-db.js` | Pass-through global DB helpers + backoff recorders | Keep pause handlers real without touching the real global DB |

**Kept REAL (post-review adoption):**
- `loop-phases-reviewer-resolution.js` -- multi-reviewer consensus, arbitration, fallback logic
- `reviewer-approval-outcome.js` -- deriveApprovedOutcome + applyApprovedOutcome DB transactions
- `merge-queue-completion.js` -- final merge completion and approval-effects bridge
- `automated-approval-effects.js` -- approval replay, hooks, and intake side effects
- `submission-context.js` -- loadSubmissionContext DB reads, isNoOp detection
- `loop-phases-helpers.js` -- retry counters, escalation logic, completion signal detection
- `credit-pause.js` -- real pause/backoff handling before harness-only terminalization
- `OrchestrationFallbackHandler` -- real coder/reviewer output parser
- `queries.ts` -- full state machine, audit trail, rejection counting
- `task-selector.ts` -- real task selection with dependency gating

### Mock Provider Response Scripts

Each of the 50 tasks gets a **scenario ID** (e.g., `happy-simple`, `reject-3x-then-approve`). A `ScenarioScript` maps scenario ID to a sequence of mock responses indexed by invocation number:

```typescript
interface MockCoderResponse {
  stdout: string;       // Coder output (parsed by orchestrator)
  stderr: string;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
  duration: number;
}

interface MockReviewerResponse {
  stdout: string;       // Contains [APPROVE], [REJECT], etc.
  stderr: string;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
  duration: number;
  decision?: string;
}

interface MockOrchestratorResponse {
  output: string;       // "STATUS: REVIEW\nREASON: ...\nCONFIDENCE: HIGH"
}

interface ScenarioStep {
  coder?: MockCoderResponse;
  orchestrator?: MockOrchestratorResponse;         // Coder orchestrator (STATUS/REASON/CONFIDENCE)
  reviewerOrchestrator?: MockOrchestratorResponse;  // Reviewer orchestrator (DECISION/REASONING/CONFIDENCE)
  reviewer?: MockReviewerResponse;
  coordinator?: { success: boolean; decision: string; guidance: string };
}
// NOTE (round 2 fix): reviewer-resolution.js is now REAL. It calls invokeReviewerOrchestrator
// (mocked via invoke.js) and passes the output to parseReviewerOutput(). The
// SignalParser.parseReviewerSignal() looks for DECISION tokens: [APPROVE], [REJECT],
// [DISPUTE], [SKIP], or DECISION: APPROVE/REJECT/etc. The reviewerOrchestrator mock
// must return text containing these tokens for the real parser to route correctly.

type ScenarioScript = ScenarioStep[];
```

The mock functions look up the current task ID -> scenario ID -> invocation count, and return the scripted response for that step. This lets us deterministically control what happens at each cycle.

### Orchestrator Parse Mock

The coder orchestrator (`invokeCoderOrchestrator`) is the LLM that reads coder output and decides submit/retry/error. We mock it to return text that the real `OrchestrationFallbackHandler.parseCoderOutput()` will parse. This exercises the actual parser:

```
For "happy path submit":
"STATUS: REVIEW\nREASON: Task implemented successfully\nCONFIDENCE: HIGH"

For "retry scenario":
"STATUS: RETRY\nREASON: Coder needs another attempt\nCONFIDENCE: MEDIUM"

For "parse failure" (tests fallback logic):
"garbage output that cannot be parsed"
```

### Git State Mock

Git operations are mocked to return consistent state per scenario:

```typescript
const mockGitState: Record<string, {
  currentSha: string;
  hasUncommitted: boolean;
  recentCommits: { sha: string; message: string }[];
  changedFiles: string[];
  diffSummary: string;
  modifiedFiles: string[];
  isReachable: boolean;
}>;
```

Each scenario gets a fake SHA. `getCurrentCommitSha` returns the scenario's SHA. `hasUncommittedChanges` returns the scenario's value.

**CRITICAL (Claude round 2):** The git/status.js mock must export ALL functions imported by real modules:
- `isCommitReachable` — imported by `loop-phases-coder-decision.ts` (lines 219, 267, 312)
- `isCommitReachableWithFetch` — imported by `loop-phases-helpers.ts` (line 417)
- `getCurrentCommitSha`, `getRecentCommits`, `getChangedFiles`, `hasUncommittedChanges`, `getDiffSummary`, `getModifiedFiles`, `getDiffStats`

Missing any export causes `TypeError: X is not a function` at runtime.

### Additional Module Mocks

These modules need lightweight mocks to prevent filesystem/process side effects:

```typescript
// Prevent real provider registry lookups
jest.unstable_mockModule('../src/providers/registry.js', () => ({
  getProviderRegistry: jest.fn(async () => ({
    tryGet: jest.fn((name) => ({
      classifyResult: (result) => classifyMockResult(name, result),
      classifyError: (code, stderr) => null,
    })),
  })),
}));

// Prevent global DB access for lease checks
jest.unstable_mockModule('../src/runners/global-db.js', () => ({
  withGlobalDatabase: jest.fn((cb) => cb(mockGlobalDb)),
}));

// Prevent real config loading — return a minimal config.
jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: jest.fn(() => ({
    ai: {
      coder: { provider: 'mock', model: 'mock-v1' },
      reviewer: { provider: 'mock', model: 'mock-v1' },
    },
    git: { branch: 'main' },
  })),
}));
// NOTE: isMultiReviewEnabled lives in reviewer.js, NOT config/loader.js (Claude round 3 fix).

// Prevent workspace pool operations
jest.unstable_mockModule('../src/workspace/git-lifecycle.js', () => ({
  prepareForTask: jest.fn(() => ({
    ok: true, startingSha: 'abc123',
    taskBranch: 'task/mock', baseBranch: 'main',
  })),
  postCoderGate: jest.fn(() => ({ ok: true, autoCommitted: false })),
  postReviewGate: jest.fn(),
}));

// Stub submission transition — MUST update task status to 'review' (round 2 fix).
// The real function calls updateTaskStatus + writes durable refs + audit metadata.
// We keep the status transition (critical for the pipeline) and skip filesystem ops.
jest.unstable_mockModule('../src/commands/submission-transition.js', () => ({
  submitForReviewWithDurableRef: jest.fn((db, taskId, actor, projectPath, commitSha, notes) => {
    db.prepare(
      "UPDATE tasks SET status = 'review', updated_at = datetime('now') WHERE id = ?"
    ).run(taskId);
    db.prepare(
      `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, commit_sha, created_at)
       VALUES (?, 'in_progress', 'review', ?, 'orchestrator', ?, ?, datetime('now'))`
    ).run(taskId, actor, notes, commitSha);
    return { ok: true };
  }),
}));
jest.unstable_mockModule('../src/commands/push-task-branch.js', () => ({
  pushTaskBranchForDurability: jest.fn(async () => ({ ok: true })),
}));

// Stub reviewer preflight (needs git access)
jest.unstable_mockModule('../src/commands/reviewer-preflight.js', () => ({
  runReviewerSubmissionPreflight: jest.fn((db, task) => ({
    ok: true,
    submissionCommitSha: 'sha-' + task.id,
  })),
}));

// Keep loop-phases-reviewer-resolution.js REAL (post-review adoption).
// It exercises multi-reviewer consensus, arbitration, and fallback logic.
// Only the LLM calls it depends on (invoke.js) are mocked above.
//
// CRITICAL (Claude round 2+3): The reviewer.js mock MUST re-export these symbols
// from the real module because non-mocked code imports them:
//   - resolveDecision (imported by loop-phases-reviewer-resolution.ts line 7)
//   - getReviewerConfigs (imported by loop-phases-reviewer.ts)
//   - isMultiReviewEnabled (imported by loop-phases-reviewer.ts line 16)
//     NOTE: isMultiReviewEnabled lives in reviewer.js, NOT config/loader.js.
//     Round 3 fix: dynamic toggle via _multiReviewEnabled flag placed HERE.
//
// Mock factory for reviewer.js must look like:
//   const realReviewer = await import('../src/orchestrator/reviewer.js');
//   let _multiReviewEnabled = false;  // toggled per scenario in loop
//   jest.unstable_mockModule('../src/orchestrator/reviewer.js', () => ({
//     invokeReviewer: mockInvokeReviewer,
//     invokeReviewers: mockInvokeReviewers,
//     resolveDecision: realReviewer.resolveDecision,
//     getReviewerConfigs: realReviewer.getReviewerConfigs,
//     isMultiReviewEnabled: jest.fn(() => _multiReviewEnabled),
//   }));

// Stub follow-up task creation
jest.unstable_mockModule(
  '../src/commands/loop-phases-reviewer-follow-ups.js',
  () => ({
    createFollowUpTasksIfNeeded: jest.fn(async () => {}),
  })
);

// Keep submission-context.js MOSTLY real (post-review adoption).
// Only mock its filesystem deps:
jest.unstable_mockModule('../src/git/submission-durability.js', () => ({
  readDurableSubmissionRef: jest.fn(() => null),
}));
jest.unstable_mockModule('../src/git/submission-resolution.js', () => ({
  resolveSubmissionCommitWithRecovery: jest.fn((projectPath, shas) => ({
    status: 'resolved', sha: shas[0], attempts: shas,
  })),
}));

// Keep reviewer-approval-outcome.js, merge-queue-completion.js, and
// automated-approval-effects.js REAL. Mock only the outer hook/section-PR
// boundaries that those modules call into.
```

### The 50 Scenarios

Organized by category. Each row = one task in the test database.

#### Happy Path (tasks 1-7)

| # | Scenario ID | Description | Expected Terminal Status |
|---|------------|-------------|------------------------|
| 1 | `happy-simple` | Coder succeeds -> submit -> reviewer approves -> merge | `completed` |
| 2 | `happy-with-commits` | Coder produces commits (no uncommitted) -> submit -> approve | `completed` |
| 3 | `happy-committed` | Coder commits all work (no uncommitted) -> submit -> approve | `completed` |
| 4 | `happy-skip` | Reviewer marks as skip (external setup only) | `skipped` |
| 5 | `happy-reviewer-fallback` | Reviewer orchestrator returns garbage but reviewer stdout has [APPROVE] -> fallback approve | `completed` |

Note: `stage_commit_submit` path is untestable in this harness (uses inline `execSync` git commands on the filesystem). Scenario 3 redesigned to avoid it. `partial` status is unreachable through the reviewer pipeline (only via manual CLI) — scenario 5 redesigned to test the explicit-decision fallback path in `loop-phases-reviewer-resolution.ts`.
| 6 | `happy-multi-review` | Two reviewers both approve | `completed` |
| 7 | `multi-reviewer-arbitrate` | Approve + skip routes through multi-review arbitration | `completed` |

#### Rejection and Coordinator (tasks 8-16)

| # | Scenario ID | Description | Expected Terminal Status |
|---|------------|-------------|------------------------|
| 8 | `reject-once` | Reject once -> retry -> approve | `completed` |
| 9 | `reject-5x-coordinator` | 5 rejections (coordinator@2,5) -> approve | `completed` |
| 10 | `reject-9x-coordinator` | 9 rejections (coordinator@2,5,9) -> approve | `completed` |
| 11 | `reject-15x-failed` | 15 rejections -> failed -> auto-dispute created | `failed` |
| 12 | `reject-with-must-implement` | Coordinator issues MUST_IMPLEMENT -> coder retries with guidance | `completed` |
| 13 | `reject-wontfix-override` | Coder claims WONT_FIX -> orchestrator overrides -> retry | `completed` |
| 14 | `reject-out-of-scope` | Reviewer rejects with [OUT_OF_SCOPE] items preserved | `completed` |
| 15 | `reject-coordinator-fails` | Coordinator invocation throws -> continues without guidance | `completed` |
| 16 | `reject-coordinator-cached` | Coordinator result reused from cache on non-threshold cycle | `completed` |

#### Coder Provider Failures (tasks 17-24)

| # | Scenario ID | Description | Expected Terminal Status |
|---|------------|-------------|------------------------|
| 17 | `coder-fail-once` | Coder exits non-zero once -> retry -> succeeds | `completed` |
| 18 | `coder-fail-3x` | Coder exits non-zero 3 times -> task failed | `failed` |
| 19 | `coder-timeout` | Coder times out -> retry -> succeeds | `completed` |
| 20 | `coder-credit-exhaustion` | Coder stderr matches credit pattern -> real pause handler runs, then harness terminalizes | `blocked_error` |
| 21 | `coder-rate-limit` | Coder stderr matches rate limit -> real pause handler runs, then harness terminalizes | `blocked_error` |
| 22 | `coder-auth-error` | Coder stderr matches auth error -> real auth pause handler runs, then harness terminalizes | `blocked_error` |
| 23 | `coder-context-exceeded` | Coder stderr says context too long x3 -> failed | `failed` |
| 24 | `coder-model-not-found` | Coder stderr says model not found x3 -> failed | `failed` |

Note: Scenarios 23-24 require 3 consecutive failures because `handleProviderInvocationFailure` uses `MAX_PROVIDER_NONZERO_FAILURES=3`. `classifyResult` returns `context_exceeded`/`model_not_found` which are NOT early-return types (only `credit_exhaustion`, `rate_limit`, `auth_error` return early).

#### Reviewer Provider Failures (tasks 25-30)

| # | Scenario ID | Description | Expected Terminal Status |
|---|------------|-------------|------------------------|
| 25 | `reviewer-fail-once` | Reviewer exits non-zero once -> retry -> approves | `completed` |
| 26 | `reviewer-fail-3x` | Reviewer exits non-zero 3 times -> repeated unclear review escalation | `disputed` |
| 27 | `reviewer-timeout-once` | Reviewer times out -> retry -> approves | `completed` |
| 28 | `reviewer-credit-exhaustion` | Reviewer credit exhausted -> real pause handler runs, then harness terminalizes | `blocked_error` |
| 29 | `reviewer-rate-limit` | Reviewer rate limited -> real pause handler runs, then harness terminalizes | `blocked_error` |
| 30 | `reviewer-auth-error` | Reviewer auth failure -> real auth pause handler runs, then harness terminalizes | `blocked_error` |

#### Orchestrator Parse Failures (tasks 31-35)

| # | Scenario ID | Description | Expected Terminal Status |
|---|------------|-------------|------------------------|
| 31 | `orch-parse-fail-once` | Orchestrator returns garbage once -> retry -> succeeds | `completed` |
| 32 | `orch-parse-fail-3x` | Orchestrator returns garbage 3 times -> task failed | `failed` |
| 33 | `orch-parse-fail-completion-signal` | Parse fails but coder stdout has "task completed" + commits -> submit | `completed` |
| 34 | `reviewer-unclear-once` | Reviewer decision unclear -> retry -> approve | `completed` |
| 35 | `reviewer-unclear-3x` | Reviewer decision unclear 3 times -> dispute | `disputed` |

#### Contract Violations (tasks 36-39)

| # | Scenario ID | Description | Expected Terminal Status |
|---|------------|-------------|------------------------|
| 36 | `contract-checklist-once` | Missing checklist once -> retry -> succeeds | `completed` |
| 37 | `contract-checklist-3x` | Missing checklist 3 times -> failed | `failed` |
| 38 | `contract-rejection-response` | Missing rejection response -> retry -> succeeds | `completed` |
| 39 | `coder-retry-cap` | Coder retries 3 consecutive times -> failed | `failed` |

#### Reviewer Decisions (tasks 40-43)

| # | Scenario ID | Description | Expected Terminal Status |
|---|------------|-------------|------------------------|
| 40 | `reviewer-dispute` | Reviewer returns dispute decision | `disputed` |
| 41 | `reviewer-zero-output-timeout` | Reviewer times out with no output 3 times -> dispute (REVIEWER_ZERO_OUTPUT_TIMEOUT) | `disputed` |
| 42 | `multi-reviewer-partial-fail` | One reviewer fails, one succeeds -> degrade to single | `completed` |
| 43 | `multi-reviewer-all-fail` | All reviewers fail -> provider failure handling until retry cap trips | `failed` |

#### Dependency Gating (tasks 44-47)

Post-review fix (round 2): Redesigned as **ordering tests**. All dep tasks complete, but we verify via audit trail that gated tasks were NOT started before their dependencies completed. Uses isolated section pairs (D->E, F) separate from section A. No anchor/blocker tasks needed (round 2 fix for crash bug — synthetic non-scenario tasks crash the mock).

| # | Scenario ID | Section | Description | Expected Terminal Status |
|---|------------|---------|-------------|------------------------|
| 44 | `dep-section-gated` | E (depends on D) | Must start AFTER task 45 completes | `completed` |
| 45 | `dep-section-gate` | D | Gate task, completes normally | `completed` |
| 46 | `dep-task-gated` | F | Task-level dep on task 47, must start AFTER 47 completes | `completed` |
| 47 | `dep-task-gate` | F | Gate task, completes normally | `completed` |

**Assertion:** Check audit trail ordering — task 44's `pending->in_progress` entry has `created_at` AFTER task 45's terminal transition. Same for 46 vs 47.

#### Submission Edge Cases (tasks 48-50)

| # | Scenario ID | Description | Expected Terminal Status |
|---|------------|-------------|------------------------|
| 48 | `submission-commit-unreachable` | Coder submits but commit SHA is not reachable in the workspace -> failed before review | `failed` |
| 49 | `submission-durable-write-fail` | Durable ref write fails -> failed | `failed` |
| 50 | `coder-error-decision` | Orchestrator returns STATUS: ERROR -> task failed immediately | `failed` |

Note: `noop-submission` replaced — the no-op detection path is pool-specific (`handleNoOpSubmissionInPool` only triggers when `poolSlotContext` is truthy). Testing it requires pool mock infrastructure beyond this harness's scope.

### Test Structure

```typescript
// tests/integration-pipeline.test.ts

// -- 1. Set up mocks BEFORE imports --
const mockInvokeCoder = jest.fn();
const mockInvokeReviewer = jest.fn();
const mockInvokeCoordinator = jest.fn();
const mockOrchestratorInvoke = jest.fn();
// ... all mocks from above

jest.unstable_mockModule('../src/orchestrator/coder.js', () => ({
  invokeCoder: mockInvokeCoder,
  resolveEffectiveCoderConfig: jest.fn(() => ({
    provider: 'mock', model: 'mock-v1',
  })),
}));
// ... remaining mocks

// -- 2. Dynamic imports AFTER mocks --
const { runCoderPhase } = await import(
  '../src/commands/loop-phases-coder.js'
);
const { runReviewerPhase } = await import(
  '../src/commands/loop-phases-reviewer.js'
);
const {
  selectNextTask, markTaskInProgress, getTaskCounts,
} = await import('../src/orchestrator/task-selector.js');
const { SCHEMA_SQL } = await import('../src/database/schema.js');
const queries = await import('../src/database/queries.js');

// -- 3. Test harness --
describe('Integration Pipeline: 50-Ticket Full Verification', () => {
  let db;
  const invocationCounters = new Map();
  const scenarios = new Map();
  const taskScenarioMap = new Map();
  const creditResults = new Map();

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    // Migration 028 columns not yet backported to SCHEMA_SQL (round 2 fix)
    db.exec(`
      ALTER TABLE tasks ADD COLUMN merge_phase TEXT;
      ALTER TABLE tasks ADD COLUMN approved_sha TEXT;
      ALTER TABLE tasks ADD COLUMN rebase_attempts INTEGER DEFAULT 0;
    `);

    registerScenarios(scenarios);
    seedDatabase(db, scenarios, taskScenarioMap);

    // Wire mock responses to scenario scripts
    mockInvokeCoder.mockImplementation((task, pp, action, guidance, rid) => {
      const scenarioId = taskScenarioMap.get(task.id);
      const count = bumpCounter(invocationCounters, task.id, 'coder');
      const script = scenarios.get(scenarioId);
      const step = script[Math.min(count, script.length - 1)];
      return step.coder ?? DEFAULT_CODER_SUCCESS;
    });
    // Similar wiring for reviewer, orchestrator, coordinator...
  });

  afterEach(() => {
    db.close();
    jest.clearAllMocks();
    invocationCounters.clear();
  });

  it('routes all 50 tasks to expected terminal states', async () => {
    const MAX_ITERATIONS = 500;
    const projectPath = '/mock/project';
    const coordinatorCache = new Map();

    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const selected = selectNextTask(db);
      if (!selected) break;

      const { task, action } = selected;
      let creditResult;

      // Toggle multi-review per scenario (round 2 fix)
      const scenarioId = taskScenarioMap.get(task.id);
      const MULTI_REVIEW_SCENARIOS = ['happy-multi-review', 'multi-reviewer-arbitrate', 'multi-reviewer-partial-fail', 'multi-reviewer-all-fail'];
      _multiReviewEnabled = MULTI_REVIEW_SCENARIOS.includes(scenarioId ?? '');

      if (action === 'start') {
        markTaskInProgress(db, task.id);
        creditResult = await runCoderPhase(
          db, task, projectPath, 'start', true, coordinatorCache
        );
      } else if (action === 'resume') {
        creditResult = await runCoderPhase(
          db, task, projectPath, 'resume', true, coordinatorCache
        );
      } else if (action === 'review') {
        const cached = coordinatorCache.get(task.id);
        creditResult = await runReviewerPhase(
          db, task, projectPath, true, cached
        );
      } else if (action === 'merge') {
        await completeMergePendingTask(
          db,
          task,
          buildMergeCompletionOptions(task.id),
        );
      }

      if (creditResult) {
        creditResults.set(task.id, creditResult);
        const pauseResult = creditResult.action === 'pause_auth_error'
          ? await handleAuthError({ ...creditResult, db, projectPath, runnerId: 'integration-harness', shouldStop: () => false })
          : await handleCreditExhaustion({ ...creditResult, db, projectPath, runnerId: 'integration-harness', shouldStop: () => false });

        // Harness-only terminalization: the real loop exits after the pause
        // handler returns hibernating, but the test needs to keep driving the
        // remaining scenarios in one deterministic run.
        if (!pauseResult.resolved) {
          queries.updateTaskStatus(db, task.id, 'blocked_error', 'test',
            'Paused after real pause handler: ' + creditResult.action);
        }
      }
    }

    // Assert every task reached its expected terminal status
    for (const [taskId, scenarioId] of taskScenarioMap) {
      const task = queries.getTask(db, taskId);
      const expected = EXPECTED_TERMINAL_STATUS[scenarioId];
      expect(task.status).toBe(expected);
    }
  });

  // Per-scenario invariant checks run as separate test cases...
  it('creates a dispute for 15-rejection scenario', async () => {
    // ...
  });

  it('invokes coordinator at thresholds 2, 5, 9', async () => {
    // ...
  });

  // ... etc.
});
```

### Database Seeding

```typescript
function seedDatabase(db, scenarios, taskScenarioMap) {
  // Section A: independent (tasks 1-43, 48-50)
  const sectionA = queries.createSection(db, {
    name: 'Core', position: 1,
  });

  // Section D: gate section (task 45: dep-section-gate)
  const sectionD = queries.createSection(db, {
    name: 'Dep Gate D', position: 4,
  });

  // Section E: depends on D (task 44: dep-section-gated)
  const sectionE = queries.createSection(db, {
    name: 'Dep Gated E', position: 5,
  });
  queries.addSectionDependency(db, sectionE.id, sectionD.id);

  // Section F: task-level dependency scenarios (tasks 46-47)
  const sectionF = queries.createSection(db, {
    name: 'Task Deps', position: 6,
  });

  // Create all 50 scenario tasks in their assigned sections
  for (const [idx, scenarioId] of SCENARIO_IDS.entries()) {
    const sectionId = getSectionForScenario(
      scenarioId, sectionA, sectionD, sectionE, sectionF
    );
    const task = queries.createTask(db, {
      title: '[' + scenarioId + '] Test task #' + (idx + 1),
      sectionId,
    });
    taskScenarioMap.set(task.id, scenarioId);
  }

  // Task 46 (dep-task-gated) depends on task 47 (dep-task-gate)
  const task46 = findTaskByScenario('dep-task-gated');
  const task47 = findTaskByScenario('dep-task-gate');
  queries.addTaskDependency(db, task46, task47);
}
```

### Helper Factories

```typescript
// -- Coder --
const coderSuccess = (stdout = 'Task completed') => ({
  stdout, stderr: '', exitCode: 0,
  success: true, timedOut: false, duration: 5000,
});
const coderFail = (exitCode = 1, stderr = 'Error') => ({
  stdout: '', stderr, exitCode,
  success: false, timedOut: false, duration: 1000,
});
const coderTimeout = () => ({
  stdout: '', stderr: 'timeout', exitCode: 1,
  success: false, timedOut: true, duration: 900000,
});

// -- Orchestrator --
const orchSubmit = () => ({
  output: 'STATUS: REVIEW\nREASON: Task implemented\nCONFIDENCE: HIGH',
});
const orchRetry = () => ({
  output: 'STATUS: RETRY\nREASON: Needs more work\nCONFIDENCE: MEDIUM',
});
const orchGarbage = () => ({
  output: 'aslkdjflaskjdf no valid output',
});

// -- Reviewer --
const reviewerApprove = () => ({
  stdout: '[APPROVE] Code looks good', stderr: '', exitCode: 0,
  success: true, timedOut: false, duration: 3000, decision: 'approve',
});
const reviewerReject = (notes = 'Needs fixes') => ({
  stdout: '[REJECT] ' + notes, stderr: '', exitCode: 0,
  success: true, timedOut: false, duration: 3000, decision: 'reject',
});
const reviewerDispute = () => ({
  stdout: '[DISPUTE] Cannot agree', stderr: '', exitCode: 0,
  success: true, timedOut: false, duration: 3000, decision: 'dispute',
});
const reviewerSkip = () => ({
  stdout: '[SKIP] External setup only', stderr: '', exitCode: 0,
  success: true, timedOut: false, duration: 3000, decision: 'skip',
});
```

## Implementation Order

1. **Phase 1: Mock infrastructure** -- Create scenario script registry, helper factories, mock wiring, and DB seeding. Write the test scaffold with the main loop driver.

2. **Phase 2: Happy path scenarios (1-6)** -- Get the basic flow working end-to-end. Verify tasks reach `completed`/`skipped`/`partial`.

3. **Phase 3: Rejection and coordinator scenarios (7-16)** -- Add rejection counting, coordinator threshold invocation, MUST_IMPLEMENT, WONT_FIX override.

4. **Phase 4: Provider failure scenarios (17-30)** -- Add coder/reviewer failure handling, credit exhaustion, rate limiting, auth errors.

5. **Phase 5: Parse failure and contract scenarios (31-39)** -- Add orchestrator parse fallback, retry caps, contract violations.

6. **Phase 6: Reviewer decision scenarios (40-43)** -- Add dispute, zero-output timeout, multi-reviewer degradation.

7. **Phase 7: Dependency and submission edge cases (44-50)** -- Add section/task dependency gating, submission failures.

Each phase is independently testable. Run `npm test -- tests/integration-pipeline.test.ts` after each phase.

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Mock returns wrong step (invocation count overflow) | Clamp to last step: `script[Math.min(count, script.length - 1)]` |
| Infinite loop (task never reaches terminal) | `MAX_ITERATIONS = 500` safety cap + assertion that loop terminates |
| Parallel task selection (not in test) | Test runs single-threaded; no locking needed |
| Section B tasks selected before A completes | `selectNextTask` respects deps natively; test verifies |
| Credit exhaustion pauses the loop | Record signal in `creditResults` map; skip that task |

## Non-Goals

- Testing actual provider CLI invocation (provider-specific tests cover that)
- Testing filesystem git operations (mocked out entirely)
- Testing the WebUI / API layer
- Performance benchmarking
- Testing parallel runners / workstreams (single-threaded loop only)
- Testing the merge queue cherry-pick logic (mocked as direct status update)
- Testing runner lifecycle (credit-pause global backoff, runner exit/restart, process SIGTERM recovery)
- Testing merge-queue state machine (sha_mismatch, rebase conflicts, fetch errors) -- follow-up task
- Testing concurrent runner race conditions or process interruption recovery

**Known gaps (per cross-provider review):**
- `stage_commit_submit` path uses inline `execSync` git commands — untestable without mocking `node:child_process`
- `noop-submission` detection is pool-specific — requires pool slot mock infrastructure
- `partial` task status is unreachable through the reviewer pipeline (only via manual CLI)

**Known gap (per Codex round 1):** The test loop is a simplified single-threaded driver, not the production `orchestrator-loop.ts`. It tests decision routing and state machine correctness but not runner lifecycle behaviors like global backoff or graceful shutdown. The S7 pending-to-review optimization IS exercised because it lives inside `selectNextTask` which runs real.

## Cross-Provider Review

Reviewed by **Gemini** and **Codex (GPT-5.4)** in parallel. Findings assessed independently below.

### Finding 1: Over-mocking removes transitions under test (Gemini + Codex)

**Claim:** Mocking ~15 modules guts the test. Specifically: `reviewer-resolution`, `reviewer-approval-outcome`, `submission-context`, `submission-transition`, and `reviewer-preflight` contain real logic that bridges decisions to DB state. The test becomes "a unit test of the loop's ability to call mocks."

**Assessment:** Partially valid. After reading the source:
- `loop-phases-reviewer-resolution.ts` has substantial logic: multi-reviewer consensus detection, arbitration with contract-violation checking, fallback from failed orchestrator to explicit reviewer tokens, merged reject notes. Mocking this removes real coverage.
- `reviewer-approval-outcome.ts` has `deriveApprovedOutcome` (pure logic: isNoOp check) and `applyApprovedOutcome` (DB transaction + audit entry). Mocking this replaces a real DB write with a fake one.
- `submission-context.ts` reads from DB + filesystem (`readDurableSubmissionRef`). The DB reads are valuable; the filesystem reads need mocking.
- `submission-transition.ts` and `reviewer-preflight.ts` do deep git I/O — mocking these is unavoidable.

**Decision: ADOPT.** Reduce mock surface:
1. Keep `loop-phases-reviewer-resolution.ts` **real**. Only mock `invoke.js` (the LLM calls it depends on). This exercises the real decision parser, consensus logic, and arbitration fallbacks.
2. Keep `reviewer-approval-outcome.ts`, `merge-queue-completion.ts`, and `automated-approval-effects.ts` **real**. Mock only the outer hook/section-PR boundaries they call.
3. Keep `submission-context.ts` **mostly real**. Mock only `readDurableSubmissionRef` (filesystem) and `resolveSubmissionCommitWithRecovery` (git).
4. Continue mocking `submission-transition.ts` and `reviewer-preflight.ts` (unavoidable git I/O).

This reduces the mock surface from ~15 modules to ~12, and keeps the most logic-heavy bridges real.

---

### Finding 2: Single shared loop is fatal / non-diagnostic (Gemini + Codex)

**Claim:** The monolithic 50-task loop makes debugging impossible and dependency-gating scenarios unreliable because 40+ tasks in section A dominate selection ordering.

**Assessment:** The shared loop is the explicit design goal — the user requested "50 tickets on a fresh database" to test interaction effects. Isolated per-scenario tests already exist as unit tests. However, the dependency-gating concern about section A having 40+ tasks is valid: section B stays blocked until ALL section A tasks reach terminal states, which won't happen because paused tasks (credit/rate/auth) remain non-terminal.

**Decision: ADOPT in part.** Isolate dependency scenarios into their own section pairs to make them diagnostic:
- Create **Section D** (1 task: `dep-section-unblocked`) and **Section E** (1 task: `dep-section-blocked`, depends on D). These are independent of the main Section A.
- Similarly for task dependencies: use Section F with just 2 tasks.
- Keep the shared loop for all other scenarios (the interaction effects are the point).
- Add per-scenario assertion messages with scenario ID for debuggability.

**REJECT** Gemini's recommendation to isolate every scenario — that defeats the purpose.

---

### Finding 3: MAX_ITERATIONS=200 is insufficient (Gemini + Codex)

**Claim:** The 15-rejection scenario alone needs ~30 iterations (15 coder + 15 reviewer). With 50 tasks, many having multiple cycles, 200 is too low.

**Assessment:** Valid. Back-of-envelope: 6 happy paths x3 = 18; reject-15x = 32; reject-9x = 20; reject-5x = 12; other rejections ~30; provider failures ~30; parse/contract ~25; reviewer decisions ~15; deps ~8; submission ~6. Total ~196. That's cutting it to the wire with zero margin.

**Decision: ADOPT.** Increase `MAX_ITERATIONS` to **500**. The loop is synchronous mock calls — even 500 iterations will run in milliseconds.

---

### Finding 4: Credit exhaustion causes infinite selection loop (Gemini + Codex)

**Claim:** Paused tasks stay in `in_progress`/`review`. `selectNextTask` will keep returning the same paused task, burning iterations without progress.

**Assessment:** Valid. The test loop records the credit signal but doesn't prevent re-selection. Production solves this by exiting the runner entirely; our test loop needs an equivalent.

**Decision: ADOPT.** ~~Add a `pausedTaskIds` set~~ (Round 2 superseded: `continue` on the same task causes infinite spin because `selectNextTask` is deterministic). **Actual fix:** run the real pause/backoff handler first, then mark the task `blocked_error` in the harness so `selectNextTask` stops returning it. Expected terminal status for credit/rate/auth scenarios becomes `blocked_error`. The assertions verify the DB status, the recorded pause signal, and the real backoff side effects.

---

### Finding 5: Custom loop is not the production loop (Codex)

**Claim:** The test loop omits the S7 pending-to-review shim, credit-pause global backoff, and merge queue routing. It validates the harness, not the runner.

**Assessment:** Partially valid but overstated. The S7 optimization lives inside `selectNextTask` which we keep real. Credit-pause global backoff is runner lifecycle management, not decision logic. The merge queue is intentionally mocked because it requires real git operations.

**Decision: DEFER.** Document the gap explicitly in Non-Goals. The test targets decision routing and state machine correctness, not runner lifecycle. A separate runner-lifecycle integration test could be a follow-up.

---

### Finding 6: Missing merge-queue paths (Codex)

**Claim:** `sha_mismatch`, `fetch_transient`, `fetch_permanent`, `rebase_conflict`, and the full `merge_phase` state machine are not covered.

**Assessment:** Valid. We mock merge-queue entirely. These are real edge cases that matter.

**Decision: DEFER.** Create a follow-up task for merge-queue-specific integration tests that mock at the git level within the merge queue, not the merge queue itself.

---

### Finding 7: Missing concurrency, process interruption, DB failure tests (Gemini)

**Claim:** No tests for runner SIGTERM recovery, concurrent runners, disk-full scenarios.

**Assessment:** These are explicitly documented as non-goals. The user asked for mocked integration tests of the decision pipeline, not chaos engineering.

**Decision: REJECT.** Out of scope as documented in Non-Goals.

---

### Finding 8: coordinatorCache shared state creates ordering issues (Codex)

**Claim:** Shared cache across tasks creates implicit ordering dependencies.

**Assessment:** Overstated by Codex's own admission. The cache is keyed by task ID in a single-threaded loop. Task A's cached coordinator result cannot affect task B. The `reject-coordinator-cached` scenario intentionally tests that the cache persists across iterations for the SAME task. No cross-task coupling exists.

**Decision: REJECT.** Not a real issue.

---

### Summary

| # | Finding | Source | Decision |
|---|---------|--------|----------|
| 1 | Over-mocking internal modules | Both | **ADOPT**: Keep reviewer-resolution, approval-outcome, submission-context real |
| 2 | Monolithic design is fatal | Both | **ADOPT in part**: Isolate dependency scenarios into dedicated sections |
| 3 | MAX_ITERATIONS too low | Both | **ADOPT**: Increase to 500 |
| 4 | Credit exhaustion loop spin | Both | **ADOPT**: Add pausedTaskIds set to skip paused tasks |
| 5 | Custom loop != production loop | Codex | **DEFER**: Document gap, test targets decisions not lifecycle |
| 6 | Missing merge-queue paths | Codex | **DEFER**: Follow-up task for merge-queue integration tests |
| 7 | Missing concurrency/interruption | Gemini | **REJECT**: Explicitly non-goals |
| 8 | coordinatorCache coupling | Codex | **REJECT**: Cache is task-ID-keyed, no cross-task effect |

### Round 2 Review (Gemini + Claude + Codex)

Round 2 was aggressive: reviewers were told to assume the implementer is wrong until proven otherwise. Codex agent failed to wait for its subprocess; findings came from Gemini and Claude only.

**Bugs found and fixed:**

| # | Finding | Source | Severity | Fix applied |
|---|---------|--------|----------|-------------|
| R2-1 | `submitForReviewWithDurableRef` mock never transitions to `review` | Claude+Gemini | CRITICAL | Mock now writes DB status + audit entry |
| R2-2 | Missing `isCommitReachable`/`isCommitReachableWithFetch` in git mock | Claude | CRITICAL | Documented as required exports |
| R2-3 | `reviewer.js` mock removes `resolveDecision` needed by real resolution module | Claude | CRITICAL | Must re-export from real module |
| R2-4 | `stage_commit_submit` runs bare `execSync` git commands | Claude | HIGH | Scenario 3 redesigned to avoid path |
| R2-5 | `happy-partial` has impossible terminal status | Claude | HIGH | Replaced with `happy-reviewer-fallback` |
| R2-6 | `pausedTaskIds` spin burns all iterations | Gemini+Claude | HIGH | Mark as `blocked_error` instead |
| R2-7 | Static config mock blocks multi-review toggle | Gemini+Claude | HIGH | Dynamic `_multiReviewEnabled` flag |
| R2-8 | Anchor/blocker tasks crash mock (no scenario) | Gemini | HIGH | Redesigned deps as ordering tests |
| R2-9 | Missing migration 028 columns (merge_phase, approved_sha) | Own analysis | CRITICAL | ALTER TABLE in test setup |
| R2-10 | Reviewer orchestrator mock format undocumented | Gemini | MEDIUM | Added `reviewerOrchestrator` field + format note |
| R2-11 | Context-exceeded/model-not-found need 3 failures | Claude | MEDIUM | Scenarios 23-24 updated to 3 steps |
| R2-12 | Dynamic import inside mock factory fragile | Claude | MEDIUM | Use direct `db.prepare()` calls |
| R2-13 | noop-submission is pool-specific | Claude | LOW | Replaced with `coder-error-decision` |
| R2-14 | `createSection`/`createTask` API mismatch | Claude | LOW | Noted; fix during implementation |

**Gemini concerns assessed as NOT bugs:**
- Submission context audit trail (#5): The approve path calls `deriveApprovedOutcome` which only checks `isNoOp` (note prefix). It does NOT call `resolveApprovalSafety` — that's in the preflight (mocked). Missing audit entries don't break approval.
- Reviewer preflight SHA mismatch (#6): The SHA from preflight is passed through to `applyApprovedOutcome`; `loadSubmissionContext` results are only used for `isNoOp` check. No SHA comparison occurs.

### Round 3 Review (Claude + Gemini)

Round 3 was the final verification pass. Gemini returned a clean pass (2 low findings already addressed). Claude found 1 critical issue and 2 low issues.

| # | Finding | Source | Severity | Fix |
|---|---------|--------|----------|-----|
| R3-1 | `isMultiReviewEnabled` mocked in wrong module (config/loader instead of reviewer.js) | Claude | CRITICAL | Moved to reviewer.js mock factory |
| R3-2 | `completeTaskWithApprovalEffects` mock hardcodes `from_status='merge_pending'` | Claude | LOW | Fix during implementation |
| R3-3 | `invoke.js` mock routing between 3 orchestrator functions is implicit | Claude | LOW | Fix during implementation |

**R3-1 fixed:** `isMultiReviewEnabled` is exported from `src/orchestrator/reviewer.ts`, not `config/loader.ts`. The dynamic `_multiReviewEnabled` flag moved to the `reviewer.js` mock factory.

### Round 4 Verification Review (Gemini + Codex + Claude)

Round 4 was a post-implementation adversarial review focused on false-green risk. Gemini and Codex both returned substantive findings live. Claude also completed the review; its output was later recovered from the local Claude session artifact after the CLI in this shell fell back to `Not logged in · Please run /login`.

| # | Finding | Source | Severity | Assessment | Decision |
|---|---------|--------|----------|------------|----------|
| R4-1 | `reviewer.js` mock reintroduces local `resolveDecision` / `getReviewerConfigs` | Gemini+Codex | CRITICAL | Valid. [`tests/integration-pipeline.test.ts`](./tests/integration-pipeline.test.ts) exports `resolveMockDecision` and `getMockReviewerConfigs` from [`tests/integration-pipeline/reviewer-policy.ts`](./tests/integration-pipeline/reviewer-policy.ts), so the harness no longer keeps production reviewer resolution policy real. This directly contradicts the "Kept REAL" section above and means multi-review routing coverage is partially test-owned again. | **ADOPT**: switch back to re-exporting the real symbols from `src/orchestrator/reviewer.ts`; keep only provider invocation mocked. |
| R4-2 | `executeHarnessRun()` owns terminal transitions the production pipeline should own | Gemini+Codex | HIGH | Valid. [`tests/integration-pipeline/run-harness.ts`](./tests/integration-pipeline/run-harness.ts) directly maps `merge -> completed` and any truthy credit result -> `blocked_error`. That makes approval/merge/pause behavior pass even if the real production bridge breaks. | **ADOPT**: keep merge and approval transitions inside real production modules and make the harness only drive task selection and phase entry. |
| R4-3 | Multi-review scenarios do not prove the multi-review path actually ran | Codex | HIGH | Valid. The suite seeds multi-review scenarios in [`tests/integration-pipeline/scenarios.ts`](./tests/integration-pipeline/scenarios.ts) but never asserts that `invokeReviewers()` or `invokeMultiReviewerOrchestrator()` was called for those tasks. A regression that silently falls back to single-review could still satisfy current end-state assertions. | **ADOPT**: add explicit assertions for multi-review invocation counts and arbitration-path activation per scenario. |
| R4-4 | Large parts of the 50-scenario surface only assert terminal status | Gemini+Codex | HIGH | Mostly valid. The top-level assertion in [`tests/integration-pipeline.test.ts`](./tests/integration-pipeline.test.ts) checks final status for every scenario, but only a small subset of scenarios has invariant-specific assertions. That leaves room for false greens where the task reaches the expected status for the wrong reason. | **ADOPT IN PART**: keep the terminal-state sweep, but add targeted assertions for the riskiest scenarios (multi-review, submission, blocked-error, merge routing, dependency gating). |
| R4-5 | Harness seeds stale `sourceFile` path after moving the design doc | Codex | MEDIUM | Valid. [`tests/integration-pipeline/harness.ts`](./tests/integration-pipeline/harness.ts) still writes `docs/plans/2026-03-26-integration-test-harness.md` even though the doc moved to `docs/done/2026-03-26-integration-test-harness.md`. Because prompts are mocked here, a broken spec-link path would currently go unnoticed. | **ADOPT**: update the seeded path to `docs/done/...` and add at least one assertion that the task source file matches the moved spec path. |
| R4-6 | `// @ts-nocheck` and local provider classifier reduce confidence | Gemini+Codex | MEDIUM | Valid but secondary. [`tests/integration-pipeline.test.ts`](./tests/integration-pipeline.test.ts) disables type-checking across a broad mock surface, and [`tests/integration-pipeline/mock-classifier.ts`](./tests/integration-pipeline/mock-classifier.ts) only exercises local regex classification rather than real provider adapters. These increase drift risk but are not the primary trust failure. | **DEFER**: remove `@ts-nocheck` after the harness shape stabilises; keep classifier tests narrow and avoid overselling them as provider-adapter coverage. |

**Additional Claude findings recovered after the live pass:**

| # | Finding | Source | Severity | Assessment | Decision |
|---|---------|--------|----------|------------|----------|
| R4-7 | Normal approval completion never exercises `merge-queue-completion.ts` | Claude | HIGH | Valid and more precise than R4-2. [`tests/integration-pipeline/run-harness.ts`](./tests/integration-pipeline/run-harness.ts) marks `merge` tasks `completed` directly, while the real approved path in [`src/orchestrator/reviewer-approval-outcome.ts`](./src/orchestrator/reviewer-approval-outcome.ts) queues merge work and relies on the merge completion path to call approval effects with the right metadata. Successful scenarios therefore skip the real finalisation bridge. | **ADOPT**: keep the post-approval completion path real; the harness should not manufacture `completed` directly for merge-backed approvals. |
| R4-8 | Harness schema is patched inline and will drift from production migrations | Claude | HIGH | Valid. [`tests/integration-pipeline/harness.ts`](./tests/integration-pipeline/harness.ts) creates `task_dependencies` and adds columns with ad hoc SQL after `SCHEMA_SQL`. This is brittle and already caused one emergency fix when required columns were missing. | **ADOPT IN PART**: keep the current patch as temporary containment, but add a follow-up to seed the in-memory DB from the same migration source of truth the app uses or to centralise the harness-specific schema shim. |
| R4-9 | Mock provider classification skips production JSON-based credit detection | Claude | HIGH | Valid. [`tests/integration-pipeline/mock-classifier.ts`](./tests/integration-pipeline/mock-classifier.ts) only checks simple regexes, while [`src/providers/interface.ts`](./src/providers/interface.ts) first attempts structured JSON credit detection before provider-specific fallbacks. The current harness therefore does not cover the primary structured-error path. | **ADOPT IN PART**: narrow the claim of what these scenarios cover now, and add at least one structured-error fixture if we want provider-pause coverage to mean anything beyond regex fallback behavior. |
| R4-10 | `// @ts-nocheck` suppresses signature drift on the entire test driver | Claude | HIGH | Valid, but still secondary to the real-vs-mocked bridge problems above. The broad type disable means mock signature or raw-SQL drift can compile silently. | **DEFER**: remove `@ts-nocheck` once the harness surface is simplified and the mocks are reduced; doing it before that risks churn without increasing trust enough. |

**Rejected reviewer noise:**
- Gemini claimed [`tests/integration-pipeline/scenarios.ts`](./tests/integration-pipeline/scenarios.ts) exceeded the 500-line limit. That was incorrect during Round 4; the file was 436 lines.

### Round 5 Verification Review (Gemini + Codex + Claude)

Round 5 was the post-fix adversarial review after removing the copied reviewer policy, routing merge completion through the real bridge, adding explicit multi-review assertions, and replacing the regex-only classifier with the production `BaseAIProvider` path. Gemini and Codex completed live. Claude completed as well, but the CLI again returned empty stdout; the review text was recovered from the latest local Claude session artifact.

| # | Finding | Source | Severity | Assessment | Decision |
|---|---------|--------|----------|------------|----------|
| R5-1 | Harness still derives its oracle from the same scenario table that scripts behavior | Codex | HIGH | Valid. [`EXPECTED_TERMINAL_STATUS`](./tests/integration-pipeline/scenarios.ts) is derived from [`SCENARIOS`](./tests/integration-pipeline/scenarios.ts), and the top-level sweep in [`tests/integration-pipeline.test.ts`](./tests/integration-pipeline.test.ts) iterates that derived map. The doc already drifted once (`reject-twice-coordinator` still appears in the table while the code now uses `multi-reviewer-arbitrate`). This means coverage can shrink or expectations can move without an external oracle failing. | **ADOPT**: add at least one independent oracle, such as asserting scenario count against the design doc table or pinning a separately maintained expected scenario list. |
| R5-2 | Submission/error scenarios are still status-only and can fail for the wrong reason | Codex + Claude | HIGH | Valid in substance. [`submission-commit-unreachable`](./tests/integration-pipeline/scenarios.ts), [`submission-durable-write-fail`](./tests/integration-pipeline/scenarios.ts), and [`coder-error-decision`](./tests/integration-pipeline/scenarios.ts) are only covered by the generic terminal-state sweep. Claude also pointed out that the old `submission-commit-missing` name no longer matched the reviewer-side unreachable-SHA path because reviewer invocation is mocked. | **ADOPT**: add branch-specific assertions for submission failure provenance and rename or redesign the scenario so the name matches the path actually exercised. |
| R5-3 | Pause-signal coverage is still partial | Codex | MEDIUM | Valid. The harness now exercises the real classification path, but [`tests/integration-pipeline.test.ts`](./tests/integration-pipeline.test.ts) only asserts 3 of the 6 blocked-error pause variants. Because [`executeHarnessRun()`](./tests/integration-pipeline/run-harness.ts) rewrites any truthy pause result to `blocked_error`, the unasserted variants can regress to the wrong action and still stay green. | **ADOPT**: add explicit assertions for `coder-auth-error`, `reviewer-credit-exhaustion`, and `reviewer-rate-limit`. |
| R5-4 | Reviewer mock should import policy through `reviewer.ts`, not `reviewer-policy.ts` | Gemini | CRITICAL | Rejected. This is a Jest ESM constraint, not a correctness bug. The live production source of truth now resides in [`src/orchestrator/reviewer-policy.ts`](./src/orchestrator/reviewer-policy.ts), while [`src/orchestrator/reviewer.ts`](./src/orchestrator/reviewer.ts) re-exports those helpers for compatibility. Importing the policy module directly inside the harness mock is deliberate and avoids the broken `requireActual` path on ESM. | **REJECT**: keep the direct policy import; coverage of the compatibility re-export remains the responsibility of unit tests that import `reviewer.ts` directly. |
| R5-5 | `run-harness.ts` uses bare `Function` types | Claude | HIGH | Valid, but secondary. This is the remaining concentrated type-safety gap after removing `// @ts-nocheck` from the main test file. It will not create a false green by itself, but it can hide signature drift in the harness driver. | **ADOPT IN PART**: tighten these types when the next harness edits land; do not block the current trust fixes on a type-only refactor. |
| R5-6 | Live intake replay path and inline schema patch remain brittle | Claude | HIGH / MEDIUM | Valid as residual risk, not as an active regression. Approve scenarios still call the live intake replay builder, relying on the seeded `source_file` not being parsed as intake. The inline `ALTER TABLE` patch in [`tests/integration-pipeline/harness.ts`](./tests/integration-pipeline/harness.ts) will also break if those columns move into `SCHEMA_SQL` without guards. | **DEFER**: keep both as follow-up tasks; neither is the main remaining false-green vector compared with R5-1 through R5-3. |

**Implementation status: DONE.** The harness shipped as `tests/integration-pipeline.test.ts` with supporting helpers under `tests/integration-pipeline/`. Focused Jest coverage passes against the current runtime behavior, including the two post-implementation corrections above (`reviewer-fail-3x` => `disputed`, `multi-reviewer-all-fail` => `failed`).

### Round 6 Verification Review (Gemini + Codex + Claude)

Round 6 was the post-fix verification pass after making pause scenarios call the real pause handlers, failing on script over-consumption instead of clamping, tightening `run-harness.ts` types, and adding targeted assertions for partial multi-review degradation, reviewer zero-output timeout, and the moved design-doc path.

| # | Finding | Source | Severity | Assessment | Decision |
|---|---------|--------|----------|------------|----------|
| R6-1 | Harness oracle is still self-derived from the scenario script table | Gemini | HIGH | Valid. [`EXPECTED_TERMINAL_STATUS`](./tests/integration-pipeline/scenarios.ts) still comes from the same [`SCENARIOS`](./tests/integration-pipeline/scenarios.ts) object that drives the mock behavior, and the doc assertion only proves code and documentation agree with each other. A wrong production outcome can still be blessed by changing one shared source. | **ADOPT**: split the expected terminal-state oracle from the scripted stimulus, or maintain a separately pinned expectation map that is not derived from `SCENARIOS`. |
| R6-2 | Too many scenarios still only prove terminal status | Gemini | HIGH | Valid. The new targeted assertions cover the riskiest branches added in earlier rounds, but a substantial tail of scenarios still relies on the generic terminal-state sweep in [`tests/integration-pipeline.test.ts`](./tests/integration-pipeline.test.ts). That means some regressions can still land in the right terminal status for the wrong reason and stay green. | **ADOPT**: keep adding branch-specific assertions for the remaining scenario groups instead of relying on status-only coverage. |
| R6-3 | Mock/type surfaces still permit some drift | Gemini | MEDIUM | Valid but secondary. [`tests/integration-pipeline/runtime-mocks.ts`](./tests/integration-pipeline/runtime-mocks.ts) still uses broad `any`-typed Jest mocks, so compile-time signature drift can slip by even though the main driver types are tighter now. | **DEFER**: narrow the mock signatures when touching those call sites again; this is not the primary remaining false-green vector. |
| R6-4 | Importing reviewer policy through `reviewer-policy.ts` is still suspicious | Gemini | MEDIUM | Rejected again for the same reason as R5-4. In this Jest ESM harness, importing the production policy source directly is deliberate and avoids a broken `requireActual` path; it is not itself a correctness bug. | **REJECT**: keep the direct policy import unless the ESM mocking strategy changes. |

**Execution notes:** Gemini completed and returned the findings above. Codex and Claude both launched, read the scoped files, and then stalled without producing a final verdict in this shell; their incomplete traces did not surface a concrete boundary bug worse than R6-1 and R6-2 before they were terminated as idle.
