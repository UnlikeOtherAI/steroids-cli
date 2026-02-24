import { jest } from '@jest/globals';

const mockLoadConfig = jest.fn().mockReturnValue({
  ai: {
    coder: { provider: 'claude', model: 'claude-sonnet-4' },
    reviewer: { provider: 'claude', model: 'claude-sonnet-4' },
  },
});

const mockClassifyResult = jest.fn<any>();
const mockGetProviderRegistry = jest.fn<any>().mockReturnValue({
  tryGet: jest.fn<any>().mockReturnValue({
    classifyResult: mockClassifyResult,
  }),
  getProvider: jest.fn<any>().mockReturnValue({
    classifyResult: mockClassifyResult,
  }),
});

const mockTriggerCreditExhausted = jest.fn<any>().mockResolvedValue([]);
const mockTriggerCreditResolved = jest.fn<any>().mockResolvedValue([]);
const mockTriggerHooksSafely = jest.fn().mockImplementation(async (fn: any) => { await fn(); });

// ── Module mocks (ESM-style) ────────────────────────────────────────────

jest.unstable_mockModule('../src/config/loader.js', () => ({
  loadConfig: mockLoadConfig,
  getGlobalConfigPath: jest.fn(),
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

const mockGetRegisteredProject = jest.fn();
const mockSetProjectHibernation = jest.fn();

jest.unstable_mockModule('../src/runners/projects.js', () => ({
  getRegisteredProject: mockGetRegisteredProject,
  setProjectHibernation: mockSetProjectHibernation,
  clearProjectHibernation: jest.fn(),
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
    db: {} as any,
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

  describe('handleCreditExhaustion', () => {
    it('sets project hibernation to tier 1 (5 minutes) initially', async () => {
      mockGetRegisteredProject.mockReturnValue({ hibernation_tier: 0 });
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      const result = await handleCreditExhaustion(makeOptions());

      expect(result).toEqual({ resolved: false, resolution: 'hibernating' });
      expect(mockSetProjectHibernation).toHaveBeenCalledWith(
        '/tmp/test',
        1,
        new Date(now + 5 * 60 * 1000).toISOString()
      );
    });

    it('sets project hibernation to tier 2+ (30 minutes) on subsequent failures', async () => {
      mockGetRegisteredProject.mockReturnValue({ hibernation_tier: 1 });
      const now = Date.now();
      jest.spyOn(Date, 'now').mockReturnValue(now);

      const result = await handleCreditExhaustion(makeOptions());

      expect(result).toEqual({ resolved: false, resolution: 'hibernating' });
      expect(mockSetProjectHibernation).toHaveBeenCalledWith(
        '/tmp/test',
        2,
        new Date(now + 30 * 60 * 1000).toISOString()
      );
    });

    it('still records the incident and fires hooks before returning', async () => {
      const opts = makeOptions();
      await handleCreditExhaustion(opts);

      expect(mockRecordCreditIncident).toHaveBeenCalledWith(
        opts.db,
        expect.objectContaining({ provider: 'claude', model: 'claude-sonnet-4', role: 'coder' }),
        'runner-1',
      );
      expect(mockTriggerHooksSafely).toHaveBeenCalled();
    });

    it('prints PROVIDER CAPACITY output', async () => {
      await handleCreditExhaustion(makeOptions());

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('PROVIDER CAPACITY / TOKEN LIMIT REACHED'));
    });
  });

  describe('message sanitization', () => {
    it('truncates messages longer than 200 characters', async () => {
      const longMessage = 'A'.repeat(300);
      const opts = makeOptions({ message: longMessage });
      await handleCreditExhaustion(opts);

      expect(mockRecordCreditIncident).toHaveBeenCalledWith(
        opts.db,
        expect.objectContaining({
          message: expect.stringMatching(/^A{197}\.\.\.$/),
        }),
        'runner-1',
      );
    });
  });
});

describe('checkBatchCreditExhaustion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns null on successful result', async () => {
    const result = await checkBatchCreditExhaustion(
      makeBatchResult({ success: true }),
      'coder',
      '/tmp/test',
    );
    expect(result).toBeNull();
  });

  it('returns null if provider classification does not map to credit_exhaustion', async () => {
    mockClassifyResult.mockReturnValue({ type: 'other_error', message: 'foo' });

    const result = await checkBatchCreditExhaustion(
      makeBatchResult(),
      'coder',
      '/tmp/test',
    );
    expect(result).toBeNull();
  });

  it('returns credit exhaustion payload when provider classifier matches', async () => {
    mockClassifyResult.mockReturnValue({
      type: 'credit_exhaustion',
      message: 'You exceeded your current quota',
      retryable: false,
    });

    const result = await checkBatchCreditExhaustion(
      makeBatchResult(),
      'coder',
      '/tmp/test',
    );

    expect(result).toEqual({
      action: 'pause_credit_exhaustion',
      provider: 'claude',
      model: 'claude-sonnet-4',
      role: 'coder',
      message: 'You exceeded your current quota',
    });
  });

  it('returns rate limit payload when provider classifier matches', async () => {
    mockClassifyResult.mockReturnValue({
      type: 'rate_limit',
      message: 'Too many requests, retry after 500ms',
      retryable: true,
      retryAfterMs: 500,
    });

    const result = await checkBatchCreditExhaustion(
      makeBatchResult(),
      'reviewer',
      '/tmp/test',
    );

    expect(result).toEqual({
      action: 'rate_limit',
      provider: 'claude',
      model: 'claude-sonnet-4',
      role: 'reviewer',
      message: 'Too many requests, retry after 500ms',
      retryAfterMs: 500,
    });
  });
});