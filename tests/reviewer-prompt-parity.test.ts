import { generateReviewerPrompt, generateResumingReviewerDeltaPrompt } from '../src/prompts/reviewer';
import type { Task } from '../src/database/queries';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test task',
    status: 'review',
    section_id: 'section-1',
    source_file: 'docs/spec.md',
    file_path: null,
    file_line: null,
    file_commit_sha: null,
    file_content_hash: null,
    start_commit_sha: null,
    rejection_count: 0,
    failure_count: 0,
    last_failure_at: null,
    conflict_count: 0,
    blocked_reason: null,
    reference_task_id: null,
    reference_commit: null,
    reference_commit_message: null,
    created_at: '2026-03-03 00:00:00',
    updated_at: '2026-03-03 00:00:00',
    ...overrides,
  };
}

describe('reviewer prompt parity', () => {
  it('includes sibling scope policy in both fresh and resume prompts', () => {
    const task = makeTask();
    const context = {
      task,
      projectPath: '/tmp/project',
      reviewerModel: 'claude-sonnet',
      submissionCommitHash: 'abc123',
      submissionCommitHashes: ['abc123'],
      unresolvedSubmissionCommits: [],
      sectionTasks: [
        { id: 'task-1', title: 'Current', status: 'review' },
        { id: 'task-2', title: 'Sibling', status: 'pending' },
      ],
      rejectionHistory: [],
      submissionNotes: null,
      config: {} as any,
      coordinatorGuidance: undefined,
      coordinatorDecision: undefined,
      reviewerCustomInstructions: undefined,
      userFeedbackSummary: null,
      userFeedbackItems: [],
    };

    const fullPrompt = generateReviewerPrompt(context);
    const resumePrompt = generateResumingReviewerDeltaPrompt(context);

    expect(fullPrompt).toContain('## Other Tasks in This Section');
    expect(fullPrompt).toContain('[OUT_OF_SCOPE]');
    expect(resumePrompt).toContain('## Other Tasks in This Section');
    expect(resumePrompt).toContain('[OUT_OF_SCOPE]');
  });
});
