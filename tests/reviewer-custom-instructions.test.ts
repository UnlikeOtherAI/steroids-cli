import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  generateReviewerPrompt,
  generateResumingReviewerDeltaPrompt,
  generateBatchReviewerPrompt,
} from '../src/prompts/reviewer.js';
import { pruneConfigToSchema } from '../src/config/loader.js';
import type { Task } from '../src/database/queries.js';

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-123',
    title: 'Test reviewer prompt',
    status: 'review',
    section_id: null,
    source_file: null,
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

describe('Reviewer custom instructions', () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-reviewer-custom-'));
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  test('injects reviewer custom instructions into full reviewer prompt', () => {
    const prompt = generateReviewerPrompt({
      task: createTask(),
      projectPath,
      reviewerModel: 'claude-sonnet-4',
      submissionCommitHash: 'abc123',
      config: {},
      reviewerCustomInstructions: 'Focus on backward compatibility only.',
    });

    expect(prompt).toContain('## Reviewer-Specific Custom Instructions');
    expect(prompt).toContain('Focus on backward compatibility only.');
  });

  test('injects reviewer custom instructions into resuming delta prompt', () => {
    const prompt = generateResumingReviewerDeltaPrompt({
      task: createTask(),
      projectPath,
      reviewerModel: 'claude-sonnet-4',
      submissionCommitHash: 'abc123',
      config: {},
      reviewerCustomInstructions: 'Prioritize security regressions.',
    });

    expect(prompt).toContain('## Reviewer-Specific Custom Instructions');
    expect(prompt).toContain('Prioritize security regressions.');
  });

  test('injects reviewer custom instructions into batch reviewer prompt', () => {
    const prompt = generateBatchReviewerPrompt({
      tasks: [createTask({ id: 't1', title: 'Task one' })],
      projectPath,
      sectionName: 'Section A',
      taskCommits: [{ taskId: 't1', commitHash: 'abc123' }],
      config: {},
      reviewerCustomInstructions: 'Flag risky shell command patterns.',
    });

    expect(prompt).toContain('## Reviewer-Specific Custom Instructions');
    expect(prompt).toContain('Flag risky shell command patterns.');
  });

  test('keeps ai.reviewer.customInstructions during schema pruning', () => {
    const pruned = pruneConfigToSchema({
      ai: {
        reviewer: {
          provider: 'claude',
          model: 'claude-sonnet-4',
          customInstructions: 'Review with API stability focus.',
        },
      },
    });

    expect(pruned.ai?.reviewer).toEqual({
      provider: 'claude',
      model: 'claude-sonnet-4',
      customInstructions: 'Review with API stability focus.',
    });
  });
});
