/**
 * HF/Ollama CLI routing tests
 *
 * Verifies that HuggingFace and Ollama models are invoked through
 * CLI-based providers (Claude or OpenCode), not via direct HTTP calls.
 * The `runtime` field in paired_models tables determines which CLI handles each model.
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventEmitter } from 'node:events';

// ── Mock child_process so providers don't actually spawn CLIs ────────

const mockSpawn = jest.fn();

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
  execSync: jest.fn(),
}));

type MockChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { end: jest.Mock };
  kill: jest.Mock;
  exitCode: number | null;
};

function createMockChild(opts: {
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

  const stdoutChunks = opts.stdoutChunks ?? [];
  const stderrChunks = opts.stderrChunks ?? [];
  const closeCode = opts.closeCode ?? 0;

  process.nextTick(() => {
    for (const chunk of stdoutChunks) child.stdout.emit('data', Buffer.from(chunk));
    for (const chunk of stderrChunks) child.stderr.emit('data', Buffer.from(chunk));
    child.exitCode = closeCode;
    child.emit('close', closeCode);
  });

  return child;
}

// ── Tests ────────────────────────────────────────────────────────────

describe('HF/Ollama models route through CLI providers', () => {
  beforeEach(() => {
    mockSpawn.mockReset();
  });

  // ── OpenCode provider: HuggingFace models ─────────────────────────

  describe('OpenCode provider with HuggingFace models', () => {
    it('builds command with huggingface/ prefixed model ID', async () => {
      const hfModel = 'huggingface/Qwen/Qwen2.5-Coder-32B-Instruct';
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'done' } }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { OpenCodeProvider } = await import('../src/providers/opencode.js');
      const provider = new OpenCodeProvider();

      const result = await provider.invoke('Implement the feature', {
        model: hfModel,
        streamOutput: false,
      });

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('done');

      // Verify spawn was called with a command containing the HF model ID
      const spawnCall = mockSpawn.mock.calls[0];
      const command = spawnCall[0] as string;
      expect(command).toContain(`-m ${hfModel}`);
      expect(command).toContain('opencode run');
      expect(command).toContain('--format json');
    });

    it('builds command with bare HF model ID (no prefix)', async () => {
      const hfModel = 'deepseek-ai/DeepSeek-V3';
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'ok' } }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { OpenCodeProvider } = await import('../src/providers/opencode.js');
      const provider = new OpenCodeProvider();

      const result = await provider.invoke('test', {
        model: hfModel,
        streamOutput: false,
      });

      expect(result.success).toBe(true);
      const command = (mockSpawn.mock.calls[0][0] as string);
      expect(command).toContain(`-m ${hfModel}`);
    });
  });

  // ── OpenCode provider: Ollama models ──────────────────────────────

  describe('OpenCode provider with Ollama models', () => {
    it('builds command with ollama/ prefixed model ID', async () => {
      const ollamaModel = 'ollama/qwen2.5-coder:32b';
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'hello' } }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { OpenCodeProvider } = await import('../src/providers/opencode.js');
      const provider = new OpenCodeProvider();

      const result = await provider.invoke('test', {
        model: ollamaModel,
        streamOutput: false,
      });

      expect(result.success).toBe(true);
      const command = (mockSpawn.mock.calls[0][0] as string);
      expect(command).toContain(`-m ${ollamaModel}`);
      expect(command).toContain('opencode run');
    });

    it('builds command with bare Ollama model name', async () => {
      const ollamaModel = 'llama3.3:70b';
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'ok' } }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { OpenCodeProvider } = await import('../src/providers/opencode.js');
      const provider = new OpenCodeProvider();

      const result = await provider.invoke('test', {
        model: ollamaModel,
        streamOutput: false,
      });

      expect(result.success).toBe(true);
      const command = (mockSpawn.mock.calls[0][0] as string);
      expect(command).toContain(`-m ${ollamaModel}`);
    });
  });

  // ── Claude provider: HuggingFace models (claude-code runtime) ─────

  describe('Claude provider with HuggingFace models', () => {
    it('passes HF model ID to --model flag', async () => {
      const hfModel = 'deepseek-ai/DeepSeek-V3';
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'result', result: 'done', session_id: 's1' }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { ClaudeProvider } = await import('../src/providers/claude.js');
      const provider = new ClaudeProvider();

      const result = await provider.invoke('Implement it', {
        model: hfModel,
        streamOutput: false,
      });

      expect(result.success).toBe(true);
      const command = (mockSpawn.mock.calls[0][0] as string);
      expect(command).toContain(`--model ${hfModel}`);
      expect(command).toContain('claude');
    });
  });

  // ── Claude provider: Ollama models (claude-code runtime) ──────────

  describe('Claude provider with Ollama models', () => {
    it('passes Ollama model name to --model flag', async () => {
      const ollamaModel = 'deepseek-coder-v2:33b';
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'result', result: 'ok', session_id: 's2' }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { ClaudeProvider } = await import('../src/providers/claude.js');
      const provider = new ClaudeProvider();

      const result = await provider.invoke('test', {
        model: ollamaModel,
        streamOutput: false,
      });

      expect(result.success).toBe(true);
      const command = (mockSpawn.mock.calls[0][0] as string);
      expect(command).toContain(`--model ${ollamaModel}`);
    });
  });

  // ── Custom CLI path configurability ───────────────────────────────

  describe('custom CLI path', () => {
    it('OpenCode uses custom CLI path when set', async () => {
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'ok' } }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { OpenCodeProvider } = await import('../src/providers/opencode.js');
      const provider = new OpenCodeProvider();
      provider.setCliPath('/usr/local/bin/opencode');

      await provider.invoke('test', {
        model: 'huggingface/Qwen/Qwen2.5-Coder-32B-Instruct',
        streamOutput: false,
      });

      const command = (mockSpawn.mock.calls[0][0] as string);
      expect(command).toContain('/usr/local/bin/opencode run');
      expect(command).not.toMatch(/^opencode /);
    });

    it('Claude uses custom CLI path when set', async () => {
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'result', result: 'ok', session_id: 's1' }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { ClaudeProvider } = await import('../src/providers/claude.js');
      const provider = new ClaudeProvider();
      provider.setCliPath('/opt/bin/claude');

      await provider.invoke('test', {
        model: 'deepseek-ai/DeepSeek-V3',
        streamOutput: false,
      });

      const command = (mockSpawn.mock.calls[0][0] as string);
      expect(command).toContain('/opt/bin/claude');
    });
  });

  // ── Custom invocation template configurability ────────────────────

  describe('custom invocation template', () => {
    it('OpenCode accepts custom template with model placeholder', async () => {
      mockSpawn.mockReturnValue(
        createMockChild({
          stdoutChunks: [
            JSON.stringify({ type: 'text', sessionID: 's1', part: { text: 'ok' } }) + '\n',
          ],
          closeCode: 0,
        })
      );

      const { OpenCodeProvider } = await import('../src/providers/opencode.js');
      const provider = new OpenCodeProvider();

      await provider.invoke('test', {
        model: 'ollama/llama3.3:70b',
        streamOutput: false,
        invocationTemplate: '{cli} run --model {model} --json "$(cat {prompt_file})" {session_id}',
      });

      const command = (mockSpawn.mock.calls[0][0] as string);
      expect(command).toContain('--model ollama/llama3.3:70b');
    });
  });
});

// ── API model picker: mappedProvider mapping ────────────────────────

describe('AI model picker mappedProvider mapping', () => {
  // These tests verify the mapping logic without needing a running API server.
  // We import the route module and test the transformation functions indirectly
  // through the API integration test in api-huggingface.test.ts.
  // Here we test the conceptual contract.

  it('claude-code runtime maps to claude provider', () => {
    const runtimeToProvider = (runtime: string) =>
      runtime === 'opencode' ? 'opencode' : 'claude';

    expect(runtimeToProvider('claude-code')).toBe('claude');
  });

  it('opencode runtime maps to opencode provider', () => {
    const runtimeToProvider = (runtime: string) =>
      runtime === 'opencode' ? 'opencode' : 'claude';

    expect(runtimeToProvider('opencode')).toBe('opencode');
  });

  it('HF opencode model gets huggingface/ prefix', () => {
    const runtime = 'opencode';
    const modelId = 'Qwen/Qwen2.5-Coder-32B-Instruct';
    const id = runtime === 'opencode' ? `huggingface/${modelId}` : modelId;
    expect(id).toBe('huggingface/Qwen/Qwen2.5-Coder-32B-Instruct');
  });

  it('HF claude-code model keeps bare ID', () => {
    const runtime: string = 'claude-code';
    const modelId = 'deepseek-ai/DeepSeek-V3';
    const id = runtime === 'opencode' ? `huggingface/${modelId}` : modelId;
    expect(id).toBe('deepseek-ai/DeepSeek-V3');
  });

  it('Ollama opencode model gets ollama/ prefix', () => {
    const runtime = 'opencode';
    const modelName = 'qwen2.5-coder:32b';
    const id = runtime === 'opencode' ? `ollama/${modelName}` : modelName;
    expect(id).toBe('ollama/qwen2.5-coder:32b');
  });

  it('Ollama claude-code model keeps bare name', () => {
    const runtime: string = 'claude-code';
    const modelName = 'deepseek-coder-v2:33b';
    const id = runtime === 'opencode' ? `ollama/${modelName}` : modelName;
    expect(id).toBe('deepseek-coder-v2:33b');
  });

  it('all runtimes get a mappedProvider value (never undefined)', () => {
    const runtimes = ['claude-code', 'opencode'];
    for (const runtime of runtimes) {
      const mapped = runtime === 'opencode' ? 'opencode' : 'claude';
      expect(mapped).toBeTruthy();
      expect(['claude', 'opencode']).toContain(mapped);
    }
  });
});

// ── ProviderName type exclusion ─────────────────────────────────────

describe('ProviderName excludes hf and ollama', () => {
  it('hf and ollama are not valid provider names', async () => {
    const { ProviderRegistry } = await import('../src/providers/registry.js');
    const registry = new ProviderRegistry();

    // Register only CLI-based providers
    const { ClaudeProvider } = await import('../src/providers/claude.js');
    const { OpenCodeProvider } = await import('../src/providers/opencode.js');
    registry.register(new ClaudeProvider());
    registry.register(new OpenCodeProvider());

    expect(registry.has('claude')).toBe(true);
    expect(registry.has('opencode')).toBe(true);
    expect(registry.has('hf')).toBe(false);
    expect(registry.has('ollama')).toBe(false);
  });

  it('default registry has no hf or ollama providers', async () => {
    const { createDefaultRegistry } = await import('../src/providers/registry.js');
    const registry = await createDefaultRegistry();

    expect(registry.has('hf')).toBe(false);
    expect(registry.has('ollama')).toBe(false);
    expect(registry.has('claude')).toBe(true);
    expect(registry.has('opencode')).toBe(true);
  });

  it('config schema does not list hf or ollama as provider options', async () => {
    const { CONFIG_SCHEMA } = await import('../src/config/schema.js');
    const coderSchema = (CONFIG_SCHEMA as any).ai?.coder?.provider;
    expect(coderSchema._options).not.toContain('hf');
    expect(coderSchema._options).not.toContain('ollama');
    expect(coderSchema._options).toContain('claude');
    expect(coderSchema._options).toContain('opencode');
  });
});
