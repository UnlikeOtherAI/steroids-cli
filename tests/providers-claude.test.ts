/**
 * Claude Provider Tests
 */

import { describe, it, expect } from '@jest/globals';
import { ClaudeProvider } from '../src/providers/claude.js';

describe('ClaudeProvider', () => {
  let provider: ClaudeProvider;

  beforeEach(() => {
    provider = new ClaudeProvider();
  });

  describe('metadata', () => {
    it('should have correct name', () => {
      expect(provider.name).toBe('claude');
    });

    it('should have correct display name', () => {
      expect(provider.displayName).toBe('Anthropic Claude');
    });
  });

  describe('listModels', () => {
    it('should return available models', () => {
      const models = provider.listModels();

      expect(models).toContain('opus');
      expect(models).toContain('sonnet');
      expect(models).toContain('haiku');
    });
  });

  describe('getModelInfo', () => {
    it('should return model info array', () => {
      const modelInfo = provider.getModelInfo();

      expect(Array.isArray(modelInfo)).toBe(true);
      expect(modelInfo.length).toBeGreaterThan(0);

      const sonnet = modelInfo.find((m) => m.id === 'sonnet');
      expect(sonnet).toBeDefined();
      expect(sonnet?.name).toBe('Claude Sonnet (latest)');
      expect(sonnet?.supportsStreaming).toBe(true);
    });
  });

  describe('getDefaultModel', () => {
    it('should return opus for orchestrator', () => {
      expect(provider.getDefaultModel('orchestrator')).toBe('opus');
    });

    it('should return sonnet for coder', () => {
      expect(provider.getDefaultModel('coder')).toBe('sonnet');
    });

    it('should return opus for reviewer', () => {
      expect(provider.getDefaultModel('reviewer')).toBe('opus');
    });
  });

  describe('getDefaultInvocationTemplate', () => {
    it('should return default template', () => {
      const template = provider.getDefaultInvocationTemplate();

      expect(template).toContain('{cli}');
      expect(template).toContain('{prompt_file}');
      expect(template).toContain('{model}');
    });
  });

  describe('buildCommand', () => {
    it('should build command from template', () => {
      const command = (provider as any).buildCommand('/tmp/prompt.txt', 'sonnet');

      expect(command).toContain('claude');
      expect(command).toContain('/tmp/prompt.txt');
      expect(command).toContain('sonnet');
    });

    it('should use custom CLI path when set', () => {
      provider.setCliPath('/custom/path/claude');

      const command = (provider as any).buildCommand('/tmp/prompt.txt', 'sonnet');

      expect(command).toContain('/custom/path/claude');
    });
  });

  describe('classifyError', () => {
    it('should return null for exit code 0', () => {
      const error = provider.classifyError(0, '');
      expect(error).toBeNull();
    });

    it('should detect rate limit errors', () => {
      const error = provider.classifyError(1, 'rate limit exceeded');

      expect(error?.type).toBe('rate_limit');
      expect(error?.retryable).toBe(true);
      expect(error?.retryAfterMs).toBeGreaterThan(0);
    });

    it('should detect auth errors', () => {
      const error = provider.classifyError(1, 'unauthorized: authentication failed');

      expect(error?.type).toBe('auth_error');
      expect(error?.retryable).toBe(false);
    });

    it('should detect network errors', () => {
      const error = provider.classifyError(1, 'connection timeout');

      expect(error?.type).toBe('network_error');
      expect(error?.retryable).toBe(true);
    });

    it('should detect model not found errors', () => {
      const error = provider.classifyError(1, 'model not found');

      expect(error?.type).toBe('model_not_found');
      expect(error?.retryable).toBe(false);
    });

    it('should detect context exceeded errors', () => {
      const error = provider.classifyError(1, 'context limit exceeded');

      expect(error?.type).toBe('context_exceeded');
      expect(error?.retryable).toBe(false);
    });

    it('should return unknown for unrecognized errors', () => {
      const error = provider.classifyError(1, 'some random error');

      expect(error?.type).toBe('unknown');
      expect(error?.retryable).toBe(true);
    });
  });

  describe('CLI path management', () => {
    it('should return undefined CLI path by default', () => {
      expect(provider.getCliPath()).toBeUndefined();
    });

    it('should set and get custom CLI path', () => {
      provider.setCliPath('/custom/claude');

      expect(provider.getCliPath()).toBe('/custom/claude');
    });
  });

  describe('invocation template management', () => {
    it('should return default template initially', () => {
      const template = provider.getInvocationTemplate();

      expect(template).toBe(provider.getDefaultInvocationTemplate());
    });

    it('should set and get custom template', () => {
      const customTemplate = 'custom {cli} -f {prompt_file} -m {model}';
      provider.setInvocationTemplate(customTemplate);

      expect(provider.getInvocationTemplate()).toBe(customTemplate);
    });
  });
});
