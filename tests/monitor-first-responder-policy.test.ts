import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockInvoke = jest.fn<any>();
const mockIsAvailable = jest.fn<any>().mockResolvedValue(true);
const mockExecuteActions = jest.fn<any>().mockResolvedValue([]);
const mockGetProviderBackoffRemainingMs = jest.fn().mockReturnValue(0);
const mockTryGet = jest.fn(() => ({
  isAvailable: mockIsAvailable,
  invoke: mockInvoke,
  classifyResult: jest.fn().mockReturnValue({ message: 'provider error' }),
}));
const mockGetProviderRegistry = jest.fn(async () => ({
  tryGet: mockTryGet,
}));

jest.unstable_mockModule('../src/providers/registry.js', () => ({
  getProviderRegistry: mockGetProviderRegistry,
}));

jest.unstable_mockModule('../src/monitor/investigator-actions.js', () => ({
  executeActions: mockExecuteActions,
}));

jest.unstable_mockModule('../src/runners/global-db-backoffs.js', () => ({
  getProviderBackoffRemainingMs: mockGetProviderBackoffRemainingMs,
}));

const { runFirstResponder } = await import('../src/monitor/investigator-agent.js');

const agents = [{ provider: 'claude', model: 'sonnet' }];

const actionableScan = {
  timestamp: Date.now(),
  projectCount: 1,
  summary: '1 anomaly',
  anomalies: [
    {
      type: 'blocked_task',
      severity: 'critical',
      projectPath: '/tmp/project',
      projectName: 'project',
      taskId: 'task-1',
      details: 'Task is blocked',
      context: {},
    },
  ],
};

describe('runFirstResponder response-mode policy', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockIsAvailable.mockResolvedValue(true);
    mockGetProviderBackoffRemainingMs.mockReturnValue(0);
    mockExecuteActions.mockResolvedValue([]);
    mockGetProviderRegistry.mockResolvedValue({ tryGet: mockTryGet });
  });

  it('filters mutating actions out of triage_only mode', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      stdout: JSON.stringify({
        diagnosis: 'Blocked task needs investigation',
        actions: [
          {
            action: 'reset_task',
            projectPath: '/tmp/project',
            taskId: 'task-1',
            reason: 'fix it',
          },
          {
            action: 'query_db',
            projectPath: '/tmp/project',
            sql: 'SELECT 1',
            reason: 'inspect it',
          },
        ],
      }),
      stderr: '',
    });

    const result = await runFirstResponder(agents, actionableScan as any, 'triage_only', null);

    expect(result.success).toBe(true);
    expect(result.actions).toEqual([
      {
        action: 'query_db',
        projectPath: '/tmp/project',
        sql: 'SELECT 1',
        reason: 'inspect it',
      },
    ]);
    expect(mockExecuteActions).toHaveBeenCalledWith(result.actions);
  });

  it('injects fallback repair only in fix_and_monitor mode', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      stdout: JSON.stringify({
        diagnosis: 'Only reporting',
        actions: [{ action: 'report_only', diagnosis: 'report' }],
      }),
      stderr: '',
    });

    const result = await runFirstResponder(agents, actionableScan as any, 'fix_and_monitor', null);

    expect(result.actions.some((action) => action.action === 'reset_task')).toBe(true);
    expect(mockExecuteActions).toHaveBeenCalledWith(result.actions);
  });

  it('does not inject fallback repair in custom mode', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      stdout: JSON.stringify({
        diagnosis: 'Only reporting',
        actions: [{ action: 'report_only', diagnosis: 'report' }],
      }),
      stderr: '',
    });

    const result = await runFirstResponder(agents, actionableScan as any, 'custom', 'Report only.');

    expect(result.actions).toEqual([{ action: 'report_only', diagnosis: 'report' }]);
    expect(mockExecuteActions).toHaveBeenCalledWith(result.actions);
  });

  it('downgrades completely disallowed triage responses to report_only', async () => {
    mockInvoke.mockResolvedValue({
      success: true,
      stdout: JSON.stringify({
        diagnosis: 'Trying to mutate',
        actions: [
          {
            action: 'reset_task',
            projectPath: '/tmp/project',
            taskId: 'task-1',
            reason: 'fix it',
          },
        ],
      }),
      stderr: '',
    });

    const result = await runFirstResponder(agents, actionableScan as any, 'triage_only', null);

    expect(result.actions).toEqual([{ action: 'report_only', diagnosis: 'Trying to mutate' }]);
  });
});
