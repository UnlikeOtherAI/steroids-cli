// @ts-nocheck
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockApproveTask = jest.fn();
const mockUpdateTaskStatus = jest.fn();
const mockRejectTask = jest.fn();
const mockClearTaskFailureCount = jest.fn();
const mockClearMergeFailureCount = jest.fn();
const mockAddAuditEntry = jest.fn();
const mockHandleIntakeTaskApproval = jest.fn();
const mockPushToRemote = jest.fn();
const mockMergeToBase = jest.fn();
const mockGetSlot = jest.fn();
const mockReleaseSlot = jest.fn();
const mockUpdateSlotStatus = jest.fn();
const mockCheckSectionCompletionAndPR = jest.fn().mockResolvedValue(undefined);
const mockResolveReviewerDecision = jest.fn();
const mockInvokeReviewer = jest.fn();
const mockLoadConfig = jest.fn();

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTask: jest.fn(),
  updateTaskStatus: mockUpdateTaskStatus,
  approveTask: mockApproveTask,
  rejectTask: mockRejectTask,
  getTaskAudit: jest.fn().mockReturnValue([]),
  getFollowUpDepth: jest.fn().mockReturnValue(0),
  createFollowUpTask: jest.fn(),
  incrementTaskFailureCount: jest.fn(),
  clearTaskFailureCount: mockClearTaskFailureCount,
  clearMergeFailureCount: mockClearMergeFailureCount,
  addAuditEntry: mockAddAuditEntry,
}));

jest.unstable_mockModule('../src/orchestrator/reviewer.js', () => ({
  invokeReviewer: mockInvokeReviewer,
  invokeReviewers: jest.fn(),
  getReviewerConfigs: jest.fn(),
  isMultiReviewEnabled: jest.fn().mockReturnValue(false),
}));

jest.unstable_mockModule('../src/git/push.js', () => ({
  pushToRemote: mockPushToRemote,
}));

jest.unstable_mockModule('../src/git/status.js', () => ({
  getCurrentCommitSha: jest.fn().mockReturnValue('head-sha'),
  getModifiedFiles: jest.fn().mockReturnValue([]),
  getDiffStats: jest.fn().mockReturnValue({ additions: 0, deletions: 0 }),
}));

jest.unstable_mockModule('../src/commands/loop-phases-reviewer-resolution.js', () => ({
  resolveReviewerDecision: mockResolveReviewerDecision,
}));

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/git/branch-resolver.js', () => ({
  resolveEffectiveBranch: jest.fn().mockReturnValue('main'),
}));

jest.unstable_mockModule('../src/git/section-pr.js', () => ({
  checkSectionCompletionAndPR: mockCheckSectionCompletionAndPR,
}));

jest.unstable_mockModule('../src/providers/registry.js', () => ({
  getProviderRegistry: jest.fn(),
}));

jest.unstable_mockModule('../src/workspace/git-lifecycle.js', () => ({
  prepareForTask: jest.fn(),
  postCoderGate: jest.fn(),
  postReviewGate: jest.fn(),
  mergeToBase: mockMergeToBase,
}));

jest.unstable_mockModule('../src/workspace/pool.js', () => ({
  updateSlotStatus: mockUpdateSlotStatus,
  releaseSlot: mockReleaseSlot,
  getSlot: mockGetSlot,
}));

jest.unstable_mockModule('../src/workspace/merge-pipeline.js', () => ({
  handleMergeFailure: jest.fn(),
}));

jest.unstable_mockModule('../src/commands/loop-phases-helpers.js', () => ({
  extractOutOfScopeItems: jest.fn().mockReturnValue([]),
  refreshParallelWorkstreamLease: jest.fn().mockReturnValue(true),
  invokeWithLeaseHeartbeat: jest.fn().mockImplementation(async (_path, _lease, fn) => ({
    superseded: false,
    result: await fn(),
  })),
  MAX_ORCHESTRATOR_PARSE_RETRIES: 3,
  REVIEWER_PARSE_FALLBACK_MARKER: 'fallback',
  formatProviderFailureMessage: jest.fn(),
  handleProviderInvocationFailure: jest.fn(),
  countConsecutiveUnclearEntries: jest.fn().mockReturnValue(0),
}));

jest.unstable_mockModule('../src/commands/reviewer-preflight.js', () => ({
  runReviewerSubmissionPreflight: jest.fn().mockReturnValue({
    ok: true,
    submissionCommitSha: 'submission-sha',
  }),
}));

jest.unstable_mockModule('../src/commands/loop-phases-reviewer-follow-ups.js', () => ({
  createFollowUpTasksIfNeeded: jest.fn().mockResolvedValue(undefined),
}));

jest.unstable_mockModule('../src/intake/reviewer-approval.js', () => ({
  handleIntakeTaskApproval: mockHandleIntakeTaskApproval,
}));

const { runReviewerPhase } = await import('../src/commands/loop-phases-reviewer.js');

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Triage intake report github#42: Checkout fails on empty cart',
    status: 'review',
    section_id: 'section-1',
    source_file: 'docs/plans/bug-intake/pipeline.md',
    file_path: null,
    file_line: null,
    file_commit_sha: null,
    file_content_hash: null,
    rejection_count: 0,
    created_at: '2026-03-13T00:00:00Z',
    updated_at: '2026-03-13T00:00:00Z',
    ...overrides,
  };
}

describe('runReviewerPhase intake glue wiring', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfig.mockReturnValue({
      ai: {
        reviewer: { provider: 'claude', model: 'sonnet' },
      },
      git: { branch: 'main' },
    });
    mockInvokeReviewer.mockResolvedValue({
      success: true,
      timedOut: false,
      stdout: 'approve',
      stderr: '',
    });
    mockResolveReviewerDecision.mockResolvedValue({
      decision: 'approve',
      reasoning: 'looks good',
      notes: 'approved',
      next_status: 'completed',
      confidence: 'high',
      push_to_remote: false,
    });
    mockHandleIntakeTaskApproval.mockReturnValue({ handled: true });
    mockPushToRemote.mockReturnValue({ success: true, commitHash: 'pushed-sha' });
    mockMergeToBase.mockReturnValue({ ok: true, mergedSha: 'merged-sha' });
    mockGetSlot.mockReturnValue({ id: 'slot-1' });
  });

  it('runs intake glue on the pool no-op approval path', async () => {
    mockInvokeReviewer.mockResolvedValue({
      success: true,
      timedOut: false,
      stdout: 'approve',
      stderr: '',
      isNoOp: true,
    });

    await runReviewerPhase(
      {},
      makeTask(),
      '/project',
      true,
      undefined,
      'main',
      undefined,
      {
        globalDb: {},
        slot: { id: 'slot-1', slot_path: '/slot' },
      }
    );

    expect(mockApproveTask).toHaveBeenCalled();
    expect(mockHandleIntakeTaskApproval).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'task-1' }), '/slot');
  });

  it('runs intake glue on the pool merge approval path', async () => {
    mockInvokeReviewer.mockResolvedValue({
      success: true,
      timedOut: false,
      stdout: 'approve',
      stderr: '',
      isNoOp: false,
    });

    await runReviewerPhase(
      {},
      makeTask(),
      '/project',
      true,
      undefined,
      'main',
      undefined,
      {
        globalDb: {},
        slot: { id: 'slot-1', slot_path: '/slot' },
      }
    );

    expect(mockMergeToBase).toHaveBeenCalled();
    expect(mockHandleIntakeTaskApproval).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'task-1' }), '/slot');
  });

  it('runs intake glue only after a successful legacy push', async () => {
    await runReviewerPhase({}, makeTask(), '/project', true);

    expect(mockPushToRemote).toHaveBeenCalled();
    expect(mockHandleIntakeTaskApproval).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: 'task-1' }), '/project');
  });

  it('skips intake glue when the legacy push fails', async () => {
    mockPushToRemote.mockReturnValue({ success: false, commitHash: null });

    await runReviewerPhase({}, makeTask(), '/project', true);

    expect(mockHandleIntakeTaskApproval).not.toHaveBeenCalled();
  });
});
