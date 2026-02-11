/**
 * Hook Integration — Credit trigger runtime paths
 *
 * Tests triggerCreditExhausted, triggerCreditResolved, and triggerHooksSafely
 * by mocking the config loader and hook orchestrator.
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockLoadConfigFile = jest.fn().mockReturnValue({ hooks: [] });
const mockGetProjectConfigPath = jest.fn().mockReturnValue('/tmp/test/.steroids/config.yaml');
const mockGetGlobalConfigPath = jest.fn().mockReturnValue('/home/user/.steroids/config.yaml');

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfigFile: mockLoadConfigFile,
  getProjectConfigPath: mockGetProjectConfigPath,
  getGlobalConfigPath: mockGetGlobalConfigPath,
  loadConfig: jest.fn(),
}));

const mockExecuteHooksForEvent = jest.fn().mockResolvedValue([]);

jest.unstable_mockModule('../src/hooks/orchestrator.js', () => ({
  HookOrchestrator: jest.fn().mockImplementation(() => ({
    executeHooksForEvent: mockExecuteHooksForEvent,
  })),
}));

jest.unstable_mockModule('../src/hooks/merge.js', () => ({
  mergeHooks: jest.fn().mockReturnValue([]),
  filterHooksByEvent: jest.fn().mockReturnValue([]),
}));

// ── Import after mocks ────────────────────────────────────────────────

const {
  triggerCreditExhausted,
  triggerCreditResolved,
  triggerHooksSafely,
  shouldSkipHooks,
} = await import('../src/hooks/integration.js');

// ── Tests ──────────────────────────────────────────────────────────────

describe('triggerCreditExhausted', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfigFile.mockReturnValue({ hooks: [] });
    mockExecuteHooksForEvent.mockResolvedValue([]);
  });

  it('calls the orchestrator for credit.exhausted event', async () => {
    const credit = {
      provider: 'claude',
      model: 'claude-sonnet-4',
      role: 'coder' as const,
      message: 'Insufficient credits',
      runner_id: 'runner-1',
    };

    await triggerCreditExhausted(credit, { projectPath: '/tmp/test' });

    expect(mockExecuteHooksForEvent).toHaveBeenCalledWith(
      'credit.exhausted',
      expect.objectContaining({
        event: 'credit.exhausted',
        credit,
        project: expect.objectContaining({ path: '/tmp/test' }),
      }),
    );
  });

  it('returns hook execution results', async () => {
    const mockResults = [{ hookName: 'slack', success: true, duration: 100 }];
    mockExecuteHooksForEvent.mockResolvedValue(mockResults);

    const credit = {
      provider: 'claude',
      model: 'opus',
      role: 'reviewer' as const,
      message: 'No credits',
    };

    const results = await triggerCreditExhausted(credit, { projectPath: '/tmp/test' });
    expect(results).toEqual(mockResults);
  });
});

describe('triggerCreditResolved', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLoadConfigFile.mockReturnValue({ hooks: [] });
    mockExecuteHooksForEvent.mockResolvedValue([]);
  });

  it('calls the orchestrator for credit.resolved event', async () => {
    const credit = {
      provider: 'claude',
      model: 'claude-sonnet-4',
      role: 'coder' as const,
      message: 'Insufficient credits',
      runner_id: 'runner-1',
    };

    await triggerCreditResolved(credit, 'config_changed', { projectPath: '/tmp/test' });

    expect(mockExecuteHooksForEvent).toHaveBeenCalledWith(
      'credit.resolved',
      expect.objectContaining({
        event: 'credit.resolved',
        credit,
        resolution: 'config_changed',
        project: expect.objectContaining({ path: '/tmp/test' }),
      }),
    );
  });
});

describe('triggerHooksSafely', () => {
  it('calls the trigger function and does not throw', async () => {
    const fn = jest.fn().mockResolvedValue([{ hookName: 'test', success: true, duration: 50 }]);
    await expect(triggerHooksSafely(fn)).resolves.toBeUndefined();
    expect(fn).toHaveBeenCalled();
  });

  it('silently swallows errors from the trigger function', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('hook failed'));
    await expect(triggerHooksSafely(fn)).resolves.toBeUndefined();
  });

  it('logs failures in verbose mode', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fn = jest.fn().mockResolvedValue([
      { hookName: 'bad-hook', success: false, error: 'timeout', duration: 5000 },
    ]);

    await triggerHooksSafely(fn, { verbose: true });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('1 hook(s) failed'));
    spy.mockRestore();
  });

  it('logs error message in verbose mode when trigger throws', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const fn = jest.fn().mockRejectedValue(new Error('connection refused'));

    await triggerHooksSafely(fn, { verbose: true });
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('connection refused'));
    spy.mockRestore();
  });
});

describe('shouldSkipHooks', () => {
  const originalEnv = process.env.STEROIDS_NO_HOOKS;

  beforeEach(() => {
    delete process.env.STEROIDS_NO_HOOKS;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.STEROIDS_NO_HOOKS = originalEnv;
    } else {
      delete process.env.STEROIDS_NO_HOOKS;
    }
  });

  it('returns true when noHooks flag is set', () => {
    expect(shouldSkipHooks({ noHooks: true })).toBe(true);
  });

  it('returns true when STEROIDS_NO_HOOKS=1', () => {
    process.env.STEROIDS_NO_HOOKS = '1';
    expect(shouldSkipHooks()).toBe(true);
  });

  it('returns true when STEROIDS_NO_HOOKS=true', () => {
    process.env.STEROIDS_NO_HOOKS = 'true';
    expect(shouldSkipHooks()).toBe(true);
  });

  it('returns false when no flag or env var', () => {
    expect(shouldSkipHooks()).toBe(false);
  });
});
