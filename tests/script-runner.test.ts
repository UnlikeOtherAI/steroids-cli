/**
 * Script Runner Tests
 */

import { describe, it, expect } from '@jest/globals';
import {
  parseTimeout,
  validateScriptConfig,
  executeScript,
  type ScriptHookConfig,
} from '../src/hooks/script-runner.js';
import type { HookPayload } from '../src/hooks/payload.js';

describe('parseTimeout', () => {
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

  it('should default to seconds if no unit', () => {
    expect(parseTimeout('60')).toBe(60000);
  });

  it('should handle number input', () => {
    expect(parseTimeout(60)).toBe(60000);
  });

  it('should use default if undefined', () => {
    expect(parseTimeout(undefined)).toBe(60000);
  });

  it('should throw on invalid format', () => {
    expect(() => parseTimeout('invalid')).toThrow('Invalid timeout format');
  });
});

describe('validateScriptConfig', () => {
  it('should validate valid config', () => {
    const config: ScriptHookConfig = {
      name: 'test-hook',
      command: './test.sh',
      args: ['arg1'],
      timeout: 60,
    };

    const result = validateScriptConfig(config);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should require name', () => {
    const config: ScriptHookConfig = {
      name: '',
      command: './test.sh',
    };

    const result = validateScriptConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: name');
  });

  it('should require command', () => {
    const config: ScriptHookConfig = {
      name: 'test-hook',
      command: '',
    };

    const result = validateScriptConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Missing required field: command');
  });

  it('should validate timeout format', () => {
    const config: ScriptHookConfig = {
      name: 'test-hook',
      command: './test.sh',
      timeout: 'invalid',
    };

    const result = validateScriptConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('executeScript', () => {
  const mockPayload: HookPayload = {
    event: 'task.completed',
    timestamp: '2024-01-01T00:00:00Z',
    task: {
      id: 'task-123',
      title: 'Test Task With Spaces',
      status: 'completed',
      sectionId: 'section-1',
    },
    project: {
      name: 'test-project',
      path: '/tmp',
    },
  };

  it('should capture stdout from script', async () => {
    const config: ScriptHookConfig = {
      name: 'test-stdout',
      command: process.execPath,
      args: ['-e', 'console.log("hello world")'],
      timeout: '5s',
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello world');
    expect(result.stderr).toBe('');
    expect(result.timedOut).toBeUndefined();
  });

  it('should capture stderr from script', async () => {
    const config: ScriptHookConfig = {
      name: 'test-stderr',
      command: process.execPath,
      args: ['-e', 'console.error("error message")'],
      timeout: '5s',
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('error message');
  });

  it('should preserve args containing spaces', async () => {
    const config: ScriptHookConfig = {
      name: 'test-args-spaces',
      command: process.execPath,
      args: [
        '-e',
        'process.argv.slice(1).forEach((a,i)=>console.log(`arg${i}:${a}`))',
        'hello world',
        'foo bar',
      ],
      timeout: '5s',
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('arg0:hello world');
    expect(result.stdout).toContain('arg1:foo bar');
  });

  it('should handle templated args with spaces', async () => {
    const config: ScriptHookConfig = {
      name: 'test-template-spaces',
      command: process.execPath,
      args: ['-e', 'console.log(process.argv[1])', '{{task.title}}'],
      timeout: '5s',
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('Test Task With Spaces');
  });

  it('should timeout and set timedOut flag', async () => {
    const config: ScriptHookConfig = {
      name: 'test-timeout',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10000)'], // Sleep for 10s
      timeout: '1s',
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(false);
    expect(result.timedOut).toBe(true);
    expect(result.error).toContain('timed out');
  }, 10000); // Jest timeout

  it('should handle non-zero exit codes', async () => {
    const config: ScriptHookConfig = {
      name: 'test-exit-code',
      command: process.execPath,
      args: ['-e', 'process.exit(42)'],
      timeout: '5s',
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(42);
  });

  it('should handle async execution (fire-and-forget)', async () => {
    const config: ScriptHookConfig = {
      name: 'test-async',
      command: process.execPath,
      args: ['-e', 'setTimeout(() => console.log("async"), 1000)'],
      timeout: '5s',
      async: true,
    };

    const startTime = Date.now();
    const result = await executeScript(config, mockPayload);
    const duration = Date.now() - startTime;

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(null);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(duration).toBeLessThan(500); // Should return immediately
  });

  it('should handle spawn errors gracefully', async () => {
    const config: ScriptHookConfig = {
      name: 'test-spawn-error',
      command: '/nonexistent/command',
      args: [],
      timeout: '5s',
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(null);
    expect(result.error).toBeDefined();
  });

  it('should support string timeout durations', async () => {
    const config: ScriptHookConfig = {
      name: 'test-string-timeout',
      command: process.execPath,
      args: ['-e', 'console.log("quick")'],
      timeout: '60s',
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('quick');
  });

  it('should support numeric timeout', async () => {
    const config: ScriptHookConfig = {
      name: 'test-numeric-timeout',
      command: process.execPath,
      args: ['-e', 'console.log("quick")'],
      timeout: 60,
    };

    const result = await executeScript(config, mockPayload);

    expect(result.success).toBe(true);
    expect(result.stdout).toBe('quick');
  });
});
