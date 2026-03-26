export type HarnessTaskStatus =
  | 'completed'
  | 'failed'
  | 'disputed'
  | 'skipped'
  | 'blocked_error';

export interface MockCoderResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
  duration: number;
}

export interface MockReviewerResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  timedOut: boolean;
  duration: number;
  decision?: 'approve' | 'reject' | 'dispute' | 'skip';
  provider?: string;
  model?: string;
}

export type MockOrchestratorResult =
  | { output: string }
  | { throws: string };

export type MockCoordinatorResult =
  | { success: true; decision: 'guide_coder' | 'override_reviewer' | 'narrow_scope'; guidance: string }
  | { throws: string };

export interface MockGitState {
  currentSha: string;
  hasUncommitted: boolean;
  recentCommits: Array<{ sha: string; message: string }>;
  changedFiles: string[];
  diffSummary: string;
  modifiedFiles: string[];
  diffStats: { additions: number; deletions: number };
  isReachable: boolean;
}

export interface ScenarioDefinition {
  expected: HarnessTaskStatus;
  section?: 'core' | 'dep-gate' | 'dep-gated' | 'task-deps';
  multiReview?: boolean;
  coder?: MockCoderResponse[];
  coderOrchestrator?: MockOrchestratorResult[];
  reviewer?: MockReviewerResponse[];
  reviewers?: MockReviewerResponse[][];
  reviewerOrchestrator?: MockOrchestratorResult[];
  multiReviewerOrchestrator?: MockOrchestratorResult[];
  coordinator?: MockCoordinatorResult[];
  git?: Partial<MockGitState>;
}

const REVIEW_OUTPUT = 'STATUS: REVIEW\nREASON: Task implemented successfully\nCONFIDENCE: HIGH';
const RETRY_OUTPUT = 'STATUS: RETRY\nREASON: Needs another coder pass\nCONFIDENCE: MEDIUM';
const GARBAGE_OUTPUT = 'aslkdjf no parseable signal';
const CREDIT_EXHAUSTION_JSON = '{"error":{"code":"insufficient_quota","message":"Credit exhausted"}}';

function repeat<T>(count: number, factory: (index: number) => T): T[] {
  return Array.from({ length: count }, (_, index) => factory(index));
}

export function coderSuccess(stdout = 'Implemented the requested change set.'): MockCoderResponse {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    success: true,
    timedOut: false,
    duration: 5_000,
  };
}

export function coderFailure(stderr = 'provider exited with error', exitCode = 1): MockCoderResponse {
  return {
    stdout: '',
    stderr,
    exitCode,
    success: false,
    timedOut: false,
    duration: 1_000,
  };
}

export function coderTimeout(stderr = 'timeout'): MockCoderResponse {
  return {
    stdout: '',
    stderr,
    exitCode: 1,
    success: false,
    timedOut: true,
    duration: 900_000,
  };
}

export function reviewerApprove(
  stdout = 'DECISION: APPROVE\nLooks good.',
): MockReviewerResponse {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    success: true,
    timedOut: false,
    duration: 3_000,
    decision: 'approve',
  };
}

export function reviewerReject(
  stdout = 'DECISION: REJECT\n- [ ] Fix the missing implementation detail.',
): MockReviewerResponse {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    success: true,
    timedOut: false,
    duration: 3_000,
    decision: 'reject',
  };
}

export function reviewerSkip(
  stdout = 'DECISION: SKIP\nExternal setup only.',
): MockReviewerResponse {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    success: true,
    timedOut: false,
    duration: 3_000,
    decision: 'skip',
  };
}

export function reviewerDispute(
  stdout = 'DECISION: DISPUTE\nThis requires human intervention.',
): MockReviewerResponse {
  return {
    stdout,
    stderr: '',
    exitCode: 0,
    success: true,
    timedOut: false,
    duration: 3_000,
    decision: 'dispute',
  };
}

export function reviewerFailure(stderr = 'reviewer CLI crashed'): MockReviewerResponse {
  return {
    stdout: '',
    stderr,
    exitCode: 1,
    success: false,
    timedOut: false,
    duration: 1_000,
  };
}

export function reviewerTimeout(stderr = 'timeout'): MockReviewerResponse {
  return {
    stdout: '',
    stderr,
    exitCode: 1,
    success: false,
    timedOut: true,
    duration: 600_000,
  };
}

export function reviewerZeroOutputTimeout(): MockReviewerResponse {
  return {
    stdout: '',
    stderr: '',
    exitCode: 1,
    success: false,
    timedOut: true,
    duration: 600_000,
  };
}

export function orchReview(reason = 'Task implemented successfully'): MockOrchestratorResult {
  return { output: `STATUS: REVIEW\nREASON: ${reason}\nCONFIDENCE: HIGH` };
}

export function orchRetry(reason = 'Needs another coder pass'): MockOrchestratorResult {
  return { output: `STATUS: RETRY\nREASON: ${reason}\nCONFIDENCE: MEDIUM` };
}

export function orchError(reason = 'Task should fail immediately'): MockOrchestratorResult {
  return { output: `STATUS: ERROR\nREASON: ${reason}\nCONFIDENCE: HIGH` };
}

export function orchGarbage(): MockOrchestratorResult {
  return { output: GARBAGE_OUTPUT };
}

export function orchThrow(message = 'mock orchestrator failure'): MockOrchestratorResult {
  return { throws: message };
}

export function reviewerDecision(
  decision: 'approve' | 'reject' | 'dispute' | 'skip',
  notes: string,
): MockOrchestratorResult {
  return {
    output: `DECISION: ${decision.toUpperCase()}\nNOTES:\n${notes}\nCONFIDENCE: HIGH`,
  };
}

export function coordinatorGuidance(
  guidance: string,
  decision: 'guide_coder' | 'override_reviewer' | 'narrow_scope' = 'guide_coder',
): MockCoordinatorResult {
  return { success: true, decision, guidance };
}

function coordinatorThresholds(rejections: number): number[] {
  return [2, 5, 9].filter((threshold) => rejections >= threshold);
}

function buildRejectScenario(
  rejections: number,
  options: {
    finalApprove?: boolean;
    rejectStdout?: string;
    rejectDecisionNotes?: string;
    coordinator?: MockCoordinatorResult[];
  } = {},
): ScenarioDefinition {
  const finalApprove = options.finalApprove ?? true;
  const rejectStdout =
    options.rejectStdout ??
    'DECISION: REJECT\n- [ ] Address the reviewer feedback before resubmitting.';
  const rejectDecisionNotes = options.rejectDecisionNotes ?? 'Reviewer requested concrete fixes.';
  const coordinatorCalls =
    options.coordinator ??
    coordinatorThresholds(rejections).map((threshold) =>
      coordinatorGuidance(`Guidance for rejection threshold ${threshold}.`),
    );

  return {
    expected: finalApprove ? 'completed' : 'failed',
    coder: repeat(rejections + (finalApprove ? 1 : 0), () => coderSuccess()),
    coderOrchestrator: repeat(rejections + (finalApprove ? 1 : 0), () => orchReview()),
    reviewer: [
      ...repeat(rejections, () => reviewerReject(rejectStdout)),
      ...(finalApprove ? [reviewerApprove()] : []),
    ],
    reviewerOrchestrator: [
      ...repeat(rejections, () => reviewerDecision('reject', rejectDecisionNotes)),
      ...(finalApprove ? [reviewerDecision('approve', 'Approved after fixes.')] : []),
    ],
    coordinator: coordinatorCalls,
  };
}

function buildCoderFailureScenario(
  failures: number,
  failure: MockCoderResponse,
  expected: HarnessTaskStatus,
): ScenarioDefinition {
  const approves = expected === 'completed';
  return {
    expected,
    coder: [
      ...repeat(failures, () => failure),
      ...(approves ? [coderSuccess()] : []),
    ],
    coderOrchestrator: approves ? [orchReview()] : [],
    reviewer: approves ? [reviewerApprove()] : [],
    reviewerOrchestrator: approves ? [reviewerDecision('approve', 'Approved after retry.')] : [],
  };
}

function buildReviewerRetryScenario(
  attempts: number,
  failingReviewer: MockReviewerResponse,
  expected: HarnessTaskStatus,
): ScenarioDefinition {
  const approves = expected === 'completed';
  return {
    expected,
    coder: [coderSuccess()],
    coderOrchestrator: [orchReview()],
    reviewer: [
      ...repeat(attempts, () => failingReviewer),
      ...(approves ? [reviewerApprove()] : []),
    ],
    reviewerOrchestrator: [
      ...repeat(attempts, () => orchGarbage()),
      ...(approves ? [reviewerDecision('approve', 'Approved after retry.')] : []),
    ],
  };
}

export const SCENARIO_ORDER = [
  'happy-simple',
  'happy-with-commits',
  'happy-committed',
  'happy-skip',
  'happy-reviewer-fallback',
  'happy-multi-review',
  'multi-reviewer-arbitrate',
  'reject-once',
  'reject-5x-coordinator',
  'reject-9x-coordinator',
  'reject-15x-failed',
  'reject-with-must-implement',
  'reject-wontfix-override',
  'reject-out-of-scope',
  'reject-coordinator-fails',
  'reject-coordinator-cached',
  'coder-fail-once',
  'coder-fail-3x',
  'coder-timeout',
  'coder-credit-exhaustion',
  'coder-rate-limit',
  'coder-auth-error',
  'coder-context-exceeded',
  'coder-model-not-found',
  'reviewer-fail-once',
  'reviewer-fail-3x',
  'reviewer-timeout-once',
  'reviewer-credit-exhaustion',
  'reviewer-rate-limit',
  'reviewer-auth-error',
  'orch-parse-fail-once',
  'orch-parse-fail-3x',
  'orch-parse-fail-completion-signal',
  'reviewer-unclear-once',
  'reviewer-unclear-3x',
  'contract-checklist-once',
  'contract-checklist-3x',
  'contract-rejection-response',
  'coder-retry-cap',
  'reviewer-dispute',
  'reviewer-zero-output-timeout',
  'multi-reviewer-partial-fail',
  'multi-reviewer-all-fail',
  'dep-section-gated',
  'dep-section-gate',
  'dep-task-gated',
  'dep-task-gate',
  'submission-commit-unreachable',
  'submission-durable-write-fail',
  'coder-error-decision',
] as const;

export const SCENARIOS: Record<(typeof SCENARIO_ORDER)[number], ScenarioDefinition> = {
  'happy-simple': { expected: 'completed', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'happy-with-commits': { expected: 'completed', coder: [coderSuccess('Committed two clean changes.')], coderOrchestrator: [orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')], git: { recentCommits: [{ sha: 'two-1', message: 'feat: first' }, { sha: 'two-2', message: 'fix: second' }] } },
  'happy-committed': { expected: 'completed', coder: [coderSuccess('Everything is committed and ready.')], coderOrchestrator: [orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')], git: { changedFiles: [], modifiedFiles: [] } },
  'happy-skip': { expected: 'skipped', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerSkip()], reviewerOrchestrator: [reviewerDecision('skip', 'External setup only.')] },
  'happy-reviewer-fallback': { expected: 'completed', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerApprove('DECISION: APPROVE\nFallback token present in raw reviewer output.')], reviewerOrchestrator: [orchGarbage()] },
  'happy-multi-review': { expected: 'completed', multiReview: true, coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewers: [[reviewerApprove('DECISION: APPROVE\nReviewer A'), reviewerApprove('DECISION: APPROVE\nReviewer B')]] },
  'multi-reviewer-arbitrate': { expected: 'completed', multiReview: true, coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewers: [[reviewerApprove('DECISION: APPROVE\nReviewer A'), reviewerSkip('DECISION: SKIP\nReviewer B wants to skip.')]], multiReviewerOrchestrator: [reviewerDecision('approve', 'Approved after arbitration.')] },
  'reject-once': buildRejectScenario(1),
  'reject-5x-coordinator': buildRejectScenario(5),
  'reject-9x-coordinator': buildRejectScenario(9),
  'reject-15x-failed': buildRejectScenario(15, { finalApprove: false }),
  'reject-with-must-implement': buildRejectScenario(2, {
    coordinator: [coordinatorGuidance('MUST_IMPLEMENT:\n1. Implement the missing checklist item.\n2. Preserve the existing scope.')],
  }),
  'reject-wontfix-override': {
    expected: 'completed',
    coder: [coderSuccess(), coderSuccess(), coderSuccess()],
    coderOrchestrator: [orchReview(), orchRetry('WONT_FIX_OVERRIDE: Implement the rejected behavior; remove the WONT_FIX claim'), orchReview()],
    reviewer: [reviewerReject(), reviewerApprove()],
    reviewerOrchestrator: [reviewerDecision('reject', 'The rejected issue must be addressed.'), reviewerDecision('approve', 'Approved after override.')],
  },
  'reject-out-of-scope': buildRejectScenario(1, {
    rejectStdout: 'DECISION: REJECT\n- [ ] [OUT_OF_SCOPE] Remove the unrelated generated dashboard file.\n- [ ] Fix the missing implementation detail.',
    rejectDecisionNotes: 'Fix the missing implementation detail.',
  }),
  'reject-coordinator-fails': buildRejectScenario(2, {
    coordinator: [{ throws: 'coordinator offline' }],
  }),
  'reject-coordinator-cached': buildRejectScenario(3, {
    coordinator: [coordinatorGuidance('Cache this guidance for the next retry.')],
  }),
  'coder-fail-once': buildCoderFailureScenario(1, coderFailure('transient coder failure'), 'completed'),
  'coder-fail-3x': buildCoderFailureScenario(3, coderFailure('persistent coder failure'), 'failed'),
  'coder-timeout': buildCoderFailureScenario(1, coderTimeout(), 'completed'),
  'coder-credit-exhaustion': buildCoderFailureScenario(1, coderFailure(CREDIT_EXHAUSTION_JSON), 'blocked_error'),
  'coder-rate-limit': buildCoderFailureScenario(1, coderFailure('rate limit exceeded'), 'blocked_error'),
  'coder-auth-error': buildCoderFailureScenario(1, coderFailure('unauthorized request'), 'blocked_error'),
  'coder-context-exceeded': buildCoderFailureScenario(3, coderFailure('context too long'), 'failed'),
  'coder-model-not-found': buildCoderFailureScenario(3, coderFailure('model not found'), 'failed'),
  'reviewer-fail-once': buildReviewerRetryScenario(1, reviewerFailure('reviewer CLI crashed'), 'completed'),
  'reviewer-fail-3x': buildReviewerRetryScenario(3, reviewerFailure('reviewer CLI crashed'), 'disputed'),
  'reviewer-timeout-once': buildReviewerRetryScenario(1, reviewerTimeout(), 'completed'),
  'reviewer-credit-exhaustion': { expected: 'blocked_error', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerFailure(CREDIT_EXHAUSTION_JSON)] },
  'reviewer-rate-limit': { expected: 'blocked_error', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerFailure('rate limit exceeded')] },
  'reviewer-auth-error': { expected: 'blocked_error', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerFailure('unauthorized request')] },
  'orch-parse-fail-once': { expected: 'completed', coder: [coderSuccess(), coderSuccess()], coderOrchestrator: [orchGarbage(), orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'orch-parse-fail-3x': { expected: 'failed', coder: [coderSuccess(), coderSuccess(), coderSuccess()], coderOrchestrator: [orchGarbage(), orchGarbage(), orchGarbage()] },
  'orch-parse-fail-completion-signal': { expected: 'completed', coder: [coderSuccess('Task completed and ready for review.')], coderOrchestrator: [orchThrow('mock orchestrator failure')], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'reviewer-unclear-once': { expected: 'completed', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerFailure('ambiguous reviewer output'), reviewerApprove()], reviewerOrchestrator: [orchGarbage(), reviewerDecision('approve', 'Approved after retry.')] },
  'reviewer-unclear-3x': { expected: 'disputed', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerFailure('ambiguous reviewer output'), reviewerFailure('ambiguous reviewer output'), reviewerFailure('ambiguous reviewer output')], reviewerOrchestrator: [orchGarbage(), orchGarbage(), orchGarbage()] },
  'contract-checklist-once': { expected: 'completed', coder: [coderSuccess(), coderSuccess()], coderOrchestrator: [orchRetry('CHECKLIST_REQUIRED: No SELF_REVIEW_CHECKLIST block found'), orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'contract-checklist-3x': { expected: 'failed', coder: [coderSuccess(), coderSuccess(), coderSuccess()], coderOrchestrator: [orchRetry('CHECKLIST_REQUIRED: No SELF_REVIEW_CHECKLIST block found'), orchRetry('CHECKLIST_REQUIRED: No SELF_REVIEW_CHECKLIST block found'), orchRetry('CHECKLIST_REQUIRED: No SELF_REVIEW_CHECKLIST block found')] },
  'contract-rejection-response': { expected: 'completed', coder: [coderSuccess(), coderSuccess()], coderOrchestrator: [orchRetry('REJECTION_RESPONSE_REQUIRED: Missing explicit response to reviewer feedback'), orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'coder-retry-cap': { expected: 'failed', coder: [coderSuccess(), coderSuccess(), coderSuccess()], coderOrchestrator: [{ output: RETRY_OUTPUT }, { output: RETRY_OUTPUT }, { output: RETRY_OUTPUT }] },
  'reviewer-dispute': { expected: 'disputed', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerDispute()], reviewerOrchestrator: [reviewerDecision('dispute', 'Escalating to dispute.')] },
  'reviewer-zero-output-timeout': { expected: 'disputed', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerZeroOutputTimeout(), reviewerZeroOutputTimeout(), reviewerZeroOutputTimeout()], reviewerOrchestrator: [orchGarbage(), orchGarbage(), orchGarbage()] },
  'multi-reviewer-partial-fail': { expected: 'completed', multiReview: true, coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewers: [[reviewerApprove('DECISION: APPROVE\nPrimary reviewer approves.'), reviewerFailure('secondary reviewer crashed')]], reviewerOrchestrator: [reviewerDecision('approve', 'Approved after degrading to the successful reviewer.')] },
  'multi-reviewer-all-fail': { expected: 'failed', multiReview: true, coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewers: [[reviewerFailure('reviewer A crashed'), reviewerFailure('reviewer B crashed')], [reviewerFailure('reviewer A crashed'), reviewerFailure('reviewer B crashed')], [reviewerFailure('reviewer A crashed'), reviewerFailure('reviewer B crashed')]] },
  'dep-section-gated': { expected: 'completed', section: 'dep-gated', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'dep-section-gate': { expected: 'completed', section: 'dep-gate', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'dep-task-gated': { expected: 'completed', section: 'task-deps', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'dep-task-gate': { expected: 'completed', section: 'task-deps', coder: [coderSuccess()], coderOrchestrator: [orchReview()], reviewer: [reviewerApprove()], reviewerOrchestrator: [reviewerDecision('approve', 'Approved.')] },
  'submission-commit-unreachable': { expected: 'failed', coder: [coderSuccess()], coderOrchestrator: [orchReview()], git: { isReachable: false } },
  'submission-durable-write-fail': { expected: 'failed', coder: [coderSuccess()], coderOrchestrator: [orchReview()] },
  'coder-error-decision': { expected: 'failed', coder: [coderSuccess()], coderOrchestrator: [orchError('Fatal implementation error')] },
};

export const EXPECTED_TERMINAL_STATUS: Record<(typeof SCENARIO_ORDER)[number], HarnessTaskStatus> =
  Object.fromEntries(SCENARIO_ORDER.map((scenarioId) => [scenarioId, SCENARIOS[scenarioId].expected])) as Record<
    (typeof SCENARIO_ORDER)[number],
    HarnessTaskStatus
  >;

export const MULTI_REVIEW_SCENARIOS = new Set<string>(
  SCENARIO_ORDER.filter((scenarioId) => SCENARIOS[scenarioId].multiReview),
);
