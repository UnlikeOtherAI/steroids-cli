# Core Loop Refactor: Extract Intent From Inline Conditionals

## Problem Statement

The core loop files are littered with inline `if` statements that hide **what** a block of code is deciding. A reader must parse the conditional expression, the body, and sometimes several levels of nesting before understanding the intent. When multiple such blocks stack up sequentially, the overall flow of a task through the loop becomes opaque.

This problem compounds during debugging: when a task gets stuck, you trace through 400+ lines of interleaved conditions, early returns, and duplicated patterns before finding the relevant decision point.

## Current Behavior

The core loop is spread across ~10 files totaling ~4,000 lines. The main flow is:

```
orchestrator-loop.ts          # iteration loop: select task, route action, cleanup
  -> loop-phases-coder.ts     # coder phase: invoke coder, orchestrator parse, decision
     -> loop-phases-coder-decision.ts  # coordinator + decision execution
  -> loop-phases-reviewer.ts  # reviewer phase: invoke reviewer(s), resolve decision, execute
     -> loop-phases-reviewer-resolution.ts  # multi/single reviewer decision resolution
```

Every file contains long runs of inline conditionals. Below is an exhaustive catalog.

---

## Catalog of Inline Conditionals

### 1. `src/runners/orchestrator-loop.ts` (496 lines)

| Lines | Condition | Hidden Intent |
|-------|-----------|---------------|
| 213 | `if (shouldStop?.())` | **Loop termination: external signal** |
| 219-223 | `if (registeredProject && !registeredProject.enabled)` | **Loop termination: project disabled** |
| 229 | `if (!refreshParallelWorkstreamLease(...))` | **Loop termination: lease lost** |
| 234 | `if (batchMode && !activeSectionIds)` | **Route to batch iteration path** |
| 246-253 | `if (options.runnerId) ... else ...` | **Task selection: locked vs unlocked** |
| 255-262 | `if (!selected)` | **Loop termination: no work remaining** |
| 266-268 | `if ('lockResult' in selected)` | **Extract lock heartbeat handle** |
| 275-292 | `if (maxInvocations > 0) + if (invCounts >= max)` | **Guard: invocation cap exceeded** |
| 294-298 | `await waitForPressureRelief()` + `if (!pressureOk)` | **Guard: system under pressure** |
| 304-331 | `if (options.runnerId) { try { ... if (!remoteUrl) ... } }` | **Pool slot acquisition** |
| 338-340 | `if (action === 'start')` | **Route: start new task** |
| 357-358 | `else if (action === 'resume')` | **Route: resume in-progress task** |
| 375-396 | `else if (action === 'review')` with nested `if (task.status === 'pending')` and `if (poolSlotCtx && !poolSlotCtx.slot.task_branch)` | **Route: review with S7 pending reroute + pool prep** |
| 412-421 | `finally` block with nested pool slot cleanup + lock release | **Cleanup: pool slot + lock** |
| 424-439 | `if (creditResult)` with `if (action === 'pause_auth_error')` | **Handle: credit/auth exhaustion** |
| 442-471 | `if (options.runnerId)` then `if (updatedTask && [...].includes(status))` then `if (status === 'completed')` | **Activity logging for terminal tasks** |

**Diagnosis:** The main `while (true)` loop body is ~270 lines. A reader must hold the full context to understand which path a task takes. Guard clauses, action routing, pool logic, and cleanup are all interleaved.

---

### 2. `src/commands/loop-phases-coder.ts` (481 lines)

| Lines | Condition | Hidden Intent |
|-------|-----------|---------------|
| 66 | `if (!task) return` | **Guard: null task** |
| 67-72 | `if (!refreshParallelWorkstreamLease(...))` | **Guard: lease lost before coder** |
| 78-110 | `if (poolSlotContext)` with nested `if (!prepResult.ok)` with nested `if (prepResult.blocked)` | **Pool workspace preparation with error/blocked handling** |
| 135-140 | `if (coderInvocation.superseded \|\| !coderInvocation.result)` | **Guard: lease superseded during coder** |
| 143-181 | `if (coderResult.timedOut \|\| !coderResult.success)` with nested `if (classified?.type === 'credit_exhaustion')`, `if (classified?.type === 'rate_limit')`, `if (classified?.type === 'auth_error')` | **Classify coder failure: credit/rate/auth/generic** |
| 185-187 | `if (!poolSlotContext)` | **Clear failure count only in non-pool mode** |
| 190-223 | `if (poolSlotContext && poolStartingSha)` with nested `if (!gateResult.ok)` with nested `if (gateResult.reasonCode === 'no_new_commits')` | **Post-coder verification gate with no-op handling** |
| 302-309 | `if (decision.action === 'submit' && has_uncommitted && commits.length === 0)` with nested `if (isTaskComplete)` | **Derive stage_commit_submit from submit + uncommitted + completion** |
| 313-353 | `if (decision.action === 'retry' && decision.reasoning.includes('FALLBACK:'))` with nested `if (isTaskComplete && hasWork)` else nested retry counter | **Orchestrator parse fallback: completion recovery vs retry escalation** |
| 356-393 | `const legacyChecklistViolation = ...` + `if (contractViolation)` with nested retry counter | **Contract violation detection + retry/fail escalation** |
| 397-434 | `if (overrideItems.length > 0)` | **WONT_FIX override enforcement** |
| 438-450 | `if (decision.action === 'retry')` with nested retry counter | **Universal retry cap** |
| 461-466 | `if (!refreshParallelWorkstreamLease(...))` | **Guard: lease lost before decision execution** |

**Diagnosis:** `runCoderPhase` is one 420-line function. The flow is: guard -> prepare workspace -> invoke coder -> guard -> classify failure -> gate -> gather git state -> invoke orchestrator -> parse with fallback -> contract check -> wont_fix check -> retry cap -> audit -> guard -> execute. Each step has 1-3 nested conditionals.

---

### 3. `src/commands/loop-phases-coder-decision.ts` (448 lines)

| Lines | Condition | Hidden Intent |
|-------|-----------|---------------|
| 49-55 | `if (persistedMustImplement && task.status === 'in_progress' && ...)` | **Resolve active MUST_IMPLEMENT override** |
| 58 | `if (thresholds.includes(task.rejection_count))` | **Should invoke coordinator at this rejection count?** |
| 61-71 | `if (activeMustImplement)` | **Apply persisted override as coordinator guidance** |
| 73-77 | `if (shouldInvokeCoordinator)` with nested `if (activeMustImplement && same cycle)` | **Skip coordinator reinvocation in same rejection cycle** |
| 113-116 | `if (coordResult)` with nested `if (mustKeepOverride && !includes('MUST_IMPLEMENT:'))` | **Preserve MUST_IMPLEMENT across coordinator reinvocations** |
| 138 | `if (coordResult.decision === 'guide_coder')` | **Persist guide_coder guidance as must_implement** |
| 158-163 | `else if (cachedResult && !activeMustImplement)` | **Reuse cached coordinator guidance** |
| 200-447 | `switch (decision.action)` with deeply nested submission logic | **Execute coder decision** |
| 206-215 | Submit: `if (!submissionCommitSha && requiresExplicitSubmissionCommit)` | **Await explicit submission token** |
| 216-228 | Submit: `if (!submissionCommitSha \|\| !isCommitReachable(...))` | **Fail: commit missing/unreachable** |
| 231-246 | Submit: `if (leaseFence?.parallelSessionId && !hasPoolSlot)` + nested `if (!pushResult.success)` | **Push in legacy workstream mode only** |
| 275-344 | Stage+commit+submit: entire branch duplicated from submit with extra auto-commit | **Duplicate of submit with auto-commit prepended** |
| 347-352 | `if (!refreshParallelWorkstreamLease(...))` | **Guard: lease lost before auto-commit** |

**Additional conditionals not in main catalog (flagged by review):**
- Line 128: `poolStartingSha || getCurrentCommitSha(effectiveProjectPath) || ''` — three-way `initialSha` fallback that determines commit comparison baseline
- Line 230: `const hasRelevantChanges = has_uncommitted || commits.length > 0 || files_changed.length > 0` — boolean composition driving both orchestrator fallback and parse-fallback recovery

**Diagnosis:** `executeCoderDecision` is 250 lines. The `submit` and `stage_commit_submit` branches share structure but differ in three ways: (1) different submission reason strings per path, (2) `stage_commit_submit` has a lease check between `!has_uncommitted` guard and `git add` (line 347), (3) three distinct paths (submit, stage_commit_submit-no-uncommitted, stage_commit_submit-with-uncommitted). Naive dedup into a single wrapper would obscure the mid-block lease check.

---

### 4. `src/commands/loop-phases-reviewer.ts` (485 lines)

| Lines | Condition | Hidden Intent |
|-------|-----------|---------------|
| 60-66 | `if (!task) return` + `if (!refreshParallelWorkstreamLease)` | **Guards: null task, lease lost** |
| 71-73 | `if (poolSlotContext)` | **Update pool slot status to review_active** |
| 76-78 | `if (!preflight.ok)` | **Guard: submission preflight failed** |
| 88-250 | `if (multiReviewEnabled) { ... } else { ... }` | **Route: multi-reviewer vs single-reviewer invocation** |
| 110-115 | `if (reviewerInvocation.superseded \|\| !result)` | **Guard: lease superseded during multi-review** |
| 121-171 | `if (failedResults.length > 0 && successfulResults.length === 0)` with credit/rate/auth classification, then `if (failedResults.length > 0 && successfulResults.length > 0)` | **Multi-reviewer failure triage: all-failed vs partial-failure** |
| 213-218 | `if (reviewerInvocation.superseded \|\| !result)` | **Guard: lease superseded during single-review** |
| 221-249 | `if (!reviewerResult.success \|\| reviewerResult.timedOut)` with credit/rate/auth classification | **Single-reviewer failure classification (duplicated from multi-review)** |
| 276-316 | `if (decision.decision === 'unclear')` with retry counter, zero-output-timeout detection | **Unclear decision fallback with escalation** |
| 327-332 | `if (!refreshParallelWorkstreamLease)` | **Guard: lease lost before decision execution** |
| 347-484 | `switch (decision.decision)` — approve/reject/dispute/skip/unclear | **Execute reviewer decision** |
| 349-425 | Approve: `if (poolSlotContext)` with nested no-op/merge/push paths vs `else` legacy push | **Approve path: pool merge vs legacy push** |
| 362-369 | Approve-pool: `if (isNoOp)` | **No-op approval shortcut (no merge needed)** |
| 374-384 | Approve-pool: `if (!mergeResult.ok)` | **Merge failure handling** |
| 403-408 | Approve-legacy: `if (!refreshParallelWorkstreamLease)` | **Guard: lease before push** |

**Additional conditionals not in main catalog (flagged by review):**
- Lines 432-441: Out-of-scope item extraction in the `reject` case — regex matching on raw reviewer stdout, conditionally appending to decision notes

**Diagnosis:** The reviewer failure classification (credit/rate/auth check) is **duplicated** in the multi-reviewer (lines 138-151) and single-reviewer (lines 234-245) paths. The multi-reviewer path resolves provider/model from `failedConfig` first; the single-reviewer path resolves from `reviewerResult` first. A shared helper must accept pre-resolved names, not re-derive them. The approval execution has two parallel paths (pool vs legacy) that share most of their structure.

---

### 5. `src/commands/loop-phases-reviewer-resolution.ts` (330 lines)

| Lines | Condition | Hidden Intent |
|-------|-----------|---------------|
| 128-242 | `if (effectiveMultiReviewEnabled) { ... } else { ... }` | **Route: multi-reviewer resolution vs single-reviewer** |
| 152-176 | `if (resolution.route === 'direct')` with nested `if (decision === 'unclear')` | **Direct multi-review: unanimous or all-unclear** |
| 177-184 | `else if (resolution.route === 'local_reject_merge')` | **All-reject: merge checklists locally** |
| 185-242 | `else (arbitrate)` with retry loop + contract violation check | **Arbitration: invoke orchestrator with retry** |
| 213-241 | `if (arbitrationResult)` else `if (hasReject && !hasDispute)` else | **Post-arbitration fallback cascade** |
| 261-286 | Single: `try { ... if (decision.decision === 'unclear') { ... } } catch { ... }` | **Single-reviewer orchestrator with explicit decision fallback** |
| 267-286 | `if (decision.decision === 'unclear')` with `if (explicitDecision)` | **Unclear fallback: check reviewer stdout for explicit token** |
| 289-324 | `catch (error)` with `if (explicitDecision)` else | **Orchestrator failure: fallback to explicit token or unclear** |

**Diagnosis:** The "check reviewer stdout for explicit decision token" logic appears in two places (unclear result + catch block) within the single-reviewer path. Both produce near-identical decision payloads.

---

### 6. `src/orchestrator/coder.ts` (313 lines) and `reviewer.ts` (476 lines)

Both runners share the same pattern:
1. Resolve config (with section overrides)
2. Gather DB context (rejections, feedback, sessions, section tasks)
3. Select prompt variant (resume-delta / resume / fresh)
4. Invoke provider
5. If `SessionNotFoundError`: invalidate session, reconstruct history, retry fresh
6. Parse decision from output

The session-not-found retry logic (coder lines 156-217, reviewer lines 287-345) is **structurally identical** across both files — same token guard, same history reconstruction, same fresh retry.

---

### 7. `src/commands/loop.ts` (439 lines)

| Lines | Condition | Hidden Intent |
|-------|-----------|---------------|
| 98-156 | `if (values.project)` with nested exists/directory/steroids checks | **Validate and switch to project path** |
| 162-175 | `if (registeredProject && !registeredProject.enabled)` | **Guard: project disabled** |
| 178-192 | `if (hasActiveRunnerForProject)` | **Guard: runner already active** |
| 202-263 | `if (values.section)` with nested resolution fallback chain | **Resolve section filter** |
| 295-318 | `if (flags.dryRun)` | **Dry-run mode: preview only** |
| 372-399 | `if (action === 'start') ... else if ('resume') ... else if ('review')` + credit handling | **Action routing (simplified version of orchestrator-loop)** |

---

## Desired Behavior

Every decision point should be a **named method** whose name explains the intent. The main flow should read like a high-level narrative:

```typescript
// orchestrator-loop.ts — desired shape
while (true) {
  if (shouldTerminateLoop(options, projectPath)) break;

  const selected = selectTask(db, options);
  if (!selected) { announceCompletion(); break; }

  if (exceedsInvocationCap(db, selected.task, config)) { skipTask(...); continue; }
  if (!awaitSystemPressureRelief()) break;

  const poolSlot = tryAcquirePoolSlot(db, options, sourceProjectPath);

  try {
    await dispatchTaskAction(db, selected, options, poolSlot);
  } finally {
    releaseResources(db, selected, options, poolSlot);
  }

  if (handleCreditResult(creditResult, options)) break;
  logTerminalActivity(db, selected.task, options);

  if (once) break;
  await sleep(1000);
}
```

Each extracted method:
- Has a name that states what it checks or does
- Returns a value that makes the calling code's flow obvious (boolean, result object, void)
- Contains the full logic for that concern — no leaking into the caller
- Can be unit tested in isolation

---

## Design

### Phase 1: Orchestrator Loop (`orchestrator-loop.ts`)

Extract the following methods, all private to the module:

```typescript
// ── Loop termination guards ──
function shouldTerminateLoop(options: LoopOptions, projectPath: string): boolean
// Combines: shouldStop(), project disabled, lease lost

// ── Task selection ──
function selectTaskForIteration(
  db: Database, options: LoopOptions, activeSectionIds?: string[]
): { selected: SelectedTask | SelectedTaskWithLock; lockHeartbeat?: HeartbeatHandle } | null
// Combines: runnerId routing (locked vs unlocked), null check

// ── Pre-dispatch guards ──
function enforceInvocationCap(
  db: Database, task: Task, config: SteroidsConfig
): { capped: boolean }
// Combines: maxInvocations lookup, count check, status update, lock release

// ── Pool slot lifecycle ──
function tryAcquirePoolSlot(
  db: Database, options: LoopOptions, sourceProjectPath: string, taskId: string
): PoolSlotContext | undefined
// Combines: runnerId check, remote URL check, claim, finalize, heartbeat setup

function cleanupIterationResources(
  db: Database, taskId: string, options: LoopOptions,
  poolSlotCtx?: PoolSlotContext, poolGlobalDb?: GlobalDb, lockHeartbeat?: HeartbeatHandle
): void
// Combines: pool slot cleanup, global DB close, lock release

// ── Action dispatch ──
function dispatchTaskAction(
  db: Database, task: Task, action: string, options: LoopOptions,
  poolSlotCtx?: PoolSlotContext, sourceProjectPath: string, config: SteroidsConfig
): Promise<CreditExhaustionResult | void>
// Combines: start/resume/review routing, S7 transition, pool prep, steroids symlink

// ── Post-dispatch ──
function handleCreditResult(
  result: CreditExhaustionResult | void, options: LoopOptions, db: Database
): Promise<boolean>  // true = break loop

function logTerminalTaskActivity(
  db: Database, task: Task, options: LoopOptions, projectPath: string
): void
```

### Phase 2: Coder Phase (`loop-phases-coder.ts`)

The `runCoderPhase` function should decompose into a pipeline:

```typescript
export async function runCoderPhase(...): Promise<CreditExhaustionResult | void> {
  if (!task) return;
  if (!assertLeaseOwnership(projectPath, leaseFence, jsonMode)) return;

  const workspace = prepareCoderWorkspace(db, task, projectPath, poolSlotContext, ...);
  if (!workspace.ok) return;

  const guidance = await invokeCoordinatorIfNeeded(...);

  const coderResult = await invokeCoderWithLeaseGuard(task, workspace.effectivePath, ...);
  if (!coderResult) return;  // lease superseded

  const failureResult = classifyCoderFailure(coderResult, task, projectPath);
  if (failureResult) return failureResult;  // credit/rate/auth/provider failure

  if (!poolSlotContext) clearTaskFailureCount(db, task.id);

  if (!passPostCoderGate(db, task, workspace, poolSlotContext, ...)) return;

  const gitState = gatherGitState(workspace.effectivePath, workspace.initialSha);
  const orchestratorDecision = await resolveCoderDecision(db, task, coderResult, gitState, ...);
  const finalDecision = applyDecisionGuardrails(db, task, orchestratorDecision, coordinatorCache);

  addDecisionAuditEntry(db, task, finalDecision);
  if (!assertLeaseOwnership(projectPath, leaseFence, jsonMode)) return;

  await executeCoderDecision(db, task, finalDecision, ...);
}
```

Extracted methods:

```typescript
// ── Workspace ──
function prepareCoderWorkspace(...): { ok: boolean; effectivePath: string; initialSha?: string }
// Absorbs: pool slot prep, prepareForTask, error/blocked handling

// ── Coder invocation ──
function invokeCoderWithLeaseGuard(...): CoderResult | null
// Absorbs: invokeWithLeaseHeartbeat + superseded check

// ── Failure classification ──
function classifyCoderFailure(
  result: CoderResult, task: Task, projectPath: string
): CreditExhaustionResult | void
// Absorbs: timedOut/!success check, credit/rate/auth classification, provider failure handling

// ── Post-coder gate ──
function passPostCoderGate(
  db, task, workspace, poolSlotCtx, leaseFence, jsonMode
): boolean
// Absorbs: pool gate check, no-op submission handling, auto-commit audit

// ── Orchestrator decision ──
function resolveCoderDecision(
  db, task, coderResult, gitState, jsonMode
): CoderOrchestrationResult
// Absorbs: invokeCoderOrchestrator, catch/fallback, SignalParser, completion signal check

// ── Decision guardrails ──
function applyDecisionGuardrails(
  db, task, decision, coordinatorCache
): CoderOrchestrationResult
// Absorbs: stage_commit_submit derivation, parse fallback retry counter,
//   contract violation check, WONT_FIX override, universal retry cap
```

### Phase 3: Coder Decision Execution (`loop-phases-coder-decision.ts`)

**Extract shared sub-operations, keep switch cases as thin dispatchers.** The `submit` and `stage_commit_submit` branches share sub-operations but differ in three concrete ways that prevent a single wrapper function:

1. **Three distinct reason strings:** `decision.reasoning` (submit), `'Auto-commit skipped: no uncommitted changes'` (stage_commit_submit when nothing to commit), `Auto-committed and submitted (${decision.reasoning})` (stage_commit_submit after auto-commit).
2. **Mid-block lease check:** `stage_commit_submit` has a `refreshParallelWorkstreamLease` call between the `!has_uncommitted` guard and the `git add` (line 347). This cannot be absorbed into a wrapper without either (a) passing the lease check as a callback or (b) splitting the function at that point.
3. **Three execution paths:** submit, stage_commit_submit-no-uncommitted (falls through to submit-like logic), stage_commit_submit-with-uncommitted (auto-commit then submit).

**Approach:** Extract the shared sub-operations into three helpers called from both switch cases. The switch cases remain as visible dispatchers with different reason strings and the lease check in the right position.

```typescript
function resolveAndValidateSubmissionCommit(
  effectiveProjectPath: string, coderStdout: string,
  opts: { requireExplicitToken: boolean }
): string | null
// Returns resolved SHA or null (with side effects: logs, updates status)

function pushIfLegacyWorkstream(
  db, taskId: string, projectPath: string, branchName: string,
  leaseFence?: LeaseFenceContext, hasPoolSlot: boolean
): { ok: boolean }
// Returns false if push failed (with side effects: updates status to failed)

function writeAndConfirmDurableSubmission(
  db, taskId: string, effectiveProjectPath: string,
  sha: string, reason: string
): { ok: boolean }
// Returns false if durable write failed (with side effects: updates status to failed)
```

**Constraint:** Phase 3 must not change the public signature of `executeCoderDecision`. All dedup is internal to that function. This ensures Phase 2 (which depends on Phase 3) is not broken during the intermediate state.

**`clearTaskFailureCount` placement:** In the coder path, `clearTaskFailureCount` is called only when `!poolSlotContext` (line 186 of `loop-phases-coder.ts`). In pool mode, the orchestrator-loop's `cleanupPoolSlot` handles it (line 71 of `orchestrator-loop.ts`). This distinction must be preserved after extraction — the call stays in `runCoderPhase`, not inside any extracted helper.

### Phase 4: Reviewer Phase (`loop-phases-reviewer.ts`)

**Deduplicate failure classification.** The credit/rate/auth check appears twice (multi and single paths). The callers resolve `providerName`/`modelName` differently (multi-path from `failedConfig`, single-path from `reviewerResult`), so the helper must accept pre-resolved names:

```typescript
function classifyReviewerFailure(
  result: ReviewerResult, providerName: string, modelName: string, projectPath: string
): CreditExhaustionResult | null
// Returns CreditExhaustionResult for credit/rate/auth errors, null otherwise.
// Generic provider failure handling stays in the caller (different for all-failed vs partial-failed).
```

**`clearTaskFailureCount` placement in reviewer paths:** After extraction, `clearTaskFailureCount` is called in three places and each must be preserved:
1. Multi-reviewer success path: after partial-failure filtering, before any decision processing (current line 189).
2. Single-reviewer success path: inside the `else` branch when `reviewerResult.success && !reviewerResult.timedOut` (current line 248).
3. Pool slot cleanup in orchestrator-loop: `cleanupPoolSlot` calls it on successful push (current line 71 of `orchestrator-loop.ts`).
None of these calls should be moved inside `classifyReviewerFailure` or `invokeReviewersNormalized`.

**Flatten multi/single branching.** Instead of a 160-line if/else, normalize early:

```typescript
const invokeResult = await invokeReviewersNormalized(
  db, task, effectiveProjectPath, phaseConfig, coordinatorResult, leaseFence
);
// Returns: { results: ReviewerResult[], effectiveMultiReview: boolean }
```

**Extract decision execution into a dispatcher:**

```typescript
function executeReviewerDecision(
  db, task, decision, ctx: ReviewerExecutionContext
): Promise<void>
// Contains the switch: approve/reject/dispute/skip/unclear
// Each case is a separate function:
//   executeApproval(db, task, decision, ctx)
//   executeRejection(db, task, decision)
//   executeDispute(db, task, decision, ctx)
//   executeSkip(db, task, decision)
```

Within `executeApproval`, extract:
```typescript
function approveViaPoolMerge(db, task, decision, poolSlotCtx, config): Promise<void>
function approveViaLegacyPush(db, task, decision, ctx): Promise<void>
```

### Phase 5: Reviewer Resolution (`loop-phases-reviewer-resolution.ts`)

Extract:
```typescript
function resolveMultiReviewDecision(task, reviewerResults, projectPath, gitContext): Promise<ReviewerOrchestrationResult>
function resolveSingleReviewDecision(task, reviewerResult, projectPath, gitContext): Promise<ReviewerOrchestrationResult>
function tryExplicitDecisionFallback(reviewerStdout, task, reasoning): ReviewerOrchestrationResult | null
// Used in both the unclear-result and catch-block paths of single reviewer
```

### Phase 6: Shared Session Resume Logic (`coder.ts` + `reviewer.ts`)

Extract into `base-runner.ts` or a new `session-resume.ts`:
```typescript
async function retryWithHistoryReconstruction(
  runner: BaseRunner, projectPath: string, taskId: string,
  sessionId: string, basePromptFn: () => string, fullPromptFn: () => string,
  providerName: string, modelName: string, role: 'coder' | 'reviewer',
  timeoutMs: number, runnerId?: string
): Promise<BaseRunnerResult>
// Absorbs: token guard, history reconstruction, session invalidation, fresh retry
```

### Phase 7: Lease Guard Pattern

**Prerequisite: unify the two `refreshParallelWorkstreamLease` implementations.** There are currently two:
- `src/runners/orchestrator-loop.ts` lines 89-130: standalone function taking `(parallelSessionId, projectPath, runnerId)`, uses direct DB access.
- `src/commands/loop-phases-helpers.ts` lines 40-77: exported function taking `(projectPath, leaseFence?)`, uses `withGlobalDatabase`.

These have different signatures, different DB access patterns, and subtly different owner-resolution logic. AGENTS.md requires "two code paths that answer the same invariant question must share one source of truth."

**Action:** Kill the one in `orchestrator-loop.ts`. The one in `loop-phases-helpers.ts` already handles the no-parallel-session fast path (`if (!leaseFence?.parallelSessionId) return true`). Update `orchestrator-loop.ts` to import and call it instead. The caller in `orchestrator-loop.ts` already constructs a `LeaseFenceContext`-shaped object at the call sites, so the adapter is trivial.

Then extract the guard pattern. The pattern `if (!refreshParallelWorkstreamLease(...)) { log + return }` appears **7 times** across coder and reviewer phases. Extract:

```typescript
function assertLeaseOwnership(
  projectPath: string, leaseFence: LeaseFenceContext | undefined, jsonMode: boolean,
  context: string  // e.g. "before coder phase", "before decision execution"
): boolean
```

---

## Implementation Order

1. **Phase 7 first** — Lease guard extraction. Mechanical, zero-risk, immediately reduces noise across all files.
2. **Phase 1** — Orchestrator loop. Highest visibility, most benefit for day-to-day debugging.
3. **Phase 3** — Coder decision deduplication. submit/stage_commit_submit copy-paste is the worst offender.
4. **Phase 4** — Reviewer failure classification dedup. Same pattern duplicated in two branches.
5. **Phase 2** — Coder phase pipeline decomposition. Largest single function; depends on phases 3 and 7.
6. **Phase 5** — Reviewer resolution. Lower priority since the resolution module is already relatively focused.
7. **Phase 6** — Session resume dedup. Touches coder.ts and reviewer.ts which are in the orchestrator module; save for last.

Phases have weak dependencies (Phase 2 depends on 3 and 7 being complete) but each phase can be merged independently. No phase changes external behavior or task flow.

**Constraints across phases:**
- Phase 3 must not change the public signature of `executeCoderDecision`.
- When a file is already above 450 lines, new helper functions go into an adjacent helper file (e.g., `orchestrator-loop-guards.ts`, `loop-phases-coder-helpers.ts`), not into the main file. This prevents exceeding the 500-line limit.
- The reviewer resolution fallback dedup (Phase 5, `tryExplicitDecisionFallback`) must preserve the confidence difference: `medium` when orchestrator returned unclear, `low` when orchestrator threw an error.

---

## Edge Cases

| Scenario | Handling |
|----------|----------|
| Extracted method needs to return multiple signals (e.g., "stop loop" vs "continue" vs "break with credit") | Return a discriminated union: `{ action: 'continue' } \| { action: 'break' } \| { action: 'credit', result: CreditExhaustionResult }` |
| Extracted method needs access to many closure variables | Pass a context object. If the context exceeds 5 fields, the function is still too broad — split further. |
| Method names become too long | Prefer verb-noun: `enforceInvocationCap`, `classifyCoderFailure`, `passPostCoderGate`. Avoid encoding the full condition in the name. |
| Tests break because internal flow changed | No behavioral change. All tests should remain green. If a test directly asserts on console output or internal function calls, it may need updating — but the audit trail and task state transitions stay identical. |

---

## Non-Goals

- **No new abstractions.** This is not about creating a pipeline framework or plugin system. It is about extracting named functions.
- **No behavior changes.** Every extracted method must preserve the exact same control flow, side effects, and error handling. If a bug is found during extraction, fix it in a separate commit.
- **No file restructuring.** Methods stay in their current files (or adjacent helpers). We are not reorganizing the module hierarchy.
- **No type changes.** Existing interfaces (`CoderOrchestrationResult`, `CreditExhaustionResult`, etc.) remain unchanged.
- **No config changes.** No new settings, thresholds, or flags.

---

## Metrics

Before/after for each phase, measured by:

1. **Max function length** — target: no function exceeds 100 lines (currently several exceed 300). The 80-line ideal applies to most functions, but `invokeCoordinatorIfNeeded` (128 lines of cohesive coordinator logic) and `applyDecisionGuardrails` (~100 lines of sequential guardrail checks) may stay at ~100 lines rather than splitting into a confusing web of tiny helpers. If a function exceeds 100 lines, it must contain a single cohesive concern with documented justification.
2. **Max nesting depth** — target: no block exceeds 3 levels (currently up to 5-6 levels).
3. **Duplicate code blocks** — target: zero duplicated blocks >10 lines (currently 3 major duplications).
4. **Named-method coverage of conditionals** — target: every `if` in the main loop body is either a single-line guard (`if (!x) return`) or a call to a named method that returns a boolean/result.
5. **File line count** — target: no file exceeds 500 lines. If extracting helpers into the same file would push it over, use an adjacent helper file.

---

## Cross-Provider Review

**Reviewers:** Claude (`superpowers:code-reviewer`) and Gemini (`gemini -p`)
**Date:** 2026-03-23

### Finding 1: Two `refreshParallelWorkstreamLease` implementations (Claude Critical, Gemini implicit)
**Assessment:** Valid. Two implementations with different signatures and DB patterns answering the same invariant. Violates AGENTS.md single-source-of-truth.
**Decision:** ADOPT. Added to Phase 7 as a prerequisite — kill the one in `orchestrator-loop.ts`, use `loop-phases-helpers.ts` version everywhere.

### Finding 2: submit/stage_commit_submit dedup has three paths, not two (Claude Critical, Gemini Critical)
**Assessment:** Valid. Three distinct reason strings, a mid-block lease check, and three execution paths. A single `executeSubmission({ autoCommit: boolean })` wrapper would obscure the lease check and produce incorrect reason strings.
**Decision:** ADOPT. Replaced the `executeSubmission` wrapper proposal with three shared sub-functions (`resolveAndValidateSubmissionCommit`, `pushIfLegacyWorkstream`, `writeAndConfirmDurableSubmission`) called from both switch cases. Switch cases remain as thin dispatchers.

### Finding 3: `clearTaskFailureCount` placement unspecified (Claude Important, Gemini implicit)
**Assessment:** Valid. Four distinct call sites with different preconditions (coder non-pool, reviewer multi-success, reviewer single-success, pool cleanup). Burying in extracted helpers would reorder side effects.
**Decision:** ADOPT. Added explicit documentation of all four call sites to Phases 3 and 4.

### Finding 4: `classifyReviewerFailure` signature needs resolved provider/model names (Claude Important)
**Assessment:** Valid. Multi-path resolves from `failedConfig`, single-path from `reviewerResult`. The helper cannot re-derive these without duplicating resolution logic.
**Decision:** ADOPT. Updated signature to `(result, providerName, modelName, projectPath)`.

### Finding 5: 80-line target unrealistic for some functions (Claude Important, Gemini Important)
**Assessment:** Valid. `invokeCoordinatorIfNeeded` (128 lines) and `applyDecisionGuardrails` (~100 lines) contain cohesive business logic. Forcing 80 lines would create many tiny helpers that hurt readability.
**Decision:** ADOPT. Relaxed to 100 lines with justification. 80 remains the ideal for most functions.

### Finding 6: Adding helpers will push files past 500-line limit (Claude Important)
**Assessment:** Valid. `orchestrator-loop.ts` is already at 496 lines.
**Decision:** ADOPT. Added constraint: when a file is above 450 lines, new helpers go into adjacent files.

### Finding 7: Phase 3 must not change `executeCoderDecision` signature (Claude Important, Gemini implicit)
**Assessment:** Valid. Phase 2 depends on Phase 3. Changing the public API during Phase 3 would break the intermediate state.
**Decision:** ADOPT. Added explicit constraint.

### Finding 8: Explicit-decision fallback confidence difference (Claude Suggestion)
**Assessment:** Valid. Single-reviewer path uses `medium` confidence when orchestrator returned unclear but reviewer had explicit token (line 282), `low` when orchestrator threw (line 309). Both must be preserved.
**Decision:** ADOPT. Added constraint to Phase 5.

### Finding 9: Missing catalog entries (Claude Suggestion, Gemini Important)
**Assessment:** Valid. Missing: `initialSha` fallback chain (coder line 128), `hasRelevantChanges` composition (coder line 230), reject-case out-of-scope extraction (reviewer lines 432-441), `cleanupPoolSlot` conditional tree (orchestrator-loop lines 38-80).
**Decision:** ADOPT. Added missing entries to the relevant catalog sections.

### Finding 10: `cleanupPoolSlot` conditional tree not analyzed (Gemini Important)
**Assessment:** Valid. `cleanupPoolSlot` (orchestrator-loop lines 38-80) contains task status rollback logic (`awaiting_review` -> `pending`/`skipped` on push failure) that the design must preserve. This function is already extracted — no further work needed, but its contract must be preserved when `cleanupIterationResources` wraps it.
**Decision:** DEFER. `cleanupPoolSlot` is already a named function. The wrapper `cleanupIterationResources` calls it — no logic change needed. Add a comment documenting the rollback contract.

### Finding 11: Phase independence overstated (Gemini, Claude)
**Assessment:** Partially valid. Phases have weak dependencies but are still independently mergeable because no phase changes public APIs (constraint added).
**Decision:** ADOPT. Softened the language from "independently mergeable, no dependencies" to "weak dependencies, independently mergeable because no public API changes."
