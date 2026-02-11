/**
 * Credit Pause Handler — Unit Tests
 *
 * Covers:
 * 1. --once error path: throws CreditExhaustionError immediately
 * 2. Pause polling / resume on config change
 * 3. shouldStop interruption returns { resumed: false }
 * 4. Heartbeat callback is invoked during pause
 * 5. checkBatchCreditExhaustion positive and negative cases
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mock functions ──────────────────────────────────────────────────────

const mockLoadConfig = jest.fn();
const mockGetProviderRegistry = jest.fn();

// ── Module mocks (ESM-style) ────────────────────────────────────────────

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
}));

jest.unstable_mockModule('../src/providers/registry.js', () => ({
  getProviderRegistry: mockGetProviderRegistry,
}));

jest.unstable_mockModule('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-incident-id'),
}));

const mockRecordCreditIncident = jest.fn().mockReturnValue('test-incident-id');
const mockResolveCreditIncident = jest.fn();

jest.unstable_mockModule('../src/database/queries.js', () => ({
  recordCreditIncident: mockRecordCreditIncident,
  resolveCreditIncident: mockResolveCreditIncident,
}));

// ── Import module under test (after mocks) ──────────────────────────────

const {
  handleCreditExhaustion,
  CreditExhaustionError,
  checkBatchCreditExhaustion,
} = await import('../src/runners/credit-pause.js');

// ── Helpers ─────────────────────────────────────────────────────────────

function makeAlert(overrides = {}) {
  return {
    action: 'pause_credit_exhaustion' as const,
    provider: 'claude',
    model: 'claude-sonnet-4',
    role: 'coder' as const,
    message: 'Insufficient credits',
    ...overrides,
  };
}

function makeMockDb() {
  return {
    prepare: jest.fn().mockReturnValue({
      run: jest.fn(),
    }),
  } as any;
}

function makeBatchResult(overrides = {}) {
  return {
    success: false,
    exitCode: 1,
    stdout: '',
    stderr: 'insufficient credits',
    duration: 1000,
    timedOut: false,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('Credit Pause Handler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRecordCreditIncident.mockReturnValue('test-incident-id');
    // Suppress console output in tests
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. --once mode ──────────────────────────────────────────────────

  describe('--once mode', () => {
    it('throws CreditExhaustionError immediately without recording an incident', async () => {
      const db = makeMockDb();
      const alert = makeAlert();

      await expect(
        handleCreditExhaustion(alert, {
          projectPath: '/tmp/test',
          projectDb: db,
          once: true,
        })
      ).rejects.toThrow(CreditExhaustionError);

      // Should NOT have called db.prepare to record an incident
      expect(db.prepare).not.toHaveBeenCalled();
    });

    it('includes provider/model/role info in the thrown error', async () => {
      const db = makeMockDb();
      const alert = makeAlert({ provider: 'openai', model: 'gpt-4', role: 'reviewer' });

      try {
        await handleCreditExhaustion(alert, {
          projectPath: '/tmp/test',
          projectDb: db,
          once: true,
        });
        // Should not reach here
        expect(true).toBe(false);
      } catch (err: any) {
        expect(err).toBeInstanceOf(CreditExhaustionError);
        expect(err.alert.provider).toBe('openai');
        expect(err.alert.model).toBe('gpt-4');
        expect(err.alert.role).toBe('reviewer');
      }
    });

    it('prints error output to stderr', async () => {
      const db = makeMockDb();
      const alert = makeAlert();

      try {
        await handleCreditExhaustion(alert, {
          projectPath: '/tmp/test',
          projectDb: db,
          once: true,
        });
      } catch {
        // expected
      }

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('OUT OF CREDITS'));
    });
  });

  // ── 2. Pause polling / resume on config change ─────────────────────

  describe('pause polling and resume on config change', () => {
    it('resumes when config provider changes', async () => {
      const db = makeMockDb();
      const alert = makeAlert({ provider: 'claude', model: 'claude-sonnet-4', role: 'coder' });

      // First call returns same config, second returns changed config
      let callCount = 0;
      mockLoadConfig.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return {
            ai: { coder: { provider: 'claude', model: 'claude-sonnet-4' } },
          };
        }
        return {
          ai: { coder: { provider: 'openai', model: 'gpt-4' } },
        };
      });

      // Use real timers but make interruptibleSleep fast
      // We can't easily mock internal sleep, so rely on shouldStop + fast polling
      // Instead, use a tight shouldStop that lets one poll happen
      const result = await handleCreditExhaustion(alert, {
        projectPath: '/tmp/test',
        projectDb: db,
        shouldStop: () => false,
      });

      expect(result.resumed).toBe(true);
    }, 120000);

    it('resumes when config model changes', async () => {
      const db = makeMockDb();
      const alert = makeAlert({ provider: 'claude', model: 'claude-sonnet-4', role: 'reviewer' });

      let callCount = 0;
      mockLoadConfig.mockImplementation(() => {
        callCount++;
        if (callCount <= 1) {
          return {
            ai: { reviewer: { provider: 'claude', model: 'claude-sonnet-4' } },
          };
        }
        return {
          ai: { reviewer: { provider: 'claude', model: 'claude-opus-4' } },
        };
      });

      const result = await handleCreditExhaustion(alert, {
        projectPath: '/tmp/test',
        projectDb: db,
        shouldStop: () => false,
      });

      expect(result.resumed).toBe(true);
    }, 120000);

    it('records an incident on pause entry and resolves it on resume', async () => {
      const db = makeMockDb();
      const alert = makeAlert();

      // Return changed config on first poll
      mockLoadConfig.mockReturnValue({
        ai: { coder: { provider: 'openai', model: 'gpt-4' } },
      });

      await handleCreditExhaustion(alert, {
        projectPath: '/tmp/test',
        projectDb: db,
        shouldStop: () => false,
      });

      // Should have recorded and resolved the incident via query functions
      expect(mockRecordCreditIncident).toHaveBeenCalledWith(
        db,
        expect.objectContaining({ provider: 'claude', model: 'claude-sonnet-4', role: 'coder' }),
        undefined,
      );
      expect(mockResolveCreditIncident).toHaveBeenCalledWith(
        db, 'test-incident-id', 'config_changed',
      );
    }, 120000);
  });

  // ── 3. shouldStop interruption ──────────────────────────────────────

  describe('shouldStop interruption', () => {
    it('returns { resumed: false } when shouldStop is true immediately', async () => {
      const db = makeMockDb();
      const alert = makeAlert();

      const result = await handleCreditExhaustion(alert, {
        projectPath: '/tmp/test',
        projectDb: db,
        shouldStop: () => true,
      });

      expect(result.resumed).toBe(false);
    });

    it('resolves the incident when interrupted by shouldStop', async () => {
      const db = makeMockDb();
      const alert = makeAlert();

      const result = await handleCreditExhaustion(alert, {
        projectPath: '/tmp/test',
        projectDb: db,
        shouldStop: () => true,
      });

      expect(result.resumed).toBe(false);
      // Should resolve the incident via the query function
      expect(mockResolveCreditIncident).toHaveBeenCalledWith(
        db, 'test-incident-id', 'none',
      );
    });
  });

  // ── 4. Heartbeat callback during pause ──────────────────────────────

  describe('heartbeat callback during pause', () => {
    it('calls onHeartbeat during the polling loop', async () => {
      const db = makeMockDb();
      const alert = makeAlert();
      const onHeartbeat = jest.fn();

      // Return changed config after first poll so it resumes
      mockLoadConfig.mockReturnValue({
        ai: { coder: { provider: 'openai', model: 'gpt-4' } },
      });

      await handleCreditExhaustion(alert, {
        projectPath: '/tmp/test',
        projectDb: db,
        shouldStop: () => false,
        onHeartbeat,
      });

      // onHeartbeat should have been called at least once during the poll
      expect(onHeartbeat).toHaveBeenCalled();
    }, 120000);
  });
});

// ── checkBatchCreditExhaustion ────────────────────────────────────────

describe('checkBatchCreditExhaustion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // ── 5a. Positive case: credit exhaustion detected ──────────────────

  it('returns CreditExhaustionResult when provider classifies as credit_exhaustion', () => {
    mockLoadConfig.mockReturnValue({
      ai: {
        coder: { provider: 'claude', model: 'claude-sonnet-4' },
      },
    });

    const mockProvider = {
      classifyResult: jest.fn().mockReturnValue({
        type: 'credit_exhaustion',
        message: 'Insufficient credits',
        retryable: false,
      }),
    };
    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(mockProvider),
    });

    const result = checkBatchCreditExhaustion(
      makeBatchResult(),
      'coder',
      '/tmp/test'
    );

    expect(result).toEqual({
      action: 'pause_credit_exhaustion',
      provider: 'claude',
      model: 'claude-sonnet-4',
      role: 'coder',
      message: 'Insufficient credits',
    });
  });

  // ── 5b. Negative cases ──────────────────────────────────────────────

  it('returns null when the result is successful', () => {
    const result = checkBatchCreditExhaustion(
      makeBatchResult({ success: true }),
      'coder',
      '/tmp/test'
    );

    expect(result).toBeNull();
  });

  it('returns null when classifyResult returns null', () => {
    mockLoadConfig.mockReturnValue({
      ai: {
        coder: { provider: 'claude', model: 'claude-sonnet-4' },
      },
    });

    const mockProvider = {
      classifyResult: jest.fn().mockReturnValue(null),
    };
    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(mockProvider),
    });

    const result = checkBatchCreditExhaustion(
      makeBatchResult(),
      'coder',
      '/tmp/test'
    );

    expect(result).toBeNull();
  });

  it('returns null when classifyResult returns a non-credit error type', () => {
    mockLoadConfig.mockReturnValue({
      ai: {
        coder: { provider: 'claude', model: 'claude-sonnet-4' },
      },
    });

    const mockProvider = {
      classifyResult: jest.fn().mockReturnValue({
        type: 'rate_limit',
        message: 'Rate limited',
        retryable: true,
      }),
    };
    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(mockProvider),
    });

    const result = checkBatchCreditExhaustion(
      makeBatchResult(),
      'coder',
      '/tmp/test'
    );

    expect(result).toBeNull();
  });

  it('returns null when provider is not found in registry', () => {
    mockLoadConfig.mockReturnValue({
      ai: {
        coder: { provider: 'unknown-provider', model: 'some-model' },
      },
    });

    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(null),
    });

    const result = checkBatchCreditExhaustion(
      makeBatchResult(),
      'coder',
      '/tmp/test'
    );

    expect(result).toBeNull();
  });

  it('returns null when config has no provider/model for the role', () => {
    mockLoadConfig.mockReturnValue({
      ai: {},
    });

    const result = checkBatchCreditExhaustion(
      makeBatchResult(),
      'coder',
      '/tmp/test'
    );

    expect(result).toBeNull();
  });

  it('works correctly for the reviewer role', () => {
    mockLoadConfig.mockReturnValue({
      ai: {
        reviewer: { provider: 'openai', model: 'gpt-4' },
      },
    });

    const mockProvider = {
      classifyResult: jest.fn().mockReturnValue({
        type: 'credit_exhaustion',
        message: 'Quota exceeded',
        retryable: false,
      }),
    };
    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(mockProvider),
    });

    const result = checkBatchCreditExhaustion(
      makeBatchResult(),
      'reviewer',
      '/tmp/test'
    );

    expect(result).toEqual({
      action: 'pause_credit_exhaustion',
      provider: 'openai',
      model: 'gpt-4',
      role: 'reviewer',
      message: 'Quota exceeded',
    });
  });
});
