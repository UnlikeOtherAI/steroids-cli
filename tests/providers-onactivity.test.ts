/**
 * Provider onActivity integration tests
 * Verifies providers emit activity events when output is produced.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

const mockSpawn = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

type MockChild = EventEmitter & {
  stdout?: EventEmitter;
  stderr?: EventEmitter;
  kill: jest.Mock;
  killed?: boolean;
};

function createMockChildProcess(opts: {
  stdoutChunks?: string[];
  stderrChunks?: string[];
  closeCode?: number;
}): MockChild {
  const child = new EventEmitter() as MockChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = jest.fn();
  child.killed = false;

  const stdoutChunks = opts.stdoutChunks ?? [];
  const stderrChunks = opts.stderrChunks ?? [];
  const closeCode = opts.closeCode ?? 0;

  process.nextTick(() => {
    for (const chunk of stdoutChunks) child.stdout?.emit('data', Buffer.from(chunk));
    for (const chunk of stderrChunks) child.stderr?.emit('data', Buffer.from(chunk));
    child.emit('close', closeCode);
  });

  return child;
}

describe('Providers emit onActivity events', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  it('ClaudeProvider emits output activity', async () => {
    mockSpawn.mockReturnValue(
      createMockChildProcess({ stdoutChunks: ['hello\n'], closeCode: 0 })
    );

    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const provider = new ClaudeProvider();

    const activities: any[] = [];
    const result = await provider.invoke('prompt', {
      model: 'sonnet',
      streamOutput: false,
      onActivity: (a) => activities.push(a),
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('hello');
    expect(activities.some((a) => a.type === 'output')).toBe(true);
  });

  it('GeminiProvider emits output activity', async () => {
    mockSpawn.mockReturnValue(
      createMockChildProcess({ stdoutChunks: ['hi\n'], closeCode: 0 })
    );

    const { GeminiProvider } = await import('../src/providers/gemini.js');
    const provider = new GeminiProvider();

    const activities: any[] = [];
    const result = await provider.invoke('prompt', {
      model: 'gemini-pro',
      streamOutput: false,
      onActivity: (a) => activities.push(a),
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('hi');
    expect(activities.some((a) => a.type === 'output')).toBe(true);
  });

  it('OpenAIProvider emits output activity', async () => {
    mockSpawn.mockReturnValue(
      createMockChildProcess({ stdoutChunks: ['ok\n'], closeCode: 0 })
    );

    const { OpenAIProvider } = await import('../src/providers/openai.js');
    const provider = new OpenAIProvider();

    const activities: any[] = [];
    const result = await provider.invoke('prompt', {
      model: 'gpt-4o',
      streamOutput: false,
      onActivity: (a) => activities.push(a),
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('ok');
    expect(activities.some((a) => a.type === 'output')).toBe(true);
  });

  it('CodexProvider emits tool activity when JSON events are present', async () => {
    mockSpawn.mockReturnValue(
      createMockChildProcess({
        stdoutChunks: [
          JSON.stringify({ type: 'item.started', item: { type: 'tool_call', name: 'rg -n "verified email" src/' } }) + '\n',
          JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Found 15 matches' } }) + '\n'
        ],
        closeCode: 0,
      })
    );

    const { CodexProvider } = await import('../src/providers/codex.js');
    const provider = new CodexProvider();

    const activities: any[] = [];
    const result = await provider.invoke('prompt', {
      model: 'codex',
      streamOutput: false,
      onActivity: (a) => activities.push(a),
    });

    expect(result.success).toBe(true);
    expect(activities.some((a) => a.type === 'tool' && String(a.cmd).includes('rg -n'))).toBe(true);
    expect(activities.some((a) => a.type === 'output')).toBe(true);
  });

  it('MistralProvider emits output activity', async () => {
    mockSpawn.mockReturnValue(
      createMockChildProcess({ stdoutChunks: ['mistral ok\n'], closeCode: 0 })
    );

    const { MistralProvider } = await import('../src/providers/mistral.js');
    const provider = new MistralProvider();

    const activities: any[] = [];
    const result = await provider.invoke('prompt', {
      model: 'codestral-latest',
      streamOutput: false,
      onActivity: (a) => activities.push(a),
    });

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('mistral ok');
    expect(activities.some((a) => a.type === 'output')).toBe(true);
  });
});
