import { describe, expect, it } from '@jest/globals';
import { OpenCodeProvider } from '../src/providers/opencode.js';

describe('OpenCodeProvider', () => {
  it('returns correct metadata', () => {
    const provider = new OpenCodeProvider();
    expect(provider.name).toBe('opencode');
    expect(provider.displayName).toBe('OpenCode');
    expect(provider.listModels()).toEqual([]);
    expect(provider.getModelInfo()).toEqual([]);
    expect(provider.getDefaultModel('coder')).toBeUndefined();
    expect(provider.getDefaultModel('reviewer')).toBeUndefined();
    expect(provider.getDefaultModel('orchestrator')).toBeUndefined();
  });

  it('returns default invocation template with expected placeholders', () => {
    const provider = new OpenCodeProvider();
    const template = provider.getDefaultInvocationTemplate();
    expect(template).toContain('{cli}');
    expect(template).toContain('{model}');
    expect(template).toContain('{prompt_file}');
    expect(template).toContain('{session_id}');
    expect(template).toContain('--format json');
  });

  describe('parseJsonLine', () => {
    const provider = new OpenCodeProvider();

    it('parses text events', () => {
      const line = JSON.stringify({
        type: 'text',
        sessionID: 'sess-123',
        part: { text: 'Hello world' },
      });
      const result = provider.parseJsonLine(line);
      expect(result.text).toBe('Hello world');
      expect(result.sessionId).toBe('sess-123');
    });

    it('parses tool_use events', () => {
      const line = JSON.stringify({
        type: 'tool_use',
        sessionID: 'sess-456',
        part: { tool: 'read_file' },
      });
      const result = provider.parseJsonLine(line);
      expect(result.tool).toBe('read_file');
      expect(result.sessionId).toBe('sess-456');
    });

    it('parses step_finish events with token usage', () => {
      const line = JSON.stringify({
        type: 'step_finish',
        sessionID: 'sess-789',
        part: { tokens: { input: 1500, output: 300 } },
      });
      const result = provider.parseJsonLine(line);
      expect(result.tokenUsage).toEqual({ inputTokens: 1500, outputTokens: 300 });
      expect(result.sessionId).toBe('sess-789');
    });

    it('parses error events', () => {
      const line = JSON.stringify({
        type: 'error',
        sessionID: 'sess-err',
        error: { message: 'model not found' },
      });
      const result = provider.parseJsonLine(line);
      expect(result.error).toBe('model not found');
      expect(result.sessionId).toBe('sess-err');
    });

    it('extracts sessionID from step_start (no-op otherwise)', () => {
      const line = JSON.stringify({
        type: 'step_start',
        sessionID: 'sess-start',
      });
      const result = provider.parseJsonLine(line);
      expect(result.sessionId).toBe('sess-start');
      expect(result.text).toBeUndefined();
      expect(result.tool).toBeUndefined();
    });

    it('handles missing sessionID gracefully', () => {
      const line = JSON.stringify({
        type: 'text',
        part: { text: 'no session' },
      });
      const result = provider.parseJsonLine(line);
      expect(result.text).toBe('no session');
      expect(result.sessionId).toBeUndefined();
    });

    it('handles malformed JSON as plain text', () => {
      const result = provider.parseJsonLine('not json at all');
      expect(result.text).toBe('not json at all');
    });

    it('handles empty lines', () => {
      const result = provider.parseJsonLine('');
      expect(result).toEqual({});
    });

    it('defaults missing token values to zero', () => {
      const line = JSON.stringify({
        type: 'step_finish',
        sessionID: 's1',
        part: { tokens: {} },
      });
      const result = provider.parseJsonLine(line);
      expect(result.tokenUsage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });

    it('defaults missing error message', () => {
      const line = JSON.stringify({
        type: 'error',
        sessionID: 's1',
        error: {},
      });
      const result = provider.parseJsonLine(line);
      expect(result.error).toBe('Unknown OpenCode error');
    });
  });

  describe('error classification', () => {
    const provider = new OpenCodeProvider();

    it('classifies rate limit errors', () => {
      const result = provider.classifyResult({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'rate limit exceeded, please retry',
        duration: 10,
        timedOut: false,
      });
      expect(result?.type).toBe('rate_limit');
      expect(result?.retryable).toBe(true);
    });

    it('classifies auth errors', () => {
      const result = provider.classifyResult({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'unauthorized: invalid token',
        duration: 10,
        timedOut: false,
      });
      expect(result?.type).toBe('auth_error');
      expect(result?.retryable).toBe(false);
    });

    it('classifies model not found errors', () => {
      const result = provider.classifyResult({
        success: false,
        exitCode: 1,
        stdout: '',
        stderr: 'model "foo/bar" not found',
        duration: 10,
        timedOut: false,
      });
      expect(result?.type).toBe('model_not_found');
      expect(result?.retryable).toBe(false);
    });

    it('returns null for successful results', () => {
      const result = provider.classifyResult({
        success: true,
        exitCode: 0,
        stdout: 'ok',
        stderr: '',
        duration: 10,
        timedOut: false,
      });
      expect(result).toBeNull();
    });
  });

  describe('command building', () => {
    it('builds command with model and empty session_id', () => {
      const provider = new OpenCodeProvider();
      const template = provider.getInvocationTemplate();
      const command = template
        .replace('{cli}', 'opencode')
        .replace('{model}', 'huggingface/deepseek-ai/DeepSeek-V3')
        .replace('{prompt_file}', '/tmp/prompt.txt')
        .replace('{session_id}', '');
      expect(command).toContain('opencode run');
      expect(command).toContain('-m huggingface/deepseek-ai/DeepSeek-V3');
      expect(command).toContain('--format json');
      expect(command).toContain('/tmp/prompt.txt');
    });

    it('builds command with session_id for resumption', () => {
      const provider = new OpenCodeProvider();
      const template = provider.getInvocationTemplate();
      const command = template
        .replace('{cli}', 'opencode')
        .replace('{model}', 'ollama/llama3.3:70b')
        .replace('{prompt_file}', '/tmp/prompt.txt')
        .replace('{session_id}', '--session abc-123');
      expect(command).toContain('--session abc-123');
      expect(command).toContain('-m ollama/llama3.3:70b');
    });
  });
});
