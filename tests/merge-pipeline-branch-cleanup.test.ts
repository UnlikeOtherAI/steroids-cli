import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// Mock modules BEFORE importing the module under test
jest.unstable_mockModule('../src/workspace/git-lifecycle.js', () => ({
  deleteTaskBranchFromSlot: jest.fn(),
}));
jest.unstable_mockModule('../src/database/queries.js', () => ({
  incrementTaskConflictCount: jest.fn(() => 1),
  incrementMergeFailureCount: jest.fn(() => 1),
  setTaskBlocked: jest.fn(),
  returnTaskToPending: jest.fn(),
}));
jest.unstable_mockModule('../src/workspace/pool.js', () => ({
  releaseSlot: jest.fn(),
}));

const { handleMergeFailure } = await import('../src/workspace/merge-pipeline.js');
const { deleteTaskBranchFromSlot } = await import('../src/workspace/git-lifecycle.js');
const { releaseSlot } = await import('../src/workspace/pool.js');

describe('handleMergeFailure branch cleanup', () => {
  const mockCtx = {
    globalDb: {} as any,
    slot: {
      id: 1,
      slot_path: '/tmp/pool-0',
      task_branch: 'steroids/task-abc123',
      remote_url: 'git@github.com:org/repo.git',
    },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('deletes local task branch on rebase conflict', () => {
    handleMergeFailure({} as any, mockCtx, 'abc123', {
      ok: false, reason: 'Rebase conflict', conflict: true,
    });
    expect(deleteTaskBranchFromSlot).toHaveBeenCalledWith(
      '/tmp/pool-0', 'steroids/task-abc123'
    );
    expect(releaseSlot).toHaveBeenCalled();
  });

  it('calls deleteTaskBranchFromSlot BEFORE releaseSlot on conflict', () => {
    const callOrder: string[] = [];
    (deleteTaskBranchFromSlot as jest.Mock).mockImplementation(() => { callOrder.push('delete'); return true; });
    (releaseSlot as jest.Mock).mockImplementation(() => { callOrder.push('release'); });

    handleMergeFailure({} as any, mockCtx, 'abc123', {
      ok: false, reason: 'Rebase conflict', conflict: true,
    });

    expect(callOrder).toEqual(['delete', 'release']);
  });

  it('does NOT delete branch on general merge failure', () => {
    handleMergeFailure({} as any, mockCtx, 'abc123', {
      ok: false, reason: 'Push failed', conflict: false,
    });
    expect(deleteTaskBranchFromSlot).not.toHaveBeenCalled();
    expect(releaseSlot).toHaveBeenCalled();
  });

  it('does NOT delete branch on infrastructure failure', () => {
    handleMergeFailure({} as any, mockCtx, 'abc123', {
      ok: false, reason: 'Remote base missing', conflict: false, infrastructure: true,
    });
    expect(deleteTaskBranchFromSlot).not.toHaveBeenCalled();
    expect(releaseSlot).toHaveBeenCalled();
  });

  it('skips deletion when slot has no task_branch', () => {
    const ctxNoBranch = {
      ...mockCtx,
      slot: { ...mockCtx.slot, task_branch: null },
    };
    handleMergeFailure({} as any, ctxNoBranch, 'abc123', {
      ok: false, reason: 'Rebase conflict', conflict: true,
    });
    expect(deleteTaskBranchFromSlot).not.toHaveBeenCalled();
    expect(releaseSlot).toHaveBeenCalled();
  });
});
