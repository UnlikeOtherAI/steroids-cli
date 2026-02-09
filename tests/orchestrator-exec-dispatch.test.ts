/**
 * Tests for HookOrchestrator - Dispatch and Results
 *
 * Tests executeHooksForEvent dispatch and result handling:
 * - Correct dispatch to script-runner and webhook-runner
 * - HookExecutionResult fields (success, duration, error, scriptResult, webhookResult)
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

describe('HookOrchestrator - Dispatch and Results', () => {
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

  describe('executeHooksForEvent - dispatch to correct runner', () => {
    it('should dispatch script hooks to executeScript', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'script-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['test'],
        },
      ];

      mockExecuteScript.mockResolvedValue({
        success: true,
        duration: 100,
        exitCode: 0,
        stdout: 'test',
        stderr: '',
      });

      const orchestrator = new HookOrchestrator(hooks);
      const payload = createTestPayload();
      await orchestrator.executeHooksForEvent('task.completed' as HookEvent, payload);

      expect(mockExecuteScript).toHaveBeenCalledTimes(1);
      expect(mockExecuteScript).toHaveBeenCalledWith(
        expect.objectContaining({
          command: 'echo',
          args: ['test'],
        }),
        payload
      );
      expect(mockExecuteWebhook).not.toHaveBeenCalled();
    });

    it('should dispatch webhook hooks to executeWebhook', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'webhook-hook',
          event: 'task.completed',
          type: 'webhook',
          enabled: true,
          url: 'https://example.com/webhook',
          method: 'POST',
        },
      ];

      mockExecuteWebhook.mockResolvedValue({
        success: true,
        duration: 200,
        statusCode: 200,
        body: 'OK',
      });

      const orchestrator = new HookOrchestrator(hooks);
      const payload = createTestPayload();
      await orchestrator.executeHooksForEvent('task.completed' as HookEvent, payload);

      expect(mockExecuteWebhook).toHaveBeenCalledTimes(1);
      expect(mockExecuteWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://example.com/webhook',
          method: 'POST',
        }),
        payload
      );
      expect(mockExecuteScript).not.toHaveBeenCalled();
    });

    it('should dispatch to both runners for mixed hooks', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'script-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['script'],
        },
        {
          name: 'webhook-hook',
          event: 'task.completed',
          type: 'webhook',
          enabled: true,
          url: 'https://example.com/webhook',
          method: 'POST',
        },
      ];

      mockExecuteScript.mockResolvedValue({
        success: true,
        duration: 100,
        exitCode: 0,
        stdout: 'script',
        stderr: '',
      });

      mockExecuteWebhook.mockResolvedValue({
        success: true,
        duration: 200,
        statusCode: 200,
        body: 'OK',
      });

      const orchestrator = new HookOrchestrator(hooks);
      await orchestrator.executeHooksForEvent('task.completed' as HookEvent, createTestPayload());

      expect(mockExecuteScript).toHaveBeenCalledTimes(1);
      expect(mockExecuteWebhook).toHaveBeenCalledTimes(1);
    });
  });

  describe('executeHooksForEvent - HookExecutionResult fields', () => {
    it('should return HookExecutionResult with success, duration, and scriptResult for script hooks', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'script-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'echo',
          args: ['test'],
        },
      ];

      const scriptResult = {
        success: true,
        duration: 123,
        exitCode: 0,
        stdout: 'test output',
        stderr: '',
      };

      mockExecuteScript.mockResolvedValue(scriptResult);

      const orchestrator = new HookOrchestrator(hooks);
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        hookName: 'script-hook',
        hookType: 'script',
        success: true,
        duration: 123,
        error: undefined,
        scriptResult,
      });
      expect(results[0].webhookResult).toBeUndefined();
    });

    it('should return HookExecutionResult with success, duration, and webhookResult for webhook hooks', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'webhook-hook',
          event: 'task.completed',
          type: 'webhook',
          enabled: true,
          url: 'https://example.com/webhook',
          method: 'POST',
        },
      ];

      const webhookResult = {
        success: true,
        duration: 456,
        statusCode: 200,
        body: 'Webhook response',
      };

      mockExecuteWebhook.mockResolvedValue(webhookResult);

      const orchestrator = new HookOrchestrator(hooks);
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        hookName: 'webhook-hook',
        hookType: 'webhook',
        success: true,
        duration: 456,
        error: undefined,
        webhookResult,
      });
      expect(results[0].scriptResult).toBeUndefined();
    });

    it('should include error field when hook fails', async () => {
      const hooks: HookConfig[] = [
        {
          name: 'failing-hook',
          event: 'task.completed',
          type: 'script',
          enabled: true,
          command: 'false',
        },
      ];

      mockExecuteScript.mockResolvedValue({
        success: false,
        duration: 50,
        exitCode: 1,
        stdout: '',
        stderr: 'Error output',
        error: 'Command failed with exit code 1',
      });

      const orchestrator = new HookOrchestrator(hooks);
      const results = await orchestrator.executeHooksForEvent(
        'task.completed' as HookEvent,
        createTestPayload()
      );

      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({
        hookName: 'failing-hook',
        hookType: 'script',
        success: false,
        duration: 50,
        error: 'Command failed with exit code 1',
      });
    });
  });
});
