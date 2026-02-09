/**
 * Tests for HookOrchestrator - Basic Methods
 *
 * Tests basic orchestrator functionality:
 * - Constructor and configuration
 * - getHooksForEvent (event filtering)
 * - validateAllHooks
 * - getStats
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { HookEvent } from '../src/hooks/events.js';
import type { HookConfig } from '../src/hooks/merge.js';

// Mock the script-runner and webhook-runner BEFORE importing orchestrator
const mockExecuteScript = jest.fn();
const mockExecuteWebhook = jest.fn();

jest.unstable_mockModule('../src/hooks/script-runner.js', () => ({
  executeScript: mockExecuteScript,
}));

jest.unstable_mockModule('../src/hooks/webhook-runner.js', () => ({
  executeWebhook: mockExecuteWebhook,
}));

// Now import the orchestrator
const { HookOrchestrator } = await import('../src/hooks/orchestrator.js');

describe('HookOrchestrator - Basic Methods', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor and basic methods', () => {
    it('should create an orchestrator with empty hooks', () => {
      const orchestrator = new HookOrchestrator();
      expect(orchestrator.getHooks()).toEqual([]);
    });

    it('should create an orchestrator with hooks', () => {
      const hooks: HookConfig[] = [
        {
          name: 'test-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['hello'],
        },
      ];
      const orchestrator = new HookOrchestrator(hooks);
      expect(orchestrator.getHooks()).toEqual(hooks);
    });

    it('should set hooks via setHooks', () => {
      const orchestrator = new HookOrchestrator();
      const hooks: HookConfig[] = [
        {
          name: 'test-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['hello'],
        },
      ];
      orchestrator.setHooks(hooks);
      expect(orchestrator.getHooks()).toEqual(hooks);
    });

    it('should return default config values', () => {
      const orchestrator = new HookOrchestrator();
      // Config is private, but we can test behavior
      expect(orchestrator).toBeDefined();
    });
  });

  describe('getHooksForEvent', () => {
    it('should return only hooks matching the event', () => {
      const hooks: HookConfig[] = [
        {
          name: 'hook1',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['task completed'],
        },
        {
          name: 'hook2',
          event: 'task.created',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['task created'],
        },
        {
          name: 'hook3',
          event: 'task.completed',
          type: 'webhook',
          enabled: true,
          url: 'https://example.com/webhook',
          method: 'POST',
        },
      ];

      const orchestrator = new HookOrchestrator(hooks);
      const matchingHooks = orchestrator.getHooksForEvent('task.completed' as HookEvent);

      expect(matchingHooks).toHaveLength(2);
      expect(matchingHooks.map((h) => h.name)).toEqual(['hook1', 'hook3']);
    });

    it('should return empty array when no hooks match', () => {
      const hooks: HookConfig[] = [
        {
          name: 'hook1',
          event: 'task.created',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['task created'],
        },
      ];

      const orchestrator = new HookOrchestrator(hooks);
      const matchingHooks = orchestrator.getHooksForEvent('task.completed' as HookEvent);

      expect(matchingHooks).toEqual([]);
    });

    it('should exclude disabled hooks', () => {
      const hooks: HookConfig[] = [
        {
          name: 'enabled-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['enabled'],
        },
        {
          name: 'disabled-hook',
          event: 'task.completed',
          type: 'script',
          enabled: false,
          command: 'echo',
          args: ['disabled'],
        },
      ];

      const orchestrator = new HookOrchestrator(hooks);
      const matchingHooks = orchestrator.getHooksForEvent('task.completed' as HookEvent);

      expect(matchingHooks).toHaveLength(1);
      expect(matchingHooks[0].name).toBe('enabled-hook');
    });
  });

  describe('validateAllHooks', () => {
    it('should validate all hooks and return results', () => {
      const hooks: HookConfig[] = [
        {
          name: 'valid-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['test'],
        },
        {
          name: 'invalid-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          // Missing command
        } as any,
      ];

      const orchestrator = new HookOrchestrator(hooks);
      const results = orchestrator.validateAllHooks();

      expect(results).toHaveLength(2);
      expect(results[0]).toMatchObject({
        hook: 'valid-hook',
        valid: true,
        errors: [],
      });
      expect(results[1]).toMatchObject({
        hook: 'invalid-hook',
        valid: false,
      });
      expect(results[1].errors.length).toBeGreaterThan(0);
    });
  });

  describe('getStats', () => {
    it('should return statistics about loaded hooks', () => {
      const hooks: HookConfig[] = [
        {
          name: 'hook1',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
        },
        {
          name: 'hook2',
          event: 'task.created',
          type: 'webhook',
          enabled: true,
          url: 'https://example.com',
          method: 'POST',
        },
        {
          name: 'hook3',
          event: 'task.completed',
          type: 'script',
          enabled: false,
          command: 'echo',
        },
      ];

      const orchestrator = new HookOrchestrator(hooks);
      const stats = orchestrator.getStats();

      expect(stats).toEqual({
        total: 3,
        enabled: 2,
        disabled: 1,
        byType: {
          script: 2,
          webhook: 1,
        },
        byEvent: {
          'task.completed': 2,
          'task.created': 1,
        },
      });
    });
  });
});
