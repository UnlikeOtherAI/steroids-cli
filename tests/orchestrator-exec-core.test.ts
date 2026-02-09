/**
 * Tests for HookOrchestrator - Core Execution
 *
 * Tests core executeHooksForEvent functionality:
 * - Event matching (only hooks for the event execute)
 * - Invalid hook config handling
 * - continueOnError behavior
 */

// @ts-nocheck
import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import type { HookEvent } from '../src/hooks/events.js';
import type { TaskCompletedPayload } from '../src/hooks/payload.js';
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

describe('HookOrchestrator - Core Execution', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const createTestPayload = (): TaskCompletedPayload => ({
    event: 'task.completed',
    timestamp: '2026-02-09T12:00:00Z',
    task: {
      id: 'task-123',
      title: 'Test Task',
      status: 'completed',
      sectionId: 'section-456',
    },
    project: {
      name: 'test-project',
      path: '/tmp/test-project',
    },
  });

  describe('executeHooksForEvent - event matching', () => {
    it('should only execute hooks for the given event', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'task-completed-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['completed'],
        },
        {
          name: 'task-created-hook',
          event: 'task.created',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['created'],
        },
      ];

      mockExecuteScript.mockResolvedValue({
        success: true,
        duration: 100,
        exitCode: 0,
        stdout: 'completed',
        stderr: '',
      });

      const orchestrator = new HookOrchestrator(hooks);
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(1);
      expect(results[0].hookName).toBe('task-completed-hook');
      expect(mockExecuteScript).toHaveBeenCalledTimes(1);
    });

    it('should return empty array when no hooks match event', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'task-created-hook',
          event: 'task.created',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['created'],
        },
      ];

      const orchestrator = new HookOrchestrator(hooks);
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toEqual([]);
      expect(mockExecuteScript).not.toHaveBeenCalled();
    });
  });

  describe('executeHooksForEvent - invalid hook config', () => {
    it('should return error result when hook config is invalid (missing command)', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'invalid-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          // Missing command field
        } as any,
      ];

      const orchestrator = new HookOrchestrator(hooks);
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        hookName: 'invalid-hook',
        hookType: 'script',
        success: false,
        duration: 0,
      });
      expect(results[0].error).toContain('Invalid hook configuration');
      expect(mockExecuteScript).not.toHaveBeenCalled();
    });

    it('should return error result when webhook config is invalid (missing url)', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'invalid-webhook',
          event: 'task.completed',
          type: 'webhook',
          enabled: true,
          method: 'POST',
          // Missing url field
        } as any,
      ];

      const orchestrator = new HookOrchestrator(hooks);
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        hookName: 'invalid-webhook',
        hookType: 'webhook',
        success: false,
        duration: 0,
      });
      expect(results[0].error).toContain('Invalid hook configuration');
      expect(mockExecuteWebhook).not.toHaveBeenCalled();
    });
  });

  describe('executeHooksForEvent - continueOnError behavior', () => {
    it('should stop after first failure when continueOnError is false', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'failing-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'false',
        },
        {
          name: 'should-not-run',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['should not run'],
        },
      ];

      mockExecuteScript.mockResolvedValueOnce({
        success: false,
        duration: 50,
        exitCode: 1,
        stdout: '',
        stderr: 'Command failed',
        error: 'Command failed',
      });

      const orchestrator = new HookOrchestrator(hooks, { continueOnError: false });
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(1);
      expect(results[0].hookName).toBe('failing-hook');
      expect(results[0].success).toBe(false);
      expect(mockExecuteScript).toHaveBeenCalledTimes(1);
    });

    it('should continue after failure when continueOnError is true', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'failing-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'false',
        },
        {
          name: 'should-run',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['should run'],
        },
      ];

      mockExecuteScript
        .mockResolvedValueOnce({
          success: false,
          duration: 50,
          exitCode: 1,
          stdout: '',
          stderr: 'Command failed',
          error: 'Command failed',
        })
        .mockResolvedValueOnce({
          success: true,
          duration: 100,
          exitCode: 0,
          stdout: 'should run',
          stderr: '',
        });

      const orchestrator = new HookOrchestrator(hooks, { continueOnError: true });
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(2);
      expect(results[0].hookName).toBe('failing-hook');
      expect(results[0].success).toBe(false);
      expect(results[1].hookName).toBe('should-run');
      expect(results[1].success).toBe(true);
      expect(mockExecuteScript).toHaveBeenCalledTimes(2);
    });

    it('should stop after first invalid config when continueOnError is false', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'invalid-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          // Missing command
        } as any,
        {
          name: 'should-not-run',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['should not run'],
        },
      ];

      const orchestrator = new HookOrchestrator(hooks, { continueOnError: false });
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(1);
      expect(results[0].hookName).toBe('invalid-hook');
      expect(results[0].success).toBe(false);
      expect(mockExecuteScript).not.toHaveBeenCalled();
    });

    it('should continue after invalid config when continueOnError is true (default)', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'invalid-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          // Missing command
        } as any,
        {
          name: 'valid-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['valid'],
        },
      ];

      mockExecuteScript.mockResolvedValue({
        success: true,
        duration: 100,
        exitCode: 0,
        stdout: 'valid',
        stderr: '',
      });

      const orchestrator = new HookOrchestrator(hooks); // Default continueOnError: true
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(2);
      expect(results[0].hookName).toBe('invalid-hook');
      expect(results[0].success).toBe(false);
      expect(results[1].hookName).toBe('valid-hook');
      expect(results[1].success).toBe(true);
      expect(mockExecuteScript).toHaveBeenCalledTimes(1);
    });
  });
});
