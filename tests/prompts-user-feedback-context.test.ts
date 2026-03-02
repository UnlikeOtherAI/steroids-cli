import { describe, expect, it } from '@jest/globals';

import type { SteroidsConfig } from '../src/config/loader.js';
import type { Task } from '../src/database/queries.js';
import {
  generateBatchCoderPrompt,
  generateCoderPrompt,
  generateResumingCoderDeltaPrompt,
  generateResumingCoderPrompt,
} from '../src/prompts/coder.js';
import {
  generateBatchReviewerPrompt,
  generateResumingReviewerDeltaPrompt,
  generateReviewerPrompt,
} from '../src/prompts/reviewer.js';

const projectPath = process.cwd();

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '712a0b1c-c3c8-446a-92ce-4cbbcdd9ac76',
    title: 'Phase 2 prompt context injection',
    status: 'pending',
    section_id: 'section-1',
    source_file: 'docs/plans/2026-03-02-user-feedback-injection.md',
    file_path: null,
    file_line: null,
    file_commit_sha: null,
    file_content_hash: null,
    start_commit_sha: null,
    rejection_count: 0,
    created_at: '2026-03-02T00:00:00.000Z',
    updated_at: '2026-03-02T00:00:00.000Z',
    ...overrides,
  };
}

const config: SteroidsConfig = { quality: { tests: { required: false } } };

describe('prompt user-feedback context injection', () => {
  it('injects user feedback into all 4 coder prompt generators', () => {
    const summary = 'Users asked for clearer implementation priorities.';
    const item = 'Focus on deterministic behavior and avoid speculative fallbacks.';

    const deltaPrompt = generateResumingCoderDeltaPrompt({
      task: makeTask({ status: 'in_progress' }),
      projectPath,
      previousStatus: 'in_progress',
      userFeedbackSummary: summary,
      userFeedbackItems: [item],
    });
    const startPrompt = generateCoderPrompt({
      task: makeTask(),
      projectPath,
      previousStatus: 'pending',
      userFeedbackSummary: summary,
      userFeedbackItems: [item],
    });
    const batchPrompt = generateBatchCoderPrompt({
      tasks: [makeTask(), makeTask({ id: 'task-2' })],
      projectPath,
      sectionName: 'Feedback',
      userFeedbackSummary: summary,
      userFeedbackItems: [item],
    });
    const resumePrompt = generateResumingCoderPrompt({
      task: makeTask({ status: 'in_progress' }),
      projectPath,
      previousStatus: 'in_progress',
      userFeedbackSummary: summary,
      userFeedbackItems: [item],
    });

    for (const prompt of [deltaPrompt, startPrompt, batchPrompt, resumePrompt]) {
      expect(prompt).toContain('## User Feedback Context (Advisory)');
      expect(prompt).toContain(summary);
      expect(prompt).toContain(item);
    }
  });

  it('injects user feedback into all 3 reviewer prompt generators', () => {
    const summary = 'Users want reviewer feedback to stay actionable and concise.';
    const item = 'Each rejection should include concrete file:line guidance.';

    const deltaPrompt = generateResumingReviewerDeltaPrompt({
      task: makeTask({ status: 'review' }),
      projectPath,
      reviewerModel: 'claude-sonnet-4-6',
      submissionCommitHash: 'abc1234',
      config,
      userFeedbackSummary: summary,
      userFeedbackItems: [item],
    });
    const startPrompt = generateReviewerPrompt({
      task: makeTask({ status: 'review' }),
      projectPath,
      reviewerModel: 'claude-sonnet-4-6',
      submissionCommitHash: 'def5678',
      config,
      userFeedbackSummary: summary,
      userFeedbackItems: [item],
    });
    const batchPrompt = generateBatchReviewerPrompt({
      tasks: [makeTask(), makeTask({ id: 'task-3' })],
      projectPath,
      sectionName: 'Feedback',
      taskCommits: [
        { taskId: '712a0b1c-c3c8-446a-92ce-4cbbcdd9ac76', commitHash: 'abc1234' },
        { taskId: 'task-3', commitHash: 'def5678' },
      ],
      config,
      userFeedbackSummary: summary,
      userFeedbackItems: [item],
    });

    for (const prompt of [deltaPrompt, startPrompt, batchPrompt]) {
      expect(prompt).toContain('## User Feedback Context (Advisory)');
      expect(prompt).toContain(summary);
      expect(prompt).toContain(item);
    }
  });

  it('does not inject user-feedback section when no feedback fields are provided', () => {
    const coderPrompt = generateCoderPrompt({
      task: makeTask(),
      projectPath,
      previousStatus: 'pending',
    });
    const reviewerPrompt = generateReviewerPrompt({
      task: makeTask({ status: 'review' }),
      projectPath,
      reviewerModel: 'claude-sonnet-4-6',
      submissionCommitHash: 'fedcba9',
      config,
    });

    expect(coderPrompt).not.toContain('## User Feedback Context (Advisory)');
    expect(reviewerPrompt).not.toContain('## User Feedback Context (Advisory)');
  });
});
