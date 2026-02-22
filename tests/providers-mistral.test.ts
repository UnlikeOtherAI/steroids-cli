/**
 * Mistral Provider Tests
 */

import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

const mockSpawn = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

type MockChild = EventEmitter & {
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  stdin?: { end: jest.Mock };
  kill: jest.Mock;
  exitCode: number | null;
};

function createMockChildProcess(opts?: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  closeCode?: number;
}): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: jest.fn() };
  child.kill = jest.fn();
  child.exitCode = null;

  const stdoutChunks = opts?.stdoutChunks ?? [];
  const stderrChunks = opts?.stderrChunks ?? [];
  const closeCode = opts?.closeCode ?? 0;

  process.nextTick(() => {
    for (const chunk of stdoutChunks) {
      child.stdout?.emit('data', Buffer.from(chunk));
    }
    for (const chunk of stderrChunks) {
      child.stderr?.emit('data', Buffer.from(chunk));
    }
    child.exitCode = closeCode;
    child.emit('close', closeCode);
  });

  return child;
}

describe('MistralProvider', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('should expose metadata and default models', async () => {
    const { MistralProvider } = await import('../src/providers/mistral.js');
    const provider = new MistralProvider();

    expect(provider.name).toBe('mistral');
    expect(provider.displayName).toBe('Mistral Vibe');
    expect(provider.getDefaultModel('orchestrator')).toBe('devstral-2');
    expect(provider.getDefaultModel('coder')).toBe('devstral-2');
    expect(provider.getDefaultModel('reviewer')).toBe('devstral-2');
    expect(provider.listModels()).toContain('devstral-2');
  });

  it('should classify model-not-found and auth errors', async () => {
    const { MistralProvider } = await import('../src/providers/mistral.js');
    const provider = new MistralProvider();

    const missingModel = provider.classifyError(1, 'Active model my-model not found in configuration');
    expect(missingModel?.type).toBe('model_not_found');
    expect(missingModel?.retryable).toBe(false);

    const auth = provider.classifyError(1, 'Missing environment variable for provider: MISTRAL_API_KEY');
    expect(auth?.type).toBe('auth_error');
    expect(auth?.retryable).toBe(false);
  });

  it('should invoke vibe with argument array by default (no shell interpolation)', async () => {
    mockSpawn.mockReturnValue(createMockChildProcess({ stdoutChunks: ['ok\n'], closeCode: 0 }));

    const { MistralProvider } = await import('../src/providers/mistral.js');
    const provider = new MistralProvider();

    const result = await provider.invoke('prompt "$(touch /tmp/should-not-run)"', {
      model: 'devstral-2',
      streamOutput: false,
    });

    expect(result.success).toBe(true);
    const firstCall = mockSpawn.mock.calls[0] as unknown[];
    expect(firstCall[0]).toBe('vibe');
    expect(Array.isArray(firstCall[1])).toBe(true);
    expect((firstCall[1] as string[])).toEqual(
      expect.arrayContaining(['-p', '--output', 'text', '--max-turns', '80', '--agent', 'auto-approve'])
    );
    expect((firstCall[1] as string[])[1]).toContain('touch /tmp/should-not-run');
    expect((firstCall[2] as { shell?: boolean }).shell).toBe(false);

    const env = (firstCall[2] as { env?: Record<string, string> }).env ?? {};
    expect(env.VIBE_ACTIVE_MODEL).toBe('devstral-2');
    expect(env.VIBE_MODELS).toContain('"devstral-2"');
    expect(env.VIBE_MODELS).not.toContain('"temperature"');
  });

  it('should use shell mode only when a custom invocation template is set', async () => {
    mockSpawn.mockReturnValue(createMockChildProcess({ stdoutChunks: ['ok\n'], closeCode: 0 }));

    const { MistralProvider } = await import('../src/providers/mistral.js');
    const provider = new MistralProvider();
    provider.setInvocationTemplate('{cli} -p "$(cat {prompt_file})" --output text --max-turns 80 --agent auto-approve');

    const result = await provider.invoke('prompt', {
      model: 'devstral-2',
      streamOutput: false,
    });

    expect(result.success).toBe(true);
    const firstCall = mockSpawn.mock.calls[0] as unknown[];
    expect(typeof firstCall[0]).toBe('string');
    expect((firstCall[1] as { shell?: boolean }).shell).toBe(true);
  });

  it('should check availability using which/where without leaking timeout', async () => {
    mockSpawn.mockReturnValue(createMockChildProcess({ closeCode: 0 }));

    const { MistralProvider } = await import('../src/providers/mistral.js');
    const provider = new MistralProvider();

    const available = await provider.isAvailable();
    expect(available).toBe(true);

    const firstCall = mockSpawn.mock.calls[0] as unknown[];
    expect(['which', 'where']).toContain(firstCall[0] as string);
    expect(firstCall[1]).toEqual(['vibe']);
    expect((firstCall[2] as { shell?: boolean }).shell).toBe(false);
  });
});
