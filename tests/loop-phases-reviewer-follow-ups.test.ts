import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLoadConfig = jest.fn();
const mockGetFollowUpDepth = jest.fn();
const mockCreateFollowUpTask = jest.fn();

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/database/queries.js', () => ({
  getTask: jest.fn(),
  getFollowUpDepth: mockGetFollowUpDepth,
  createFollowUpTask: mockCreateFollowUpTask,
}));

const { createFollowUpTasksIfNeeded } = await import('../src/commands/loop-phases-reviewer-follow-ups.js');

describe('createFollowUpTasksIfNeeded', () => {
  const db = {} as never;
  const task = {
    id: 'task-1',
    section_id: 'section-1',
  } as never;
  const followUpTasks = [
    { title: 'Add test coverage', description: 'Cover edge case' },
    { title: 'Tighten logging', description: 'Clarify failure path' },
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfig.mockReturnValue({
      followUpTasks: {
        autoImplementDepth1: true,
        maxDepth: 2,
      },
    });
    mockGetFollowUpDepth.mockReturnValue(0);
    mockCreateFollowUpTask.mockReturnValue('follow-up-1');
  });

  it('creates active depth-1 follow-up tasks when auto-implement is enabled', async () => {
    await createFollowUpTasksIfNeeded(db, task, '/project', followUpTasks, 'abc123', true);

    expect(mockCreateFollowUpTask).toHaveBeenCalledTimes(2);
    expect(mockCreateFollowUpTask).toHaveBeenNthCalledWith(1, db, {
      title: 'Add test coverage',
      description: 'Cover edge case',
      sectionId: 'section-1',
      referenceTaskId: 'task-1',
      referenceCommit: 'abc123',
      requiresPromotion: false,
      depth: 1,
    });
    expect(mockCreateFollowUpTask).toHaveBeenNthCalledWith(2, db, {
      title: 'Tighten logging',
      description: 'Clarify failure path',
      sectionId: 'section-1',
      referenceTaskId: 'task-1',
      referenceCommit: 'abc123',
      requiresPromotion: false,
      depth: 1,
    });
  });

  it('creates deferred follow-up tasks at deeper levels', async () => {
    mockGetFollowUpDepth.mockReturnValue(1);

    await createFollowUpTasksIfNeeded(db, task, '/project', followUpTasks.slice(0, 1), 'def456', true);

    expect(mockCreateFollowUpTask).toHaveBeenCalledWith(db, {
      title: 'Add test coverage',
      description: 'Cover edge case',
      sectionId: 'section-1',
      referenceTaskId: 'task-1',
      referenceCommit: 'def456',
      requiresPromotion: true,
      depth: 2,
    });
  });

  it('skips follow-up creation when depth limit is reached', async () => {
    mockGetFollowUpDepth.mockReturnValue(2);

    await createFollowUpTasksIfNeeded(db, task, '/project', followUpTasks, 'ghi789', true);

    expect(mockCreateFollowUpTask).not.toHaveBeenCalled();
  });
});
