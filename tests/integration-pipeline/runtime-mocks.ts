import { jest } from '@jest/globals';
import type { SteroidsConfig } from '../../src/config/loader.js';
import {
  consumeScenarioValue,
  getActiveGitState,
  getGitStateForTask,
  getScenarioByTask,
  getScenarioIdByTask,
  type IntegrationHarnessState,
} from './harness.js';
import {
  type MockCoordinatorResult,
  type MockOrchestratorResult,
  type MockReviewerResponse,
  coderSuccess,
  orchReview,
  reviewerApprove,
  reviewerDecision,
} from './scenarios.js';
import { classifyMockResult } from './mock-classifier.js';
import {
  getReviewerConfigs,
  resolveDecision,
} from '../../src/orchestrator/reviewer-policy.js';

export const mockInvokeCoder = jest.fn<(...args: any[]) => any>();
export const mockInvokeCoordinator = jest.fn<(...args: any[]) => any>();
export const mockInvokeReviewer = jest.fn<(...args: any[]) => any>();
export const mockInvokeReviewers = jest.fn<(...args: any[]) => any>();
export const mockInvokeCoderOrchestrator = jest.fn<(...args: any[]) => any>();
export const mockInvokeReviewerOrchestrator = jest.fn<(...args: any[]) => any>();
export const mockInvokeMultiReviewerOrchestrator = jest.fn<(...args: any[]) => any>();
export const mockTriggerTaskCompleted = jest.fn(async (): Promise<unknown[]> => []);
export const mockTriggerSectionCompleted = jest.fn(async (): Promise<unknown[]> => []);
export const mockTriggerProjectCompleted = jest.fn(async (): Promise<unknown[]> => []);
export const mockTriggerCreditExhausted = jest.fn(async (): Promise<unknown[]> => []);
export const mockTriggerCreditResolved = jest.fn(async (): Promise<unknown[]> => []);
export const mockTriggerHooksSafely = jest.fn(async (triggerFn: () => Promise<unknown[]>) => {
  await triggerFn();
});
export const mockCheckSectionCompletionAndPR = jest.fn(async (): Promise<number | null> => null);
export const mockGetProviderBackoffRemainingMs = jest.fn(() => 0);
export const mockRecordProviderBackoff = jest.fn();

export const HARNESS_PROJECT_PATH = '/mock/project';
export const HARNESS_CONFIG: SteroidsConfig = {
  ai: {
    coder: { provider: 'codex', model: 'mock-coder' },
    reviewer: { provider: 'claude', model: 'mock-reviewer' },
    reviewers: [
      { provider: 'claude', model: 'mock-reviewer-a' },
      { provider: 'gemini', model: 'mock-reviewer-b' },
    ],
    orchestrator: { provider: 'codex', model: 'mock-orchestrator' },
  },
  git: { branch: 'main' },
};

let harnessState: IntegrationHarnessState | null = null;
let multiReviewEnabled = false;

function requireHarnessState(): IntegrationHarnessState {
  if (!harnessState) {
    throw new Error('Harness state has not been initialised.');
  }
  return harnessState;
}

export function setHarnessMultiReviewEnabled(enabled: boolean): void {
  multiReviewEnabled = enabled;
}

export function clearHarnessRuntimeState(): void {
  harnessState = null;
  multiReviewEnabled = false;
}

jest.unstable_mockModule('../../src/orchestrator/coder.js', () => ({
  invokeCoder: mockInvokeCoder,
  resolveEffectiveCoderConfig: jest.fn(() => ({ provider: 'mock', model: 'mock-coder' })),
}));

jest.unstable_mockModule('../../src/orchestrator/coordinator.js', () => ({
  invokeCoordinator: mockInvokeCoordinator,
}));

jest.unstable_mockModule('../../src/orchestrator/reviewer.js', () => {
  return {
    invokeReviewer: mockInvokeReviewer,
    invokeReviewers: mockInvokeReviewers,
    getReviewerConfigs,
    resolveDecision,
    isMultiReviewEnabled: jest.fn(() => multiReviewEnabled),
  };
});

jest.unstable_mockModule('../../src/orchestrator/invoke.js', () => ({
  invokeCoderOrchestrator: mockInvokeCoderOrchestrator,
  invokeReviewerOrchestrator: mockInvokeReviewerOrchestrator,
  invokeMultiReviewerOrchestrator: mockInvokeMultiReviewerOrchestrator,
}));

jest.unstable_mockModule('../../src/git/status.js', () => ({
  getCurrentCommitSha: jest.fn(() => getActiveGitState(requireHarnessState()).currentSha),
  getRecentCommits: jest.fn(() => getActiveGitState(requireHarnessState()).recentCommits),
  getChangedFiles: jest.fn(() => getActiveGitState(requireHarnessState()).changedFiles),
  hasUncommittedChanges: jest.fn(() => getActiveGitState(requireHarnessState()).hasUncommitted),
  getDiffSummary: jest.fn(() => getActiveGitState(requireHarnessState()).diffSummary),
  getModifiedFiles: jest.fn(() => getActiveGitState(requireHarnessState()).modifiedFiles),
  getDiffStats: jest.fn(() => getActiveGitState(requireHarnessState()).diffStats),
  isCommitReachable: jest.fn((_projectPath: string, sha: string) => {
    const gitState = getActiveGitState(requireHarnessState());
    return gitState.isReachable && sha === gitState.currentSha;
  }),
  isCommitReachableWithFetch: jest.fn((_projectPath: string, sha: string) => {
    const gitState = getActiveGitState(requireHarnessState());
    return gitState.isReachable && sha === gitState.currentSha;
  }),
}));

jest.unstable_mockModule('../../src/git/push.js', () => ({
  pushToRemote: jest.fn(() => ({
    success: true,
    commitHash: getActiveGitState(requireHarnessState()).currentSha,
  })),
}));

jest.unstable_mockModule('../../src/providers/registry.js', () => ({
  getProviderRegistry: jest.fn(async () => {
    const provider = {
      classifyResult: classifyMockResult,
      classifyError: (_exitCode: number, stderr: string) =>
        classifyMockResult({ success: false, stderr, stdout: '', exitCode: 1 }),
      isAvailable: jest.fn(async () => true),
    };
    return {
      tryGet: jest.fn(() => provider),
      get: jest.fn(() => provider),
    };
  }),
}));

jest.unstable_mockModule('../../src/runners/global-db.js', () => ({
  withGlobalDatabase: jest.fn((callback: (db: object) => unknown) => callback({})),
  getProviderBackoffRemainingMs: mockGetProviderBackoffRemainingMs,
  recordProviderBackoff: mockRecordProviderBackoff,
}));

jest.unstable_mockModule('../../src/config/loader.js', () => ({
  loadConfig: jest.fn(() => HARNESS_CONFIG),
}));

jest.unstable_mockModule('../../src/workspace/git-lifecycle.js', () => ({
  prepareForTask: jest.fn(() => ({
    ok: true,
    startingSha: 'seed-sha',
    taskBranch: 'task/mock',
    baseBranch: 'main',
  })),
  postCoderGate: jest.fn(() => ({ ok: true, autoCommitted: false })),
  postReviewGate: jest.fn(),
}));

jest.unstable_mockModule('../../src/workspace/pool.js', () => ({
  updateSlotStatus: jest.fn(),
  releaseSlot: jest.fn(),
}));

jest.unstable_mockModule('../../src/git/branch-resolver.js', () => ({
  resolveEffectiveBranch: jest.fn(() => 'main'),
}));

jest.unstable_mockModule('../../src/hooks/integration.js', () => ({
  triggerTaskCompleted: mockTriggerTaskCompleted,
  triggerSectionCompleted: mockTriggerSectionCompleted,
  triggerProjectCompleted: mockTriggerProjectCompleted,
  triggerCreditExhausted: mockTriggerCreditExhausted,
  triggerCreditResolved: mockTriggerCreditResolved,
  triggerHooksSafely: mockTriggerHooksSafely,
}));

jest.unstable_mockModule('../../src/git/section-pr.js', () => ({
  checkSectionCompletionAndPR: mockCheckSectionCompletionAndPR,
}));

jest.unstable_mockModule('../../src/commands/submission-transition.js', () => ({
  submitForReviewWithDurableRef: jest.fn(
    (db: any, taskId: string, actor: string, _projectPath: string, commitSha: string, notes: string) => {
      const state = requireHarnessState();
      const scenarioId = getScenarioIdByTask(state, taskId);
      if (scenarioId === 'submission-durable-write-fail') {
        return { ok: false, error: 'mock durable ref write failed' };
      }

      const task = db.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId) as { status: string };
      db.prepare(
        `UPDATE tasks
         SET status = 'review',
             updated_at = datetime('now')
         WHERE id = ?`,
      ).run(taskId);
      db.prepare(
        `INSERT INTO audit (task_id, from_status, to_status, actor, actor_type, notes, commit_sha, created_at)
         VALUES (?, ?, 'review', ?, 'orchestrator', ?, ?, datetime('now'))`,
      ).run(taskId, task.status, actor, notes, commitSha);

      return { ok: true };
    },
  ),
}));

jest.unstable_mockModule('../../src/commands/push-task-branch.js', () => ({
  pushTaskBranchForDurability: jest.fn(async () => ({ ok: true })),
}));

jest.unstable_mockModule('../../src/commands/reviewer-preflight.js', () => ({
  runReviewerSubmissionPreflight: jest.fn((_db: object, task: { id: string }) => ({
    ok: true,
    submissionCommitSha: getGitStateForTask(requireHarnessState(), task.id).currentSha,
  })),
}));

jest.unstable_mockModule('../../src/commands/loop-phases-reviewer-follow-ups.js', () => ({
  createFollowUpTasksIfNeeded: jest.fn(async () => undefined),
}));

jest.unstable_mockModule('../../src/git/submission-durability.js', () => ({
  readDurableSubmissionRef: jest.fn(() => null),
}));

jest.unstable_mockModule('../../src/git/submission-resolution.js', () => ({
  resolveSubmissionCommitWithRecovery: jest.fn((_projectPath: string, shas: string[]) => ({
    status: shas.length > 0 ? 'resolved' : 'missing',
    sha: shas[0] ?? null,
    attempts: shas,
  })),
  resolveSubmissionCommitHistoryWithRecovery: jest.fn((_projectPath: string, shas: string[]) => ({
    latestReachableSha: shas[0] ?? null,
    reachableShasOldestFirst: [...shas].reverse(),
    unreachableShas: [],
    attempts: shas,
  })),
}));

export function wireScenarioMocks(state: IntegrationHarnessState): void {
  harnessState = state;
  multiReviewEnabled = false;

  mockInvokeCoder.mockReset();
  mockInvokeCoordinator.mockReset();
  mockInvokeReviewer.mockReset();
  mockInvokeReviewers.mockReset();
  mockInvokeCoderOrchestrator.mockReset();
  mockInvokeReviewerOrchestrator.mockReset();
  mockInvokeMultiReviewerOrchestrator.mockReset();

  mockInvokeCoder.mockImplementation(
    (task: { id: string }, _projectPath: string, _action: string, guidance?: string) => {
      const scenario = getScenarioByTask(state, task.id);
      const guidanceLog = state.coderGuidanceByTask.get(task.id) ?? [];
      guidanceLog.push(guidance ?? '');
      state.coderGuidanceByTask.set(task.id, guidanceLog);
      return consumeScenarioValue(state, task.id, 'coder', scenario.coder, coderSuccess());
    },
  );

  mockInvokeCoordinator.mockImplementation((task: { id: string; rejection_count: number }) => {
    const scenario = getScenarioByTask(state, task.id);
    const result = consumeScenarioValue<MockCoordinatorResult>(
      state,
      task.id,
      'coordinator',
      scenario.coordinator,
      { success: true, decision: 'guide_coder', guidance: 'Generic coordinator guidance.' },
    );
    const scenarioId = getScenarioIdByTask(state, task.id);
    if ('throws' in result) {
      state.coordinatorCalls.push({
        taskId: task.id,
        scenarioId,
        rejectionCount: task.rejection_count,
        threw: true,
      });
      throw new Error(result.throws);
    }
    state.coordinatorCalls.push({
      taskId: task.id,
      scenarioId,
      rejectionCount: task.rejection_count,
      decision: result.decision,
      guidance: result.guidance,
    });
    return result;
  });

  mockInvokeReviewer.mockImplementation((task: { id: string }) => {
    const scenario = getScenarioByTask(state, task.id);
    const result = consumeScenarioValue<MockReviewerResponse>(
      state,
      task.id,
      'reviewer',
      scenario.reviewer,
      reviewerApprove(),
    );
    return {
      provider: result.provider ?? 'mock',
      model: result.model ?? 'mock-reviewer',
      ...result,
    };
  });

  mockInvokeReviewers.mockImplementation(
    (
      task: { id: string },
      _projectPath: string,
      configs: Array<{ provider?: string; model?: string }>,
    ) => {
      const scenario = getScenarioByTask(state, task.id);
      const results = consumeScenarioValue<MockReviewerResponse[]>(
        state,
        task.id,
        'reviewers',
        scenario.reviewers,
        [
          reviewerApprove('DECISION: APPROVE\nReviewer A approves.'),
          reviewerApprove('DECISION: APPROVE\nReviewer B approves.'),
        ],
      );
      return results.map((result, index) => ({
        provider: result.provider ?? configs[index]?.provider ?? `mock-reviewer-${index + 1}`,
        model: result.model ?? configs[index]?.model ?? `mock-reviewer-${index + 1}`,
        ...result,
      }));
    },
  );

  mockInvokeCoderOrchestrator.mockImplementation((context: { task: { id: string } }) => {
    const scenario = getScenarioByTask(state, context.task.id);
    const result = consumeScenarioValue<MockOrchestratorResult>(
      state,
      context.task.id,
      'coderOrchestrator',
      scenario.coderOrchestrator,
      orchReview(),
    );
    if ('throws' in result) {
      throw new Error(result.throws);
    }
    return result.output;
  });

  mockInvokeReviewerOrchestrator.mockImplementation((context: { task: { id: string } }) => {
    const scenario = getScenarioByTask(state, context.task.id);
    const result = consumeScenarioValue<MockOrchestratorResult>(
      state,
      context.task.id,
      'reviewerOrchestrator',
      scenario.reviewerOrchestrator,
      reviewerDecision('approve', 'Approved.'),
    );
    if ('throws' in result) {
      throw new Error(result.throws);
    }
    return result.output;
  });

  mockInvokeMultiReviewerOrchestrator.mockImplementation((context: { task: { id: string } }) => {
    const scenario = getScenarioByTask(state, context.task.id);
    const result = consumeScenarioValue<MockOrchestratorResult>(
      state,
      context.task.id,
      'multiReviewerOrchestrator',
      scenario.multiReviewerOrchestrator,
      reviewerDecision('approve', 'Approved.'),
    );
    if ('throws' in result) {
      throw new Error(result.throws);
    }
    return result.output;
  });
}
