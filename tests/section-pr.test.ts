import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { initDatabase } from '../src/database/connection.js';
import { createSection, createTask, getSection } from '../src/database/queries.js';
import type { SteroidsConfig } from '../src/config/loader.js';

const mockExecFileSync = jest.fn();
const mockHandleIntakePostPR = jest.fn(async () => ({ handled: false, reportsResolved: 0 }));

jest.unstable_mockModule('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

jest.unstable_mockModule('../src/intake/post-pr.js', () => ({
  handleIntakePostPR: mockHandleIntakePostPR,
}));

const { checkSectionCompletionAndPR } = await import('../src/git/section-pr.js');

describe('checkSectionCompletionAndPR', () => {
  let projectPath: string;
  let db: Database.Database;
  let closeDb: (() => void) | null;

  const config: SteroidsConfig = {
    git: {
      branch: 'main',
      prAssignees: ['@me', 'octocat'],
      prReviewers: ['my-org/platform-team', 'hubot'],
    },
  };

  beforeEach(() => {
    projectPath = mkdtempSync(join(tmpdir(), 'steroids-section-pr-'));
    closeDb = null;
    mkdirSync(join(projectPath, '.steroids'), { recursive: true });
    writeFileSync(join(projectPath, 'package.json'), JSON.stringify({ name: 'tmp-project' }), 'utf-8');

    const connection = initDatabase(projectPath);
    db = connection.db;
    closeDb = connection.close;
    mockExecFileSync.mockReset();
    mockHandleIntakePostPR.mockClear();
  });

  afterEach(() => {
    closeDb?.();
    if (existsSync(projectPath)) {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  it('creates a draft PR with labels, assignees, reviewers, records the number, and returns it', async () => {
    const section = createSection(db, 'Feature Section');
    db.prepare(
      'UPDATE sections SET auto_pr = 1, branch = ?, pr_labels = ?, pr_draft = 1 WHERE id = ?'
    ).run('feature/section-pr', 'bugfix, customer , release-blocker', section.id);
    createTask(db, 'Complete the section', { sectionId: section.id, status: 'completed' });
    createTask(db, 'Skipped follow-up', { sectionId: section.id, status: 'skipped' });

    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const argv = args as string[];
      if (argv[0] === '--version') {
        return 'gh version 2.0.0';
      }
      if (argv[0] === 'pr' && argv[1] === 'list') {
        return '';
      }
      if (argv[0] === 'pr' && argv[1] === 'create') {
        return '{"number":123}';
      }
      throw new Error(`Unexpected gh invocation: ${argv.join(' ')}`);
    });

    const prNumber = await checkSectionCompletionAndPR(db, projectPath, section.id, config);

    expect(prNumber).toBe(123);
    expect(getSection(db, section.id)?.pr_number).toBe(123);
    expect(mockHandleIntakePostPR as any).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        sectionId: section.id,
        prNumber: 123,
        config,
      })
    );

    const createCall = mockExecFileSync.mock.calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[])[0] === 'pr' && (call[1] as string[])[1] === 'create'
    );
    expect(createCall).toBeDefined();
    expect(createCall?.[1]).toEqual(
      expect.arrayContaining([
        'pr',
        'create',
        '--base',
        'main',
        '--head',
        'feature/section-pr',
        '--title',
        'Section: Feature Section',
        '--draft',
        '--label',
        'bugfix',
        '--label',
        'customer',
        '--label',
        'release-blocker',
        '--assignee',
        '@me',
        '--assignee',
        'octocat',
        '--reviewer',
        'my-org/platform-team',
        '--reviewer',
        'hubot',
        '--json',
        'number',
      ])
    );
  });

  it('records an existing PR, updates metadata via gh pr edit, and returns the number', async () => {
    const section = createSection(db, 'Existing PR Section');
    db.prepare(
      'UPDATE sections SET auto_pr = 1, branch = ?, pr_labels = ?, pr_draft = 0 WHERE id = ?'
    ).run('feature/existing-pr', 'triaged, ready', section.id);
    createTask(db, 'Complete existing section', { sectionId: section.id, status: 'completed' });

    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown) => {
      const argv = args as string[];
      if (argv[0] === 'pr' && argv[1] === 'list') {
        return '77';
      }
      if (argv[0] === 'pr' && argv[1] === 'edit') {
        return '';
      }
      throw new Error(`Unexpected gh invocation: ${argv.join(' ')}`);
    });

    const prNumber = await checkSectionCompletionAndPR(db, projectPath, section.id, config);

    expect(prNumber).toBe(77);
    expect(getSection(db, section.id)?.pr_number).toBe(77);
    expect(mockHandleIntakePostPR as any).toHaveBeenCalledWith(
      expect.objectContaining({
        db,
        sectionId: section.id,
        prNumber: 77,
        config,
      })
    );

    const editCall = mockExecFileSync.mock.calls.find(
      (call) => Array.isArray(call[1]) && (call[1] as string[])[0] === 'pr' && (call[1] as string[])[1] === 'edit'
    );
    expect(editCall?.[1]).toEqual(
      expect.arrayContaining([
        'pr',
        'edit',
        '77',
        '--add-label',
        'triaged',
        '--add-label',
        'ready',
        '--add-assignee',
        '@me',
        '--add-assignee',
        'octocat',
        '--add-reviewer',
        'my-org/platform-team',
        '--add-reviewer',
        'hubot',
      ])
    );
  });

  it('returns null and skips gh when the section is not done yet', async () => {
    const section = createSection(db, 'Incomplete Section');
    db.prepare('UPDATE sections SET auto_pr = 1, branch = ? WHERE id = ?').run('feature/incomplete', section.id);
    createTask(db, 'Still in review', { sectionId: section.id, status: 'review' });
    createTask(db, 'Completed already', { sectionId: section.id, status: 'completed' });

    const prNumber = await checkSectionCompletionAndPR(db, projectPath, section.id, config);

    expect(prNumber).toBeNull();
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(getSection(db, section.id)?.pr_number).toBeNull();
    expect(mockHandleIntakePostPR).not.toHaveBeenCalled();
  });
});
