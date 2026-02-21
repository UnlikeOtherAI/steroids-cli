/**
 * Loop Phases — Credit Exhaustion Tests
 *
 * Covers four behaviors:
 * 1. Coder credit exhaustion → returns pause_credit_exhaustion, orchestrator NOT called
 * 2. Reviewer credit exhaustion → same shape with role 'reviewer', orchestrator NOT called
 * 3. Coder non-credit path → orchestrator IS called
 * 4. Reviewer non-credit path → orchestrator IS called
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mock functions ──────────────────────────────────────────────────────

const mockInvokeCoder = jest.fn<(...args: any[]) => Promise<CoderResult>>();
const mockInvokeReviewer = jest.fn<(...args: any[]) => Promise<ReviewerResult>>();
const mockInvokeCoderOrchestrator = jest.fn<(...args: any[]) => Promise<string>>();
const mockInvokeReviewerOrchestrator = jest.fn<(...args: any[]) => Promise<string>>();

const mockLoadConfig = jest.fn();
const mockGetProviderRegistry = jest.fn();

const mockGetTask = jest.fn();
const mockUpdateTaskStatus = jest.fn();
const mockApproveTask = jest.fn();
const mockRejectTask = jest.fn();
const mockGetTaskRejections = jest.fn().mockReturnValue([]);
const mockGetTaskAudit = jest.fn().mockReturnValue([]);
const mockGetLatestSubmissionNotes = jest.fn().mockReturnValue(undefined);
const mockListTasks = jest.fn().mockReturnValue([]);
const mockAddAuditEntry = jest.fn();

const mockGetCurrentCommitSha = jest.fn().mockReturnValue('abc123');
const mockGetModifiedFiles = jest.fn().mockReturnValue([]);
const mockGetRecentCommits = jest.fn().mockReturnValue([]);
const mockGetChangedFiles = jest.fn().mockReturnValue([]);
const mockHasUncommittedChanges = jest.fn().mockReturnValue(false);
const mockGetDiffSummary = jest.fn().mockReturnValue('');
const mockGetDiffStats = jest.fn().mockReturnValue({ additions: 0, deletions: 0 });
const mockPushToRemote = jest.fn().mockReturnValue({ success: true, commitHash: 'abc123' });
const mockInvokeCoordinator = jest.fn();

// ── Module mocks ────────────────────────────────────────────────────────

jest.unstable_mockModule('../src/orchestrator/coder.js', () => ({
  invokeCoder: mockInvokeCoder,
}));

jest.unstable_mockModule('../src/orchestrator/reviewer.js', () => ({
  invokeReviewer: mockInvokeReviewer,
}));

jest.unstable_mockModule('../src/orchestrator/invoke.js', () => ({
  invokeCoderOrchestrator: mockInvokeCoderOrchestrator,
  invokeReviewerOrchestrator: mockInvokeReviewerOrchestrator,
}));

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/providers/registry.js', () => ({
  getProviderRegistry: mockGetProviderRegistry,
}));

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTask: mockGetTask,
  updateTaskStatus: mockUpdateTaskStatus,
  approveTask: mockApproveTask,
  rejectTask: mockRejectTask,
  getTaskRejections: mockGetTaskRejections,
  getTaskAudit: mockGetTaskAudit,
  getLatestSubmissionNotes: mockGetLatestSubmissionNotes,
  listTasks: mockListTasks,
  addAuditEntry: mockAddAuditEntry,
}));

jest.unstable_mockModule('../src/git/status.js', () => ({
  getCurrentCommitSha: mockGetCurrentCommitSha,
  getModifiedFiles: mockGetModifiedFiles,
  getRecentCommits: mockGetRecentCommits,
  getChangedFiles: mockGetChangedFiles,
  hasUncommittedChanges: mockHasUncommittedChanges,
  getDiffSummary: mockGetDiffSummary,
  getDiffStats: mockGetDiffStats,
}));

jest.unstable_mockModule('../src/git/push.js', () => ({
  pushToRemote: mockPushToRemote,
}));

jest.unstable_mockModule('../src/orchestrator/coordinator.js', () => ({
  invokeCoordinator: mockInvokeCoordinator,
}));

jest.unstable_mockModule('../src/orchestrator/fallback-handler.js', () => ({
  OrchestrationFallbackHandler: class {
    parseCoderOutput() {
      return {
        action: 'submit',
        reasoning: 'test',
        commits: [],
        next_status: 'review',
        metadata: { files_changed: 0, confidence: 'high', exit_clean: true, has_commits: false },
      };
    }
    parseReviewerOutput() {
      return {
        decision: 'approve',
        reasoning: 'test',
        notes: 'test',
        next_status: 'completed',
        metadata: { rejection_count: 0, confidence: 'high', push_to_remote: false, repeated_issue: false },
      };
    }
  },
}));

// ── Import module under test (after mocks) ──────────────────────────────

const { runCoderPhase, runReviewerPhase } = await import('../src/commands/loop-phases.js');

// ── Helpers ─────────────────────────────────────────────────────────────

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    title: 'Test task',
    status: 'in_progress' as const,
    section_id: null,
    source_file: null,
    file_path: null,
    file_line: null,
    file_commit_sha: null,
    file_content_hash: null,
    rejection_count: 0,
    created_at: '2025-01-01',
    updated_at: '2025-01-01',
    ...overrides,
  };
}

function makeCoderResult(overrides: Partial<CoderResult> = {}): CoderResult {
  return {
    success: false,
    exitCode: 1,
    stdout: '',
    stderr: 'insufficient credits',
    duration: 1000,
    timedOut: false,
    ...overrides,
  };
}

function makeReviewerResult(overrides: Partial<ReviewerResult> = {}): ReviewerResult {
  return {
    success: false,
    exitCode: 1,
    stdout: '',
    stderr: 'insufficient credits',
    duration: 1000,
    timedOut: false,
    ...overrides,
  };
}

function makeMockProvider(classifyReturn: ProviderError | null = null) {
  return {
    name: 'claude',
    displayName: 'Claude',
    classifyResult: jest.fn().mockReturnValue(classifyReturn),
    classifyError: jest.fn().mockReturnValue(null),
    tryGet: undefined, // not a registry method
  };
}

function setupConfig() {
  mockLoadConfig.mockReturnValue({
    ai: {
      coder: { provider: 'claude', model: 'claude-sonnet-4' },
      reviewer: { provider: 'claude', model: 'claude-sonnet-4' },
    },
  });
}

function setupRegistry(provider: ReturnType<typeof makeMockProvider>) {
  mockGetProviderRegistry.mockReturnValue({
    tryGet: jest.fn().mockReturnValue(provider),
  });
}

const CREDIT_ERROR: ProviderError = {
  type: 'credit_exhaustion',
  message: 'Insufficient credits on your account',
  retryable: false,
};

// ── Tests ───────────────────────────────────────────────────────────────

describe('Loop Phases — Credit Exhaustion', () => {
  const db = {} as any;
  const projectPath = '/tmp/test-project';

  beforeEach(() => {
    jest.clearAllMocks();
    setupConfig();
  });

  // ── 1. Coder: credit exhaustion ──────────────────────────────────────
  describe('runCoderPhase — credit exhaustion', () => {
    it('returns pause_credit_exhaustion and does NOT call invokeCoderOrchestrator', async () => {
      const provider = makeMockProvider(CREDIT_ERROR);
      setupRegistry(provider);

      mockInvokeCoder.mockResolvedValue(makeCoderResult());

      const result = await runCoderPhase(db, makeTask(), projectPath, 'start', true);

      expect(result).toEqual({
        action: 'pause_credit_exhaustion',
        provider: 'claude',
        model: 'claude-sonnet-4',
        role: 'coder',
        message: 'Insufficient credits on your account',
      });

      expect(provider.classifyResult).toHaveBeenCalledTimes(1);
      expect(mockInvokeCoderOrchestrator).not.toHaveBeenCalled();
    });
  });

  // ── 2. Reviewer: credit exhaustion ───────────────────────────────────
  describe('runReviewerPhase — credit exhaustion', () => {
    it('returns pause_credit_exhaustion with role reviewer and does NOT call invokeReviewerOrchestrator', async () => {
      const provider = makeMockProvider(CREDIT_ERROR);
      setupRegistry(provider);

      mockInvokeReviewer.mockResolvedValue(makeReviewerResult());

      const result = await runReviewerPhase(db, makeTask(), projectPath, true);

      expect(result).toEqual({
        action: 'pause_credit_exhaustion',
        provider: 'claude',
        model: 'claude-sonnet-4',
        role: 'reviewer',
        message: 'Insufficient credits on your account',
      });

      expect(provider.classifyResult).toHaveBeenCalledTimes(1);
      expect(mockInvokeReviewerOrchestrator).not.toHaveBeenCalled();
    });
  });

  // ── 3. Coder: non-credit path ────────────────────────────────────────
  describe('runCoderPhase — non-credit path', () => {
    it('proceeds to invokeCoderOrchestrator when classifyResult returns null', async () => {
      const provider = makeMockProvider(null);
      setupRegistry(provider);

      mockInvokeCoder.mockResolvedValue(makeCoderResult({
        success: true,
        exitCode: 0,
        stdout: 'coder output',
        stderr: '',
      }));

      mockInvokeCoderOrchestrator.mockResolvedValue(JSON.stringify({
        action: 'submit',
        reasoning: 'All good',
        commits: [],
        next_status: 'review',
        metadata: { files_changed: 0, confidence: 'high', exit_clean: true, has_commits: false },
      }));

      const result = await runCoderPhase(db, makeTask(), projectPath, 'start', true);

      // Should not return a credit exhaustion result
      expect(result).toBeUndefined();
      expect(mockInvokeCoderOrchestrator).toHaveBeenCalledTimes(1);
    });

    it('proceeds to invokeCoderOrchestrator when classifyResult returns a non-credit error', async () => {
      const rateLimit: ProviderError = {
        type: 'rate_limit',
        message: 'Rate limited',
        retryable: true,
      };
      const provider = makeMockProvider(rateLimit);
      setupRegistry(provider);

      mockInvokeCoder.mockResolvedValue(makeCoderResult({
        success: false,
        exitCode: 1,
        stderr: 'rate limit exceeded',
      }));

      mockInvokeCoderOrchestrator.mockResolvedValue(JSON.stringify({
        action: 'retry',
        reasoning: 'Rate limited',
        commits: [],
        next_status: 'in_progress',
        metadata: { files_changed: 0, confidence: 'low', exit_clean: false, has_commits: false },
      }));

      const result = await runCoderPhase(db, makeTask(), projectPath, 'start', true);

      // Non-credit errors should still proceed to orchestrator
      expect(result).toBeUndefined();
      expect(mockInvokeCoderOrchestrator).toHaveBeenCalledTimes(1);
    });
  });

  // ── 4. Reviewer: non-credit path ─────────────────────────────────────
  describe('runReviewerPhase — non-credit path', () => {
    it('proceeds to invokeReviewerOrchestrator when classifyResult returns null', async () => {
      const provider = makeMockProvider(null);
      setupRegistry(provider);

      mockInvokeReviewer.mockResolvedValue(makeReviewerResult({
        success: true,
        exitCode: 0,
        stdout: 'reviewer output',
        stderr: '',
      }));

      mockInvokeReviewerOrchestrator.mockResolvedValue(JSON.stringify({
        decision: 'approve',
        reasoning: 'All good',
        notes: 'Looks fine',
        next_status: 'completed',
        metadata: { rejection_count: 0, confidence: 'high', push_to_remote: false, repeated_issue: false },
      }));

      const result = await runReviewerPhase(db, makeTask(), projectPath, true);

      expect(result).toBeUndefined();
      expect(mockInvokeReviewerOrchestrator).toHaveBeenCalledTimes(1);
    });

    it('proceeds to invokeReviewerOrchestrator when classifyResult returns a non-credit error', async () => {
      const authError: ProviderError = {
        type: 'auth_error',
        message: 'Invalid API key',
        retryable: false,
      };
      const provider = makeMockProvider(authError);
      setupRegistry(provider);

      mockInvokeReviewer.mockResolvedValue(makeReviewerResult({
        success: false,
        exitCode: 1,
        stderr: 'unauthorized',
      }));

      mockInvokeReviewerOrchestrator.mockResolvedValue(JSON.stringify({
        decision: 'unclear',
        reasoning: 'Auth error',
        notes: 'Could not authenticate',
        next_status: 'review',
        metadata: { rejection_count: 0, confidence: 'low', push_to_remote: false, repeated_issue: false },
      }));

      const result = await runReviewerPhase(db, makeTask(), projectPath, true);

      expect(result).toBeUndefined();
      expect(mockInvokeReviewerOrchestrator).toHaveBeenCalledTimes(1);
    });
  });
});
