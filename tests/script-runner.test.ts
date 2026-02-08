/**
 * Tests for Script Hook Runner
 */

import {
  executeScript,
  parseTimeout,
  validateScriptConfig,
  type ScriptHookConfig,
} from '../src/hooks/script-runner.js';
import { createTaskCompletedPayload } from '../src/hooks/payload.js';

describe('Script Runner', () => {
  describe('parseTimeout', () => {
    it('should use default timeout when undefined', () => {
      expect(parseTimeout(undefined)).toBe(60000); // 60 seconds
    });

    it('should convert number to milliseconds', () => {
      expect(parseTimeout(30)).toBe(30000);
      expect(parseTimeout(120)).toBe(120000);
    });

    it('should parse seconds', () => {
      expect(parseTimeout('60s')).toBe(60000);
      expect(parseTimeout('30s')).toBe(30000);
    });

    it('should parse minutes', () => {
      expect(parseTimeout('5m')).toBe(300000);
      expect(parseTimeout('1m')).toBe(60000);
    });

    it('should parse hours', () => {
      expect(parseTimeout('1h')).toBe(3600000);
      expect(parseTimeout('2h')).toBe(7200000);
    });

    it('should default to seconds when no unit specified', () => {
      expect(parseTimeout('45')).toBe(45000);
    });

    it('should throw error for invalid format', () => {
      expect(() => parseTimeout('invalid')).toThrow('Invalid timeout format');
      expect(() => parseTimeout('30x')).toThrow('Invalid timeout format');
      expect(() => parseTimeout('abc')).toThrow('Invalid timeout format');
    });
  });

  describe('validateScriptConfig', () => {
    it('should validate valid config', () => {
      const config: ScriptHookConfig = {
        name: 'test-hook',
        command: 'echo',
        args: ['hello'],
      };

      const result = validateScriptConfig(config);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should require name', () => {
      const config = {
        name: '',
        command: 'echo',
      } as ScriptHookConfig;

      const result = validateScriptConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: name');
    });

    it('should require command', () => {
      const config = {
        name: 'test',
        command: '',
      } as ScriptHookConfig;

      const result = validateScriptConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Missing required field: command');
    });

    it('should validate timeout format', () => {
      const config: ScriptHookConfig = {
        name: 'test',
        command: 'echo',
        timeout: 'invalid' as unknown as number,
      };

      const result = validateScriptConfig(config);
      expect(result.valid).toBe(false);
      expect(result.errors[0]).toContain('Invalid timeout format');
    });
  });

  describe('executeScript', () => {
    const payload = createTaskCompletedPayload(
      {
        id: 'task-123',
        title: 'Test Task',
        status: 'completed',
        section: 'Backend',
        sectionId: 'section-456',
      },
      {
        name: 'test-project',
        path: '/tmp/test-project',
      }
    );

    it('should execute simple command', async () => {
      const config: ScriptHookConfig = {
        name: 'echo-test',
        command: 'echo',
        args: ['hello world'],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('hello world');
      expect(result.stderr).toBe('');
      expect(result.duration).toBeGreaterThan(0);
    });

    it('should resolve template variables in arguments', async () => {
      const config: ScriptHookConfig = {
        name: 'template-test',
        command: 'echo',
        args: ['Task: {{task.title}}', 'Status: {{task.status}}'],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Test Task');
      expect(result.stdout).toContain('completed');
    });

    it('should resolve environment variables', async () => {
      process.env.TEST_VAR = 'test-value';

      const config: ScriptHookConfig = {
        name: 'env-test',
        command: 'echo',
        args: ['${TEST_VAR}'],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('test-value');

      delete process.env.TEST_VAR;
    });

    it('should use project path as default cwd', async () => {
      const config: ScriptHookConfig = {
        name: 'pwd-test',
        command: 'pwd',
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain(payload.project.path);
    });

    it('should use custom cwd when provided', async () => {
      const config: ScriptHookConfig = {
        name: 'cwd-test',
        command: 'pwd',
        cwd: '/tmp',
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      // On macOS, /tmp might resolve to /private/tmp or other paths
      expect(result.stdout).toMatch(/tmp$/);
    });

    it('should handle command failure', async () => {
      const config: ScriptHookConfig = {
        name: 'fail-test',
        command: 'exit',
        args: ['1'],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
    });

    it('should handle command not found', async () => {
      const config: ScriptHookConfig = {
        name: 'notfound-test',
        command: 'nonexistent-command-xyz',
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(false);
      // Command not found produces a non-zero exit code
      expect(result.exitCode).not.toBe(0);
    });

    it('should timeout long-running commands', async () => {
      const config: ScriptHookConfig = {
        name: 'timeout-test',
        command: 'sleep',
        args: ['10'],
        timeout: 1, // 1 second
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(false);
      expect(result.timedOut).toBe(true);
      expect(result.error).toContain('timed out');
      expect(result.duration).toBeLessThan(2000); // Should timeout within 2s
    }, 10000); // Test timeout of 10s

    it('should execute async without waiting', async () => {
      const config: ScriptHookConfig = {
        name: 'async-test',
        command: 'sleep',
        args: ['5'],
        async: true,
      };

      const startTime = Date.now();
      const result = await executeScript(config, payload);
      const duration = Date.now() - startTime;

      // Should return immediately
      expect(result.success).toBe(true);
      expect(result.exitCode).toBeNull();
      expect(duration).toBeLessThan(1000); // Should return in less than 1 second
    });

    it('should capture stdout and stderr', async () => {
      const config: ScriptHookConfig = {
        name: 'output-test',
        command: 'sh -c "echo stdout; echo stderr >&2"',
        args: [],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('stdout');
      expect(result.stderr).toBe('stderr');
    });

    it('should handle multiple template variables', async () => {
      const config: ScriptHookConfig = {
        name: 'multi-template-test',
        command: 'echo',
        args: [
          '{{event}}',
          '{{task.id}}',
          '{{project.name}}',
          '{{timestamp}}',
        ],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('task.completed');
      expect(result.stdout).toContain('task-123');
      expect(result.stdout).toContain('test-project');
    });

    it('should handle complex shell commands', async () => {
      const config: ScriptHookConfig = {
        name: 'complex-test',
        command: 'echo "Task {{task.title}}" | tr " " "-"',
        args: [],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('Task-Test-Task');
    });

    it('should preserve argument order', async () => {
      const config: ScriptHookConfig = {
        name: 'order-test',
        command: 'echo',
        args: ['first', 'second', 'third'],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toBe('first second third');
    });

    it('should handle empty arguments array', async () => {
      const config: ScriptHookConfig = {
        name: 'no-args-test',
        command: 'pwd',
        args: [],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toBeTruthy();
    });

    it('should handle undefined arguments', async () => {
      const config: ScriptHookConfig = {
        name: 'undefined-args-test',
        command: 'echo',
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
    });

    it('should track execution duration', async () => {
      const config: ScriptHookConfig = {
        name: 'duration-test',
        command: 'sleep',
        args: ['0.1'],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.duration).toBeGreaterThan(100); // At least 100ms
      expect(result.duration).toBeLessThan(500); // But not too long
    });

    it('should handle special characters in arguments', async () => {
      const config: ScriptHookConfig = {
        name: 'special-chars-test',
        command: 'echo',
        args: ['test@email.com'],
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('test@email.com');
    });

    it('should resolve templated cwd', async () => {
      const config: ScriptHookConfig = {
        name: 'template-cwd-test',
        command: 'pwd',
        cwd: '{{project.path}}',
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      // On macOS, paths might be resolved differently
      expect(result.stdout).toContain('test-project');
    });
  });

  describe('integration scenarios', () => {
    const payload = createTaskCompletedPayload(
      {
        id: 'integration-task',
        title: 'Integration Test',
        status: 'completed',
      },
      {
        name: 'integration-project',
        path: '/tmp',
      }
    );

    it('should handle real-world notification script', async () => {
      const config: ScriptHookConfig = {
        name: 'notify',
        command: 'echo',
        args: [
          'Task completed:',
          '{{task.title}}',
          'in project',
          '{{project.name}}',
        ],
        timeout: 30,
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Integration Test');
      expect(result.stdout).toContain('integration-project');
    });

    it('should handle deployment-like script', async () => {
      const config: ScriptHookConfig = {
        name: 'deploy',
        command: 'echo "Deploying {{project.name}}" && exit 0',
        args: [],
        timeout: 60,
      };

      const result = await executeScript(config, payload);

      expect(result.success).toBe(true);
      expect(result.stdout).toContain('Deploying integration-project');
    });

    it('should handle async background task', async () => {
      const config: ScriptHookConfig = {
        name: 'background-job',
        command: 'echo',
        args: ['Background processing for {{task.title}}'],
        async: true,
      };

      const result = await executeScript(config, payload);

      // Should return immediately without waiting
      expect(result.success).toBe(true);
      expect(result.duration).toBeLessThan(1000);
    });
  });
});
