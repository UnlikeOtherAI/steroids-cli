/**
 * Script Runner Tests
 */

import { describe, it, expect } from '@jest/globals';
import { parseTimeout, validateScriptConfig, type ScriptHookConfig } from '../src/hooks/script-runner.js';

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
      timeout: 'invalid' as any,
    };

    const result = validateScriptConfig(config);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
