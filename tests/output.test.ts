/**
 * Tests for the JSON output envelope
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import {
  successEnvelope,
  errorEnvelope,
  createOutput,
  Output,
  type JsonEnvelope,
} from '../src/cli/output.js';
import { getDefaultFlags, type GlobalFlags } from '../src/cli/flags.js';

describe('successEnvelope', () => {
  it('should create a success envelope with data', () => {
    const data = { tasks: [{ id: '1', title: 'Test' }], total: 1 };
    const envelope = successEnvelope('tasks', 'list', data);

    expect(envelope).toEqual({
      success: true,
      command: 'tasks',
      subcommand: 'list',
      data,
      error: null,
    });
  });

  it('should handle null subcommand', () => {
    const envelope = successEnvelope('init', null, { initialized: true });

    expect(envelope.command).toBe('init');
    expect(envelope.subcommand).toBeNull();
    expect(envelope.success).toBe(true);
  });

  it('should handle empty data object', () => {
    const envelope = successEnvelope('config', 'show', {});

    expect(envelope.data).toEqual({});
    expect(envelope.success).toBe(true);
  });
});

describe('errorEnvelope', () => {
  it('should create an error envelope', () => {
    const envelope = errorEnvelope(
      'tasks',
      'update',
      'TASK_NOT_FOUND',
      'Task not found: abc123',
      { taskId: 'abc123' }
    );

    expect(envelope).toEqual({
      success: false,
      command: 'tasks',
      subcommand: 'update',
      data: null,
      error: {
        code: 'TASK_NOT_FOUND',
        message: 'Task not found: abc123',
        details: { taskId: 'abc123' },
      },
    });
  });

  it('should handle missing details', () => {
    const envelope = errorEnvelope(
      'init',
      null,
      'ALREADY_INITIALIZED',
      'Steroids is already initialized'
    );

    expect(envelope.error?.details).toBeUndefined();
    expect(envelope.success).toBe(false);
  });
});

describe('Output class', () => {
  // Mock console methods
  let consoleLogSpy: ReturnType<typeof jest.spyOn>;
  let consoleErrorSpy: ReturnType<typeof jest.spyOn>;
  let consoleWarnSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleLogSpy.mockRestore();
    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });

  describe('success()', () => {
    it('should output JSON envelope when json flag is set', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), json: true };
      const output = createOutput({ command: 'tasks', subcommand: 'list', flags });

      output.success({ tasks: [], total: 0 });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logged.success).toBe(true);
      expect(logged.command).toBe('tasks');
      expect(logged.subcommand).toBe('list');
    });

    it('should not output when quiet flag is set without json', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), quiet: true };
      const output = createOutput({ command: 'tasks', flags });

      output.success({ tasks: [] });

      // No output in quiet mode without json
      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('error()', () => {
    it('should output JSON envelope when json flag is set', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), json: true };
      const output = createOutput({ command: 'tasks', subcommand: 'update', flags });

      output.error('TASK_NOT_FOUND', 'Task not found', { taskId: 'abc' });

      expect(consoleLogSpy).toHaveBeenCalledTimes(1);
      const logged = JSON.parse(consoleLogSpy.mock.calls[0][0] as string);
      expect(logged.success).toBe(false);
      expect(logged.error.code).toBe('TASK_NOT_FOUND');
    });

    it('should output plain error message when json is not set', () => {
      const flags: GlobalFlags = { ...getDefaultFlags() };
      const output = createOutput({ command: 'tasks', flags });

      output.error('TASK_NOT_FOUND', 'Task not found');

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Task not found');
    });

    it('should include details in verbose mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), verbose: true };
      const output = createOutput({ command: 'tasks', flags });

      output.error('TASK_NOT_FOUND', 'Task not found', { taskId: 'abc' });

      expect(consoleErrorSpy).toHaveBeenCalledWith('Error: Task not found');
      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Details:',
        JSON.stringify({ taskId: 'abc' }, null, 2)
      );
    });

    it('should not output in quiet mode without json', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), quiet: true };
      const output = createOutput({ command: 'tasks', flags });

      output.error('ERROR', 'Something went wrong');

      expect(consoleErrorSpy).not.toHaveBeenCalled();
    });
  });

  describe('log()', () => {
    it('should log message in normal mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags() };
      const output = createOutput({ command: 'tasks', flags });

      output.log('Hello world');

      expect(consoleLogSpy).toHaveBeenCalledWith('Hello world');
    });

    it('should not log in quiet mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), quiet: true };
      const output = createOutput({ command: 'tasks', flags });

      output.log('Hello world');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not log in json mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), json: true };
      const output = createOutput({ command: 'tasks', flags });

      output.log('Hello world');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('verbose()', () => {
    it('should log in verbose mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), verbose: true };
      const output = createOutput({ command: 'tasks', flags });

      output.verbose('Debug info');

      expect(consoleLogSpy).toHaveBeenCalledWith('Debug info');
    });

    it('should not log when not in verbose mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags() };
      const output = createOutput({ command: 'tasks', flags });

      output.verbose('Debug info');

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('warn()', () => {
    it('should output warning message', () => {
      const flags: GlobalFlags = { ...getDefaultFlags() };
      const output = createOutput({ command: 'tasks', flags });

      output.warn('Be careful');

      expect(consoleWarnSpy).toHaveBeenCalledWith('Warning: Be careful');
    });

    it('should not warn in quiet mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), quiet: true };
      const output = createOutput({ command: 'tasks', flags });

      output.warn('Be careful');

      expect(consoleWarnSpy).not.toHaveBeenCalled();
    });
  });

  describe('isJson/isQuiet/isVerbose', () => {
    it('should return flag states', () => {
      const flags: GlobalFlags = {
        ...getDefaultFlags(),
        json: true,
        verbose: true,
      };
      const output = createOutput({ command: 'tasks', flags });

      expect(output.isJson()).toBe(true);
      expect(output.isVerbose()).toBe(true);
      expect(output.isQuiet()).toBe(false);
    });
  });

  describe('table()', () => {
    it('should print formatted table', () => {
      const flags: GlobalFlags = { ...getDefaultFlags() };
      const output = createOutput({ command: 'tasks', flags });

      output.table(['ID', 'NAME'], [
        ['1', 'First'],
        ['2', 'Second'],
      ]);

      expect(consoleLogSpy).toHaveBeenCalledTimes(4); // header, divider, 2 rows
    });

    it('should not print table in json mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), json: true };
      const output = createOutput({ command: 'tasks', flags });

      output.table(['ID', 'NAME'], [['1', 'First']]);

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });

    it('should not print table in quiet mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), quiet: true };
      const output = createOutput({ command: 'tasks', flags });

      output.table(['ID', 'NAME'], [['1', 'First']]);

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });

  describe('divider()', () => {
    it('should print divider line', () => {
      const flags: GlobalFlags = { ...getDefaultFlags() };
      const output = createOutput({ command: 'tasks', flags });

      output.divider(40);

      expect(consoleLogSpy).toHaveBeenCalledWith('\u2500'.repeat(40));
    });

    it('should not print divider in json mode', () => {
      const flags: GlobalFlags = { ...getDefaultFlags(), json: true };
      const output = createOutput({ command: 'tasks', flags });

      output.divider();

      expect(consoleLogSpy).not.toHaveBeenCalled();
    });
  });
});
