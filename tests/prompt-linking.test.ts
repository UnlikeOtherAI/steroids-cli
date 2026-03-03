import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { Task } from '../src/database/queries.js';
import { buildProjectInstructionsSection } from '../src/prompts/instruction-files.js';
import { getSourceFileReference, buildSkillsSection } from '../src/prompts/prompt-helpers.js';
import { formatPromptPath } from '../src/prompts/path-links.js';
import { generateCoderPrompt } from '../src/prompts/coder.js';
import { generateReviewerPrompt } from '../src/prompts/reviewer.js';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: '0b8e1a44-8b5b-4dae-bdce-5804e5141ca3',
    title: 'Prompt cleanup test',
    status: 'pending',
    section_id: 'section-1',
    source_file: 'docs/plans/missing-spec.md',
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

describe('prompt link formatting', () => {
  let projectPath: string;

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-prompt-links-'));
  });

  afterEach(() => {
    rmSync(projectPath, { recursive: true, force: true });
  });

  test('instruction section links files without inlining file contents', () => {
    writeFileSync(join(projectPath, 'AGENTS.md'), 'INTERNAL-CONTENT-DO-NOT-INLINE', 'utf-8');
    const section = buildProjectInstructionsSection(projectPath);

    expect(section).toContain('## REQUIRED INSTRUCTION FILES');
    expect(section).toContain('`./AGENTS.md`');
    expect(section).not.toContain('INTERNAL-CONTENT-DO-NOT-INLINE');
  });

  test('source file reference is path-only and never reports file-not-found placeholder', () => {
    const sourceRef = getSourceFileReference(projectPath, 'docs/plans/not-here.md');
    expect(sourceRef).toContain('`./docs/plans/not-here.md`');
    expect(sourceRef).not.toContain('not found');
  });

  test('skills section emits repo-relative links and never uses file:// URLs', () => {
    const skillsDir = join(projectPath, '.steroids', 'skills');
    mkdirSync(skillsDir, { recursive: true });
    writeFileSync(join(skillsDir, 'determinism.md'), '# skill', 'utf-8');

    const section = buildSkillsSection(projectPath);
    expect(section).toContain('## Assigned Skills');
    expect(section).toContain('`./.steroids/skills/determinism.md`');
    expect(section).not.toContain('file://');
  });

  test('formatPromptPath uses ./ for in-repo paths and absolute for out-of-repo paths', () => {
    const inside = formatPromptPath(projectPath, 'docs/spec.md');
    expect(inside).toBe('./docs/spec.md');

    const outsideAbsolute = formatPromptPath(projectPath, '/tmp/external-spec.md');
    expect(outsideAbsolute).toBe('/tmp/external-spec.md');

    const outsideRelative = formatPromptPath(projectPath, '../external.md');
    expect(outsideRelative).toBe(resolve(projectPath, '../external.md'));
  });

  test('coder and reviewer prompts place specification near the top and remove task-information block', () => {
    const task = makeTask();
    const coderPrompt = generateCoderPrompt({
      task,
      projectPath,
      previousStatus: 'pending',
    });
    const reviewerPrompt = generateReviewerPrompt({
      task: { ...task, status: 'review' },
      projectPath,
      reviewerModel: 'claude-sonnet-4',
      submissionCommitHash: 'abc1234',
      config: {},
    });

    expect(coderPrompt).not.toContain('## Task Information');
    expect(reviewerPrompt).not.toContain('## Task Information');
    expect(coderPrompt).not.toContain('Specification file not found');
    expect(reviewerPrompt).not.toContain('Specification file not found');
    expect(coderPrompt.indexOf('## Specification (Read First)')).toBeLessThan(coderPrompt.indexOf('## Task Context'));
    expect(reviewerPrompt.indexOf('## Specification (Read First)')).toBeLessThan(reviewerPrompt.indexOf('## Task Context'));
  });
});
