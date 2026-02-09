/**
 * Invocation Logger Tests
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  InvocationLogger,
  type InvocationLogEntry,
} from '../src/providers/invocation-logger.js';

describe('InvocationLogger', () => {
  let testLogsDir: string;
  let logger: InvocationLogger;

  beforeEach(() => {
    // Create temp logs directory
    testLogsDir = join(tmpdir(), `steroids-test-logs-${Date.now()}`);
    mkdirSync(testLogsDir, { recursive: true });

    logger = new InvocationLogger({
      enabled: true,
      logsDir: testLogsDir,
      retentionDays: 7,
      includePrompts: true,
      includeResponses: true,
    });
  });

  afterEach(() => {
    // Clean up test logs
    if (existsSync(testLogsDir)) {
      rmSync(testLogsDir, { recursive: true, force: true });
    }
  });

  describe('log', () => {
    it('should create log file', () => {
      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'coder',
        provider: 'claude',
        model: 'sonnet',
        taskId: 'test-task-123',
        duration: 5000,
        exitCode: 0,
        success: true,
        timedOut: false,
        prompt: 'Test prompt',
        response: 'Test response',
      };

      logger.log(entry);

      const logs = logger.getAllLogs();
      expect(logs.length).toBe(1);
    });

    it('should not create log file when disabled', () => {
      const disabledLogger = new InvocationLogger({
        enabled: false,
        logsDir: testLogsDir,
      });

      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'coder',
        provider: 'claude',
        model: 'sonnet',
        duration: 5000,
        exitCode: 0,
        success: true,
        timedOut: false,
        prompt: 'Test prompt',
        response: 'Test response',
      };

      disabledLogger.log(entry);

      const logs = disabledLogger.getAllLogs();
      expect(logs.length).toBe(0);
    });

    it('should include prompt in log content', () => {
      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'coder',
        provider: 'claude',
        model: 'sonnet',
        duration: 5000,
        exitCode: 0,
        success: true,
        timedOut: false,
        prompt: 'Test prompt content',
        response: 'Test response',
      };

      logger.log(entry);

      const logs = logger.getAllLogs();
      const content = readFileSync(logs[0], 'utf-8');

      expect(content).toContain('Test prompt content');
      expect(content).toContain('PROMPT');
    });

    it('should include response in log content', () => {
      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'coder',
        provider: 'claude',
        model: 'sonnet',
        duration: 5000,
        exitCode: 0,
        success: true,
        timedOut: false,
        prompt: 'Test prompt',
        response: 'Test response content',
      };

      logger.log(entry);

      const logs = logger.getAllLogs();
      const content = readFileSync(logs[0], 'utf-8');

      expect(content).toContain('Test response content');
      expect(content).toContain('RESPONSE');
    });

    it('should include error in log content', () => {
      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'coder',
        provider: 'claude',
        model: 'sonnet',
        duration: 5000,
        exitCode: 1,
        success: false,
        timedOut: false,
        prompt: 'Test prompt',
        response: '',
        error: 'Test error message',
      };

      logger.log(entry);

      const logs = logger.getAllLogs();
      const content = readFileSync(logs[0], 'utf-8');

      expect(content).toContain('Test error message');
      expect(content).toContain('ERROR');
    });

    it('should include metadata in log content', () => {
      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'reviewer',
        provider: 'codex',
        model: 'codex',
        taskId: 'task-abc-123',
        duration: 12345,
        exitCode: 0,
        success: true,
        timedOut: false,
        prompt: 'Test prompt',
        response: 'Test response',
      };

      logger.log(entry);

      const logs = logger.getAllLogs();
      const content = readFileSync(logs[0], 'utf-8');

      expect(content).toContain('Role:         reviewer');
      expect(content).toContain('Provider:     codex');
      expect(content).toContain('Model:        codex');
      expect(content).toContain('Task ID:      task-abc-123');
      expect(content).toContain('Duration:     12345ms');
      expect(content).toContain('Exit Code:    0');
    });
  });

  describe('getAllLogs', () => {
    it('should return empty array for empty logs directory', () => {
      const logs = logger.getAllLogs();
      expect(logs).toEqual([]);
    });

    it('should return all log files', () => {
      // Create multiple log entries with unique timestamps
      const baseTime = Date.now();
      for (let i = 0; i < 3; i++) {
        const entry: InvocationLogEntry = {
          timestamp: new Date(baseTime + i * 2000).toISOString(),
          role: 'coder',
          provider: 'claude',
          model: 'sonnet',
          taskId: `task-${i}`,
          duration: 5000,
          exitCode: 0,
          success: true,
          timedOut: false,
          prompt: `Test prompt ${i}`,
          response: `Test response ${i}`,
        };
        logger.log(entry);
      }

      const logs = logger.getAllLogs();
      expect(logs.length).toBe(3);
    });

    it('should return sorted log files', () => {
      const timestamps = [
        new Date('2024-01-01T10:00:00.000Z'),
        new Date('2024-01-01T11:00:00.000Z'),
        new Date('2024-01-01T09:00:00.000Z'),
      ];

      for (let i = 0; i < timestamps.length; i++) {
        const entry: InvocationLogEntry = {
          timestamp: timestamps[i].toISOString(),
          role: 'coder',
          provider: 'claude',
          model: 'sonnet',
          taskId: `task-${i}`,
          duration: 5000,
          exitCode: 0,
          success: i === 0,  // Make them different so filenames differ
          timedOut: false,
          prompt: `Test prompt ${i}`,
          response: `Test response ${i}`,
        };
        logger.log(entry);
      }

      const logs = logger.getAllLogs();

      // Debug output if test fails
      if (logs.length !== 3) {
        console.log('Test logs dir:', testLogsDir);
        console.log('Found logs:', logs);
        if (existsSync(testLogsDir)) {
          console.log('Dir contents:', readdirSync(testLogsDir, { withFileTypes: true }));
        }
      }

      expect(logs.length).toBe(3);

      // Should be sorted
      for (let i = 1; i < logs.length; i++) {
        expect(logs[i] >= logs[i - 1]).toBe(true);
      }
    });
  });

  describe('purgeAll', () => {
    it('should delete all logs', () => {
      // Create some log entries with unique timestamps
      const baseTime = Date.now();
      for (let i = 0; i < 3; i++) {
        const entry: InvocationLogEntry = {
          timestamp: new Date(baseTime + i * 2000).toISOString(),
          role: 'coder',
          provider: 'claude',
          model: 'sonnet',
          taskId: `task-${i}`,
          duration: 5000,
          exitCode: 0,
          success: true,
          timedOut: false,
          prompt: `Test prompt ${i}`,
          response: `Test response ${i}`,
        };
        logger.log(entry);
      }

      expect(logger.getAllLogs().length).toBe(3);

      logger.purgeAll();

      expect(logger.getAllLogs().length).toBe(0);
    });
  });

  describe('getTotalSize', () => {
    it('should return 0 for empty logs', () => {
      const size = logger.getTotalSize();
      expect(size).toBe(0);
    });

    it('should return total size of all logs', () => {
      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'coder',
        provider: 'claude',
        model: 'sonnet',
        duration: 5000,
        exitCode: 0,
        success: true,
        timedOut: false,
        prompt: 'Test prompt',
        response: 'Test response',
      };

      logger.log(entry);

      const size = logger.getTotalSize();
      expect(size).toBeGreaterThan(0);
    });
  });

  describe('cleanup old logs', () => {
    it('should keep logs within retention period', () => {
      const loggerWithRetention = new InvocationLogger({
        enabled: true,
        logsDir: testLogsDir,
        retentionDays: 7,
      });

      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'coder',
        provider: 'claude',
        model: 'sonnet',
        duration: 5000,
        exitCode: 0,
        success: true,
        timedOut: false,
        prompt: 'Test prompt',
        response: 'Test response',
      };

      loggerWithRetention.log(entry);

      const logs = loggerWithRetention.getAllLogs();
      expect(logs.length).toBe(1);
    });

    it('should not cleanup when retention is 0 (keep forever)', () => {
      const loggerNoRetention = new InvocationLogger({
        enabled: true,
        logsDir: testLogsDir,
        retentionDays: 0,
      });

      const entry: InvocationLogEntry = {
        timestamp: new Date().toISOString(),
        role: 'coder',
        provider: 'claude',
        model: 'sonnet',
        duration: 5000,
        exitCode: 0,
        success: true,
        timedOut: false,
        prompt: 'Test prompt',
        response: 'Test response',
      };

      loggerNoRetention.log(entry);

      const logs = loggerNoRetention.getAllLogs();
      expect(logs.length).toBe(1);
    });
  });
});
