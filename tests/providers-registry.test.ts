/**
 * Provider Registry Tests
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { ProviderRegistry } from '../src/providers/registry.js';
import { ClaudeProvider } from '../src/providers/claude.js';
import { CodexProvider } from '../src/providers/codex.js';
import { GeminiProvider } from '../src/providers/gemini.js';
import { OpenAIProvider } from '../src/providers/openai.js';

describe('ProviderRegistry', () => {
  let registry: ProviderRegistry;

  beforeEach(() => {
    registry = new ProviderRegistry();
  });

  describe('register', () => {
    it('should register a provider', () => {
      const provider = new ClaudeProvider();
      registry.register(provider);

      expect(registry.has('claude')).toBe(true);
      expect(registry.get('claude')).toBe(provider);
    });

    it('should throw error when registering duplicate provider', () => {
      const provider = new ClaudeProvider();
      registry.register(provider);

      expect(() => {
        registry.register(provider);
      }).toThrow("Provider 'claude' is already registered");
    });
  });

  describe('unregister', () => {
    it('should unregister a provider', () => {
      const provider = new ClaudeProvider();
      registry.register(provider);

      const result = registry.unregister('claude');

      expect(result).toBe(true);
      expect(registry.has('claude')).toBe(false);
    });

    it('should return false when unregistering non-existent provider', () => {
      const result = registry.unregister('nonexistent');
      expect(result).toBe(false);
    });
  });

  describe('get', () => {
    it('should get a registered provider', () => {
      const provider = new ClaudeProvider();
      registry.register(provider);

      const retrieved = registry.get('claude');

      expect(retrieved).toBe(provider);
    });

    it('should throw error when getting non-existent provider', () => {
      expect(() => {
        registry.get('nonexistent');
      }).toThrow("Provider 'nonexistent' not found");
    });
  });

  describe('tryGet', () => {
    it('should return provider if exists', () => {
      const provider = new ClaudeProvider();
      registry.register(provider);

      const retrieved = registry.tryGet('claude');

      expect(retrieved).toBe(provider);
    });

    it('should return undefined if provider does not exist', () => {
      const retrieved = registry.tryGet('nonexistent');
      expect(retrieved).toBeUndefined();
    });
  });

  describe('getNames', () => {
    it('should return empty array for empty registry', () => {
      expect(registry.getNames()).toEqual([]);
    });

    it('should return all registered provider names', () => {
      registry.register(new ClaudeProvider());
      registry.register(new CodexProvider());

      const names = registry.getNames();

      expect(names).toHaveLength(2);
      expect(names).toContain('claude');
      expect(names).toContain('codex');
    });
  });

  describe('getAll', () => {
    it('should return empty array for empty registry', () => {
      expect(registry.getAll()).toEqual([]);
    });

    it('should return all registered providers', () => {
      const claude = new ClaudeProvider();
      const codex = new CodexProvider();

      registry.register(claude);
      registry.register(codex);

      const providers = registry.getAll();

      expect(providers).toHaveLength(2);
      expect(providers).toContain(claude);
      expect(providers).toContain(codex);
    });
  });

  describe('validateProviderModel', () => {
    it('should validate correct provider/model combination', () => {
      const provider = new ClaudeProvider();
      registry.register(provider);

      expect(() => {
        registry.validateProviderModel('claude', 'sonnet');
      }).not.toThrow();
    });

    it('should throw error for invalid model', () => {
      const provider = new ClaudeProvider();
      registry.register(provider);

      expect(() => {
        registry.validateProviderModel('claude', 'invalid-model');
      }).toThrow("Model 'invalid-model' not available for provider 'claude'");
    });

    it('should throw error for non-existent provider', () => {
      expect(() => {
        registry.validateProviderModel('nonexistent', 'model');
      }).toThrow("Provider 'nonexistent' not found");
    });
  });

  describe('default registry', () => {
    it('should have all built-in providers', () => {
      const { createDefaultRegistry } = require('../src/providers/registry.js');
      const defaultRegistry = createDefaultRegistry();

      expect(defaultRegistry.has('claude')).toBe(true);
      expect(defaultRegistry.has('codex')).toBe(true);
      expect(defaultRegistry.has('gemini')).toBe(true);
      expect(defaultRegistry.has('openai')).toBe(true);
    });
  });
});
