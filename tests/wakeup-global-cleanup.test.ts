// @ts-nocheck
import { afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFindStaleRunners = jest.fn();
const mockCheckLockStatus = jest.fn().mockReturnValue({ isZombie: false, pid: null });
const mockIsProcessAlive = jest.fn();
const mockOpenDatabase = jest.fn();
const mockKillProcess = jest.fn();
const mockCleanupStaleRemoteTaskBranches = jest.fn().mockReturnValue(0);

jest.unstable_mockModule('../src/runners/heartbeat.js', () => ({
  findStaleRunners: mockFindStaleRunners,
}));

jest.unstable_mockModule('../src/runners/lock.js', () => ({
  checkLockStatus: mockCheckLockStatus,
  removeLock: jest.fn(),
  isProcessAlive: mockIsProcessAlive,
}));

jest.unstable_mockModule('../src/database/connection.js', () => ({
  openDatabase: mockOpenDatabase,
}));

jest.unstable_mockModule('../src/runners/wakeup-runner.js', () => ({
  killProcess: mockKillProcess,
}));

jest.unstable_mockModule('../src/workspace/remote-branch-cleanup.js', () => ({
  cleanupStaleRemoteTaskBranches: mockCleanupStaleRemoteTaskBranches,
}));

let performWakeupGlobalMaintenance: typeof import('../src/runners/wakeup-global-cleanup.js').performWakeupGlobalMaintenance;

describe('performWakeupGlobalMaintenance', () => {
  beforeAll(async () => {
    ({ performWakeupGlobalMaintenance } = await import('../src/runners/wakeup-global-cleanup.js'));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockFindStaleRunners.mockReturnValue([]);
    mockIsProcessAlive.mockReturnValue(false);
    mockOpenDatabase.mockReturnValue({
      db: {
        prepare: () => ({ run: jest.fn() }),
      },
      close: jest.fn(),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('purges dead idle runner rows during wakeup', async () => {
    const deletedRunnerIds: string[] = [];
    const globalDb = {
      prepare: (sql: string) => {
        if (sql.includes('FROM runners r') && sql.includes('WHERE r.pid IS NOT NULL')) {
          return {
            all: () => [{
              id: 'runner-idle-dead',
              pid: 4242,
              heartbeat_at: '2026-03-20 14:00:00',
              current_task_id: null,
              project_path: '/tmp/project',
              parallel_session_id: null,
            }],
          };
        }
        if (sql.includes('DELETE FROM runners WHERE id = ?')) {
          return {
            run: (runnerId: string) => {
              deletedRunnerIds.push(runnerId);
              return { changes: 1 };
            },
          };
        }
        return {
          all: () => [],
          run: () => ({ changes: 0 }),
        };
      },
    };

    await performWakeupGlobalMaintenance({
      globalDb,
      dryRun: false,
      log: jest.fn(),
    });

    expect(deletedRunnerIds).toEqual(['runner-idle-dead']);
    expect(mockKillProcess).not.toHaveBeenCalled();
  });
});
