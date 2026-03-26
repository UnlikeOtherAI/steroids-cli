// @ts-nocheck
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockApproveTask = jest.fn();
const mockUpdateTaskStatus = jest.fn();
const mockRejectTask = jest.fn();
const mockClearTaskFailureCount = jest.fn();
const mockAddAuditEntry = jest.fn();
const mockResolveReviewerDecision = jest.fn();
const mockInvokeReviewer = jest.fn();
const mockLoadConfig = jest.fn();
const mockReleaseSlot = jest.fn();
const mockApplyApprovedOutcome = jest.fn().mockResolvedValue(undefined);
const mockDeriveApprovedOutcome = jest.fn();
const mockLoadSubmissionContext = jest.fn();

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTask: jest.fn(),
  updateTaskStatus: mockUpdateTaskStatus,
  approveTask: mockApproveTask,
  rejectTask: mockRejectTask,
  getTaskAudit: jest.fn().mockReturnValue([]),
  incrementTaskFailureCount: jest.fn(),
  clearTaskFailureCount: mockClearTaskFailureCount,
  addAuditEntry: mockAddAuditEntry,
}));

jest.unstable_mockModule('../src/orchestrator/reviewer.js', () => ({
  invokeReviewer: mockInvokeReviewer,
  invokeReviewers: jest.fn(),
  getReviewerConfigs: jest.fn(),
  isMultiReviewEnabled: jest.fn().mockReturnValue(false),
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

jest.unstable_mockModule('../src/providers/registry.js', () => ({
  getProviderRegistry: jest.fn(),
}));

jest.unstable_mockModule('../src/workspace/git-lifecycle.js', () => ({
  prepareForTask: jest.fn(),
  postReviewGate: jest.fn(),
}));

jest.unstable_mockModule('../src/workspace/pool.js', () => ({
  updateSlotStatus: jest.fn(),
  releaseSlot: mockReleaseSlot,
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

jest.unstable_mockModule('../src/orchestrator/reviewer-approval-outcome.js', () => ({
  applyApprovedOutcome: mockApplyApprovedOutcome,
  deriveApprovedOutcome: mockDeriveApprovedOutcome,
}));

jest.unstable_mockModule('../src/orchestrator/submission-context.js', () => ({
  loadSubmissionContext: mockLoadSubmissionContext,
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

function makeDb() {
  return {
    prepare: jest.fn().mockReturnValue({ run: jest.fn() }),
  };
}

describe('runReviewerPhase approval effect wiring', () => {
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
    mockLoadSubmissionContext.mockReturnValue({
      isNoOp: false,
      latestReviewNotes: 'submission',
      approvalCandidateShas: ['submission-sha'],
    });
    mockDeriveApprovedOutcome.mockReturnValue({ kind: 'queue_merge', approvedSha: 'submission-sha' });
  });

  it('routes no-op approvals through the shared approved-outcome helper and releases the slot', async () => {
    const db = makeDb();
    mockLoadSubmissionContext.mockReturnValue({
      isNoOp: true,
      latestReviewNotes: '[NO_OP_SUBMISSION]',
      approvalCandidateShas: ['submission-sha'],
    });
    mockDeriveApprovedOutcome.mockReturnValue({ kind: 'complete', commitSha: 'submission-sha' });

    await runReviewerPhase(
      db,
      makeTask(),
      '/project',
      true,
      undefined,
      'main',
      undefined,
      {
        globalDb: {},
        slot: { id: 'slot-1', slot_path: '/slot' },
      },
    );

    expect(mockApplyApprovedOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'task-1' }),
      { kind: 'complete', commitSha: 'submission-sha' },
      expect.objectContaining({ projectPath: '/project', intakeProjectPath: '/slot' }),
    );
    expect(mockReleaseSlot).toHaveBeenCalledWith({}, 'slot-1');
  });

  it('routes merge-required approvals through the shared approved-outcome helper', async () => {
    const db = makeDb();
    mockDeriveApprovedOutcome.mockReturnValue({ kind: 'queue_merge', approvedSha: 'submission-sha' });

    await runReviewerPhase(db, makeTask(), '/project', true);

    expect(mockApplyApprovedOutcome).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ id: 'task-1' }),
      { kind: 'queue_merge', approvedSha: 'submission-sha' },
      expect.objectContaining({
        notes: expect.stringContaining('Queued for merge.'),
      }),
    );
    expect(mockReleaseSlot).not.toHaveBeenCalled();
  });
});
