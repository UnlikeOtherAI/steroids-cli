import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  HARNESS_SOURCE_FILE,
  createHarnessState,
  getGitStateForTask,
  getTaskIdForScenario,
  type IntegrationHarnessState,
} from './integration-pipeline/harness.js';
import {
  EXPECTED_TERMINAL_STATUS,
  SCENARIO_ORDER,
} from './integration-pipeline/scenarios.js';
import {
  HARNESS_CONFIG,
  HARNESS_PROJECT_PATH,
  clearHarnessRuntimeState,
  mockCheckSectionCompletionAndPR,
  mockInvokeMultiReviewerOrchestrator,
  mockInvokeReviewerOrchestrator,
  mockInvokeReviewers,
  mockRecordProviderBackoff,
  mockTriggerCreditExhausted,
  mockTriggerProjectCompleted,
  mockTriggerSectionCompleted,
  mockTriggerTaskCompleted,
  setHarnessMultiReviewEnabled,
  wireScenarioMocks,
} from './integration-pipeline/runtime-mocks.js';
import { executeHarnessRun } from './integration-pipeline/run-harness.js';

const DOCUMENTED_HARNESS_SPEC_FILE = 'docs/done/2026-03-26-integration-test-harness.md';

const { runCoderPhase } = await import('../src/commands/loop-phases-coder.js');
const { runReviewerPhase } = await import('../src/commands/loop-phases-reviewer.js');
const { completeMergePendingTask } = await import('../src/orchestrator/merge-queue-completion.js');
const { handleCreditExhaustion, handleAuthError } = await import('../src/runners/credit-pause.js');
const { SCHEMA_SQL } = await import('../src/database/schema.js');
const queries = await import('../src/database/queries.js');
const taskSelector = await import('../src/orchestrator/task-selector.js');

async function runFullHarness() {
  const state = createHarnessState(SCHEMA_SQL, queries);
  wireScenarioMocks(state);

  return executeHarnessRun({
    state,
    runCoderPhase,
    runReviewerPhase,
    completeMergePendingTask,
    taskSelector,
    queries,
    pauseHandlers: {
      handleCreditExhaustion,
      handleAuthError,
    },
    setMultiReviewEnabled: setHarnessMultiReviewEnabled,
    projectPath: HARNESS_PROJECT_PATH,
    buildMergeCompletionOptions: (taskId) => ({
      config: HARNESS_CONFIG,
      projectPath: HARNESS_PROJECT_PATH,
      intakeProjectPath: HARNESS_PROJECT_PATH,
      mergedSha: getGitStateForTask(state, taskId).currentSha,
      notes: 'Merged by integration harness',
    }),
  });
}

function getTaskByScenario(state: IntegrationHarnessState, scenarioId: keyof typeof EXPECTED_TERMINAL_STATUS) {
  return queries.getTask(state.db, getTaskIdForScenario(state, scenarioId));
}

function getAuditCategories(state: IntegrationHarnessState, taskId: string): string[] {
  return (
    state.db
      .prepare(
        `SELECT category
         FROM audit
         WHERE task_id = ?
           AND category IS NOT NULL
         ORDER BY id ASC`,
      )
      .all(taskId) as Array<{ category: string }>
  ).map((row) => row.category);
}

function getLatestStatusAuditNote(state: IntegrationHarnessState, taskId: string, toStatus: string): string {
  const row = state.db
    .prepare(
      `SELECT notes
       FROM audit
       WHERE task_id = ?
         AND to_status = ?
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(taskId, toStatus) as { notes: string | null } | undefined;

  if (!row?.notes) {
    throw new Error(`No audit note found for task ${taskId} -> ${toStatus}`);
  }

  return row.notes;
}

function getLatestDecisionAudit(state: IntegrationHarnessState, taskId: string): {
  error_code: string | null;
  notes: string | null;
} {
  const row = state.db
    .prepare(
      `SELECT error_code, notes
       FROM audit
       WHERE task_id = ?
         AND category = 'decision'
       ORDER BY id DESC
       LIMIT 1`,
    )
    .get(taskId) as { error_code: string | null; notes: string | null } | undefined;

  if (!row) {
    throw new Error(`No decision audit row found for task ${taskId}`);
  }

  return row;
}

function getDocumentedScenarioMatrix(): Array<{ id: string; expected: string }> {
  if (HARNESS_SOURCE_FILE !== DOCUMENTED_HARNESS_SPEC_FILE) {
    throw new Error(
      `Harness seeds ${HARNESS_SOURCE_FILE}, but the documented spec is ${DOCUMENTED_HARNESS_SPEC_FILE}.`,
    );
  }

  const markdown = readFileSync(resolve(process.cwd(), DOCUMENTED_HARNESS_SPEC_FILE), 'utf8');
  const start = markdown.indexOf('### The 50 Scenarios');
  const end = markdown.indexOf('### Test Structure');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Unable to locate scenario matrix in ${DOCUMENTED_HARNESS_SPEC_FILE}`);
  }

  const scenarioSection = markdown.slice(start, end);
  return Array.from(
    scenarioSection.matchAll(
      /^\|\s*\d+\s*\|\s*`([^`]+)`\s*\|.*\|\s*`([^`]+)`(?:\s*\([^|]+\))?\s*\|$/gm,
    ),
    ([, id, expected]) => ({ id, expected }),
  );
}

afterEach(() => {
  clearHarnessRuntimeState();
  jest.restoreAllMocks();
  jest.clearAllMocks();
});

beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
});

describe('integration pipeline harness', () => {
  it('matches the documented scenario matrix exactly', () => {
    const documented = getDocumentedScenarioMatrix();
    const documentedExpected = Object.fromEntries(
      documented.map(({ id, expected }) => [id, expected]),
    );

    expect(documented).toHaveLength(SCENARIO_ORDER.length);
    expect(documented.map(({ id }) => id)).toEqual([...SCENARIO_ORDER]);
    expect(documentedExpected).toEqual(EXPECTED_TERMINAL_STATUS);
  });

  it('routes all scenarios to their expected terminal states', async () => {
    const result = await runFullHarness();

    expect(result.iterations).toBeLessThan(result.maxIterations);
    expect(result.remaining).toBeNull();

    for (const [scenarioId, expected] of Object.entries(EXPECTED_TERMINAL_STATUS)) {
      const task = getTaskByScenario(result.state, scenarioId as keyof typeof EXPECTED_TERMINAL_STATUS);
      expect(task?.status).toBe(expected);
    }
  });

  it('seeds harness tasks from the completed design doc and runs real approval effects on merge completion', async () => {
    const result = await runFullHarness();
    const taskId = getTaskIdForScenario(result.state, 'happy-simple');
    const task = queries.getTask(result.state.db, taskId);
    const categories = getAuditCategories(result.state, taskId);

    expect(task?.source_file).toBe(HARNESS_SOURCE_FILE);
    expect(categories).toEqual(
      expect.arrayContaining([
        'approval_effects_pending',
        'approval_effect_step_applied',
        'approval_effects_applied',
      ]),
    );
    expect(mockTriggerTaskCompleted).toHaveBeenCalled();
    expect(mockTriggerSectionCompleted).toHaveBeenCalled();
    expect(mockTriggerProjectCompleted).not.toHaveBeenCalled();
    expect(mockCheckSectionCompletionAndPR).toHaveBeenCalled();
  });

  it('proves multi-review scenarios invoke the parallel reviewer path and arbitration when required', async () => {
    const result = await runFullHarness();
    const multiReviewTaskIds = [
      getTaskIdForScenario(result.state, 'happy-multi-review'),
      getTaskIdForScenario(result.state, 'multi-reviewer-arbitrate'),
      getTaskIdForScenario(result.state, 'multi-reviewer-partial-fail'),
      getTaskIdForScenario(result.state, 'multi-reviewer-all-fail'),
    ];
    const invokedTaskIds = Array.from(
      new Set(
        mockInvokeReviewers.mock.calls.map((call) => (call[0] as { id: string }).id),
      ),
    );
    const arbitrationTaskIds = Array.from(
      new Set(
        mockInvokeMultiReviewerOrchestrator.mock.calls.map(
          (call) => (call[0] as { task: { id: string } }).task.id,
        ),
      ),
    );
    const reviewerOrchestratorTaskIds = Array.from(
      new Set(
        mockInvokeReviewerOrchestrator.mock.calls.map(
          (call) => (call[0] as { task: { id: string } }).task.id,
        ),
      ),
    );
    const partialFailTaskId = getTaskIdForScenario(result.state, 'multi-reviewer-partial-fail');

    expect(new Set(invokedTaskIds)).toEqual(new Set(multiReviewTaskIds));
    expect(arbitrationTaskIds).toEqual([getTaskIdForScenario(result.state, 'multi-reviewer-arbitrate')]);
    expect(reviewerOrchestratorTaskIds).toContain(partialFailTaskId);
    expect(arbitrationTaskIds).not.toContain(partialFailTaskId);
  });

  it('creates the rejection-limit system dispute and hits coordinator thresholds 2, 5, 9', async () => {
    const result = await runFullHarness();
    const disputeTaskId = getTaskIdForScenario(result.state, 'reject-15x-failed');
    const disputeRows = result.state.db
      .prepare('SELECT type, reason FROM disputes WHERE task_id = ?')
      .all(disputeTaskId) as Array<{ type: string; reason: string }>;

    expect(disputeRows).toHaveLength(1);
    expect(disputeRows[0]).toEqual(expect.objectContaining({ type: 'system', reason: 'Exceeded 15 rejections' }));

    const coordinatorRejections = result.state.coordinatorCalls
      .filter((entry) => entry.scenarioId === 'reject-9x-coordinator')
      .map((entry) => entry.rejectionCount);
    expect(coordinatorRejections).toEqual([2, 5, 9]);
  });

  it('reuses cached coordinator guidance and persists MUST_IMPLEMENT overrides', async () => {
    const result = await runFullHarness();
    const cachedGuidance = result.state.coderGuidanceByTask.get(getTaskIdForScenario(result.state, 'reject-coordinator-cached')) ?? [];
    const mustImplementGuidance = result.state.coderGuidanceByTask.get(getTaskIdForScenario(result.state, 'reject-with-must-implement')) ?? [];
    const overrideTaskId = getTaskIdForScenario(result.state, 'reject-wontfix-override');
    const mustImplementAudit = result.state.db
      .prepare(
        `SELECT notes
         FROM audit
         WHERE task_id = ?
           AND actor = 'coordinator'
           AND category = 'must_implement'
         ORDER BY id ASC`,
      )
      .all(overrideTaskId) as Array<{ notes: string }>;

    expect(result.state.coordinatorCalls.filter((entry) => entry.scenarioId === 'reject-coordinator-cached')).toHaveLength(1);
    expect(cachedGuidance.slice(-2)).toEqual([
      'Cache this guidance for the next retry.',
      'Cache this guidance for the next retry.',
    ]);
    expect(mustImplementGuidance.some((guidance) => guidance.includes('MUST_IMPLEMENT:'))).toBe(true);
    expect(mustImplementAudit.some((row) => row.notes.includes('MUST_IMPLEMENT:'))).toBe(true);
  });

  it('captures credit and auth pauses as blocked_error terminal states', async () => {
    const result = await runFullHarness();
    const coderCredit = result.state.creditResults.get(getTaskIdForScenario(result.state, 'coder-credit-exhaustion')) as { action: string; role: string } | undefined;
    const coderRate = result.state.creditResults.get(getTaskIdForScenario(result.state, 'coder-rate-limit')) as { action: string; role: string } | undefined;
    const coderAuth = result.state.creditResults.get(getTaskIdForScenario(result.state, 'coder-auth-error')) as { action: string; role: string } | undefined;
    const reviewerCredit = result.state.creditResults.get(getTaskIdForScenario(result.state, 'reviewer-credit-exhaustion')) as { action: string; role: string } | undefined;
    const reviewerRate = result.state.creditResults.get(getTaskIdForScenario(result.state, 'reviewer-rate-limit')) as { action: string; role: string } | undefined;
    const reviewerAuth = result.state.creditResults.get(getTaskIdForScenario(result.state, 'reviewer-auth-error')) as { action: string; role: string } | undefined;
    const creditExhaustedCalls = mockTriggerCreditExhausted.mock.calls as unknown as Array<
      [{ role?: string }]
    >;
    const backoffReasons = mockRecordProviderBackoff.mock.calls.map((call) => call[3]);

    expect(coderCredit).toEqual(expect.objectContaining({ action: 'pause_credit_exhaustion', role: 'coder' }));
    expect(coderRate).toEqual(expect.objectContaining({ action: 'rate_limit', role: 'coder' }));
    expect(coderAuth).toEqual(expect.objectContaining({ action: 'pause_auth_error', role: 'coder' }));
    expect(reviewerCredit).toEqual(expect.objectContaining({ action: 'pause_credit_exhaustion', role: 'reviewer' }));
    expect(reviewerRate).toEqual(expect.objectContaining({ action: 'rate_limit', role: 'reviewer' }));
    expect(reviewerAuth).toEqual(expect.objectContaining({ action: 'pause_auth_error', role: 'reviewer' }));
    expect(creditExhaustedCalls.map(([payload]) => payload.role).sort()).toEqual([
      'coder',
      'coder',
      'reviewer',
      'reviewer',
    ]);
    expect(backoffReasons.filter((reason) => reason === 'capacity_exhaustion')).toHaveLength(4);
    expect(backoffReasons.filter((reason) => reason === 'auth_error')).toHaveLength(2);
  });

  it('pins submission and fatal-error scenarios to their actual failure branches', async () => {
    const result = await runFullHarness();
    const unreachableTaskId = getTaskIdForScenario(result.state, 'submission-commit-unreachable');
    const durableWriteTaskId = getTaskIdForScenario(result.state, 'submission-durable-write-fail');
    const fatalDecisionTaskId = getTaskIdForScenario(result.state, 'coder-error-decision');
    const zeroOutputTimeoutTaskId = getTaskIdForScenario(result.state, 'reviewer-zero-output-timeout');
    const zeroOutputDecision = getLatestDecisionAudit(result.state, zeroOutputTimeoutTaskId);

    expect(getLatestStatusAuditNote(result.state, unreachableTaskId, 'failed')).toContain(
      'cannot submit to review without a valid commit hash',
    );
    expect(getLatestStatusAuditNote(result.state, durableWriteTaskId, 'failed')).toContain(
      'durable submission write failed (mock durable ref write failed)',
    );
    expect(getLatestStatusAuditNote(result.state, fatalDecisionTaskId, 'failed')).toContain(
      'Task failed: Fatal implementation error',
    );
    expect(zeroOutputDecision.error_code).toBe('REVIEWER_ZERO_OUTPUT_TIMEOUT');
    expect(zeroOutputDecision.notes).toContain('Reviewer timed out with zero output');
  });

  it('preserves reviewer fallback and out-of-scope notes', async () => {
    const result = await runFullHarness();
    const fallbackTaskId = getTaskIdForScenario(result.state, 'happy-reviewer-fallback');
    const fallbackAudit = result.state.db
      .prepare(
        `SELECT notes
         FROM audit
         WHERE task_id = ?
           AND actor = 'orchestrator'
           AND category = 'decision'
         ORDER BY id DESC
         LIMIT 5`,
      )
      .all(fallbackTaskId) as Array<{ notes: string | null }>;

    const rejectionNotes = queries.getTaskRejections(
      result.state.db,
      getTaskIdForScenario(result.state, 'reject-out-of-scope'),
    );

    expect(fallbackAudit.some((row) => (row.notes ?? '').includes('FALLBACK: Orchestrator unclear but reviewer explicitly signaled APPROVE'))).toBe(true);
    expect(rejectionNotes[0]?.notes ?? '').toContain('[OUT_OF_SCOPE]');
  });

  it('keeps dependency-gated tasks from starting before their prerequisites finish', async () => {
    const result = await runFullHarness();
    const depSectionGatedId = getTaskIdForScenario(result.state, 'dep-section-gated');
    const depSectionGateId = getTaskIdForScenario(result.state, 'dep-section-gate');
    const depTaskGatedId = getTaskIdForScenario(result.state, 'dep-task-gated');
    const depTaskGateId = getTaskIdForScenario(result.state, 'dep-task-gate');

    const auditTime = (taskId: string, fromStatus: string | null, toStatus: string) =>
      (result.state.db
        .prepare(
          `SELECT created_at
           FROM audit
           WHERE task_id = ?
             AND ${fromStatus === null ? 'from_status IS NULL' : 'from_status = ?'}
             AND to_status = ?
           ORDER BY id ASC
           LIMIT 1`,
        )
        .get(...(fromStatus === null ? [taskId, toStatus] : [taskId, fromStatus, toStatus])) as { created_at: string }).created_at;

    expect(auditTime(depSectionGatedId, 'pending', 'in_progress') > auditTime(depSectionGateId, 'merge_pending', 'completed')).toBe(true);
    expect(auditTime(depTaskGatedId, 'pending', 'in_progress') > auditTime(depTaskGateId, 'merge_pending', 'completed')).toBe(true);
  });
});
