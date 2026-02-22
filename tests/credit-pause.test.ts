/**
 * Credit Pause Handler — Unit Tests
 *
 * Covers:
 * 1. onceMode: returns { resolved: false, resolution: 'immediate_fail' }
 * 2. Pause polling / resume on config change
 * 3. shouldStop interruption returns { resolved: false, resolution: 'stopped' }
 * 4. Heartbeat callback is invoked during pause
 * 5. checkBatchCreditExhaustion positive and negative cases
 * 6. Message sanitization (truncation to 200 chars)
 * 7. Hook firing for credit.exhausted and credit.resolved
 */

// @ts-nocheck
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Mock functions ──────────────────────────────────────────────────────

const mockLoadConfig = jest.fn();
const mockGetProviderRegistry = jest.fn();
const mockTriggerCreditExhausted = jest.fn().mockResolvedValue([]);
const mockTriggerCreditResolved = jest.fn().mockResolvedValue([]);
const mockTriggerHooksSafely = jest.fn().mockImplementation(async (fn) => { await fn(); });

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

jest.unstable_mockModule('../src/hooks/integration.js', () => ({
  triggerCreditExhausted: mockTriggerCreditExhausted,
  triggerCreditResolved: mockTriggerCreditResolved,
  triggerHooksSafely: mockTriggerHooksSafely,
}));

// ── Import module under test (after mocks) ──────────────────────────────

const {
  handleCreditExhaustion,
  checkBatchCreditExhaustion,
} = await import('../src/runners/credit-pause.js');

// ── Helpers ─────────────────────────────────────────────────────────────

function makeOptions(overrides = {}) {
  return {
    provider: 'claude',
    model: 'claude-sonnet-4',
    role: 'coder' as const,
    message: 'Insufficient credits',
    runnerId: 'runner-1',
    projectPath: '/tmp/test',
    db: {
      prepare: jest.fn().mockReturnValue({ run: jest.fn() }),
    } as any,
    shouldStop: () => false,
    ...overrides,
  };
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
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // ── 1. onceMode ──────────────────────────────────────────────────

  describe('onceMode', () => {
    it('returns immediate_fail without entering poll loop', async () => {
      const result = await handleCreditExhaustion(makeOptions({ onceMode: true }));

      expect(result).toEqual({ resolved: false, resolution: 'immediate_fail' });
    });

    it('still records the incident and fires hooks before returning', async () => {
      const opts = makeOptions({ onceMode: true });
      await handleCreditExhaustion(opts);

      expect(mockRecordCreditIncident).toHaveBeenCalledWith(
        opts.db,
        expect.objectContaining({ provider: 'claude', model: 'claude-sonnet-4', role: 'coder' }),
        'runner-1',
      );
      expect(mockTriggerHooksSafely).toHaveBeenCalled();
    });

    it('prints OUT OF CREDITS output', async () => {
      await handleCreditExhaustion(makeOptions({ onceMode: true }));

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('OUT OF CREDITS'));
    });
  });

  // ── 2. Pause polling / resume on config change ─────────────────────

  describe('pause polling and resume on config change', () => {
    it('resumes when config provider changes', async () => {
      mockLoadConfig.mockReturnValue({
        ai: { coder: { provider: 'openai', model: 'gpt-4' } },
      });

      const result = await handleCreditExhaustion(makeOptions());

      expect(result).toEqual({ resolved: true, resolution: 'config_changed' });
    }, 120000);

    it('resumes when config model changes', async () => {
      mockLoadConfig.mockReturnValue({
        ai: { reviewer: { provider: 'claude', model: 'claude-opus-4' } },
      });

      const result = await handleCreditExhaustion(
        makeOptions({ role: 'reviewer', model: 'claude-sonnet-4' })
      );

      expect(result).toEqual({ resolved: true, resolution: 'config_changed' });
    }, 120000);

    it('records an incident on pause entry and resolves it on resume', async () => {
      const opts = makeOptions();
      mockLoadConfig.mockReturnValue({
        ai: { coder: { provider: 'openai', model: 'gpt-4' } },
      });

      await handleCreditExhaustion(opts);

      expect(mockRecordCreditIncident).toHaveBeenCalledWith(
        opts.db,
        expect.objectContaining({ provider: 'claude', model: 'claude-sonnet-4', role: 'coder' }),
        'runner-1',
      );
      expect(mockResolveCreditIncident).toHaveBeenCalledWith(
        opts.db, 'test-incident-id', 'config_changed',
      );
    }, 120000);
  });

  // ── 3. shouldStop interruption ──────────────────────────────────────

  describe('shouldStop interruption', () => {
    it('returns { resolved: false, resolution: stopped } when shouldStop is true immediately', async () => {
      const result = await handleCreditExhaustion(
        makeOptions({ shouldStop: () => true })
      );

      expect(result).toEqual({ resolved: false, resolution: 'stopped' });
    });

    it('resolves the incident when interrupted by shouldStop', async () => {
      const opts = makeOptions({ shouldStop: () => true });
      await handleCreditExhaustion(opts);

      expect(mockResolveCreditIncident).toHaveBeenCalledWith(
        opts.db, 'test-incident-id', 'dismissed',
      );
    });
  });

  // ── 4. Heartbeat callback during pause ──────────────────────────────

  describe('heartbeat callback during pause', () => {
    it('calls onHeartbeat during the polling loop', async () => {
      const onHeartbeat = jest.fn();

      mockLoadConfig.mockReturnValue({
        ai: { coder: { provider: 'openai', model: 'gpt-4' } },
      });

      await handleCreditExhaustion(makeOptions({ onHeartbeat }));

      expect(onHeartbeat).toHaveBeenCalled();
    }, 120000);
  });

  // ── 5. Message sanitization ──────────────────────────────────────────

  describe('message sanitization', () => {
    it('truncates messages longer than 200 characters', async () => {
      const longMessage = 'A'.repeat(300);
      const opts = makeOptions({ message: longMessage, onceMode: true });

      await handleCreditExhaustion(opts);

      // The recorded incident should have truncated message
      expect(mockRecordCreditIncident).toHaveBeenCalledWith(
        opts.db,
        expect.objectContaining({
          message: 'A'.repeat(197) + '...',
        }),
        'runner-1',
      );
    });

    it('does not truncate messages under 200 characters', async () => {
      const shortMessage = 'Short message';
      const opts = makeOptions({ message: shortMessage, onceMode: true });

      await handleCreditExhaustion(opts);

      expect(mockRecordCreditIncident).toHaveBeenCalledWith(
        opts.db,
        expect.objectContaining({ message: shortMessage }),
        'runner-1',
      );
    });
  });

  // ── 6. Hook firing ──────────────────────────────────────────────────

  describe('hook firing', () => {
    it('fires credit.exhausted hook on pause entry', async () => {
      const opts = makeOptions({ onceMode: true });
      await handleCreditExhaustion(opts);

      // triggerHooksSafely wraps the call, so we check that it was called
      expect(mockTriggerHooksSafely).toHaveBeenCalled();
      expect(mockTriggerCreditExhausted).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'claude',
          model: 'claude-sonnet-4',
          role: 'coder',
          runner_id: 'runner-1',
        }),
        { projectPath: '/tmp/test' },
      );
    });

    it('fires credit.resolved hook when config changes', async () => {
      mockLoadConfig.mockReturnValue({
        ai: { coder: { provider: 'openai', model: 'gpt-4' } },
      });

      await handleCreditExhaustion(makeOptions());

      expect(mockTriggerCreditResolved).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'claude',
          model: 'claude-sonnet-4',
          role: 'coder',
        }),
        'config_changed',
        { projectPath: '/tmp/test' },
      );
    }, 120000);
  });
});

// ── checkBatchCreditExhaustion ────────────────────────────────────────

describe('checkBatchCreditExhaustion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns CreditExhaustionResult when provider classifies as credit_exhaustion', async () => {
    mockLoadConfig.mockReturnValue({
      ai: { coder: { provider: 'claude', model: 'claude-sonnet-4' } },
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

    const result = await checkBatchCreditExhaustion(makeBatchResult(), 'coder', '/tmp/test');

    expect(result).toEqual({
      action: 'pause_credit_exhaustion',
      provider: 'claude',
      model: 'claude-sonnet-4',
      role: 'coder',
      message: 'Insufficient credits',
    });
  });

  it('returns null when the result is successful', async () => {
    const result = await checkBatchCreditExhaustion(
      makeBatchResult({ success: true }),
      'coder',
      '/tmp/test'
    );
    expect(result).toBeNull();
  });

  it('returns null when classifyResult returns null', async () => {
    mockLoadConfig.mockReturnValue({
      ai: { coder: { provider: 'claude', model: 'claude-sonnet-4' } },
    });

    const mockProvider = { classifyResult: jest.fn().mockReturnValue(null) };
    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(mockProvider),
    });

    const result = await checkBatchCreditExhaustion(makeBatchResult(), 'coder', '/tmp/test');
    expect(result).toBeNull();
  });

  it('returns null when classifyResult returns a non-credit error type', async () => {
    mockLoadConfig.mockReturnValue({
      ai: { coder: { provider: 'claude', model: 'claude-sonnet-4' } },
    });

    const mockProvider = {
      classifyResult: jest.fn().mockReturnValue({
        type: 'rate_limit', message: 'Rate limited', retryable: true,
      }),
    };
    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(mockProvider),
    });

    const result = await checkBatchCreditExhaustion(makeBatchResult(), 'coder', '/tmp/test');
    expect(result).toBeNull();
  });

  it('returns null when provider is not found in registry', async () => {
    mockLoadConfig.mockReturnValue({
      ai: { coder: { provider: 'unknown-provider', model: 'some-model' } },
    });
    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(null),
    });

    const result = await checkBatchCreditExhaustion(makeBatchResult(), 'coder', '/tmp/test');
    expect(result).toBeNull();
  });

  it('returns null when config has no provider/model for the role', async () => {
    mockLoadConfig.mockReturnValue({ ai: {} });
    const result = await checkBatchCreditExhaustion(makeBatchResult(), 'coder', '/tmp/test');
    expect(result).toBeNull();
  });

  it('works correctly for the reviewer role', async () => {
    mockLoadConfig.mockReturnValue({
      ai: { reviewer: { provider: 'openai', model: 'gpt-4' } },
    });

    const mockProvider = {
      classifyResult: jest.fn().mockReturnValue({
        type: 'credit_exhaustion', message: 'Quota exceeded', retryable: false,
      }),
    };
    mockGetProviderRegistry.mockReturnValue({
      tryGet: jest.fn().mockReturnValue(mockProvider),
    });

    const result = await checkBatchCreditExhaustion(makeBatchResult(), 'reviewer', '/tmp/test');
    expect(result).toEqual({
      action: 'pause_credit_exhaustion',
      provider: 'openai',
      model: 'gpt-4',
      role: 'reviewer',
      message: 'Quota exceeded',
    });
  });
});
