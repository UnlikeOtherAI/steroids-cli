/**
 * Tests for interactive mode detection
 */

import { jest, describe, it, expect, beforeEach, afterEach, afterAll } from '@jest/globals';
import {
  isInteractive,
  requireInteractive,
  warnNonInteractive,
  getEnvironmentInfo,
} from '../src/cli/interactive.js';
import { CliError, ErrorCode } from '../src/cli/errors.js';

describe('isInteractive', () => {
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear CI env vars
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.TRAVIS;
    delete process.env.JENKINS_URL;
  });

  afterEach(() => {
    // Restore TTY state (keep configurable so other tests can redefine safely)
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, writable: true, configurable: true });
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
  });

  it('should return true when stdin and stdout are TTY and not in CI', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    expect(isInteractive()).toBe(true);
  });

  it('should return false when CI env var is set', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    process.env.CI = '1';

    expect(isInteractive()).toBe(false);
  });

  it('should return false when stdin is not TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    expect(isInteractive()).toBe(false);
  });

  it('should return false when stdout is not TTY', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });

    expect(isInteractive()).toBe(false);
  });

  it('should return false when stdin is undefined', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: undefined, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    expect(isInteractive()).toBe(false);
  });
});

describe('CI detection via getEnvironmentInfo', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.TRAVIS;
    delete process.env.JENKINS_URL;
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
  });

  it('should return false when no CI env vars are set', () => {
    const info = getEnvironmentInfo();
    expect(info.ci).toBe(false);
  });

  it('should detect CI env var', () => {
    process.env.CI = '1';
    const info = getEnvironmentInfo();
    expect(info.ci).toBe(true);
  });

  it('should detect CONTINUOUS_INTEGRATION env var', () => {
    process.env.CONTINUOUS_INTEGRATION = 'true';
    const info = getEnvironmentInfo();
    expect(info.ci).toBe(true);
  });

  it('should detect GITHUB_ACTIONS env var', () => {
    process.env.GITHUB_ACTIONS = 'true';
    const info = getEnvironmentInfo();
    expect(info.ci).toBe(true);
  });

  it('should detect GITLAB_CI env var', () => {
    process.env.GITLAB_CI = 'true';
    const info = getEnvironmentInfo();
    expect(info.ci).toBe(true);
  });

  it('should detect CIRCLECI env var', () => {
    process.env.CIRCLECI = 'true';
    const info = getEnvironmentInfo();
    expect(info.ci).toBe(true);
  });

  it('should detect TRAVIS env var', () => {
    process.env.TRAVIS = 'true';
    const info = getEnvironmentInfo();
    expect(info.ci).toBe(true);
  });

  it('should detect JENKINS_URL env var', () => {
    process.env.JENKINS_URL = 'http://jenkins.local';
    const info = getEnvironmentInfo();
    expect(info.ci).toBe(true);
  });
});

describe('requireInteractive', () => {
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.TRAVIS;
    delete process.env.JENKINS_URL;
  });

  afterEach(() => {
    // Restore TTY state (keep configurable so other tests can redefine safely)
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, writable: true, configurable: true });
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
  });

  it('should not throw when in interactive mode', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    expect(() => requireInteractive('Test message')).not.toThrow();
  });

  it('should throw CliError when not in interactive mode', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    expect(() => requireInteractive('Test message')).toThrow(CliError);
    expect(() => requireInteractive('Test message')).toThrow(
      'Test message\nThis operation requires interactive mode or explicit flags.'
    );
  });

  it('should throw CliError with INVALID_ARGUMENTS code', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    try {
      requireInteractive('Test message');
      fail('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe(ErrorCode.INVALID_ARGUMENTS);
    }
  });

  it('should throw when in CI environment', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    process.env.CI = '1';

    expect(() => requireInteractive('Test message')).toThrow(CliError);
  });
});

describe('warnNonInteractive', () => {
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  const originalEnv = { ...process.env };
  let consoleWarnSpy: any;

  beforeEach(() => {
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.TRAVIS;
    delete process.env.JENKINS_URL;
    delete process.env.STEROIDS_QUIET;
    consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    if (consoleWarnSpy && consoleWarnSpy.mockRestore) {
      consoleWarnSpy.mockRestore();
    }
    // Restore TTY state (keep configurable so other tests can redefine safely)
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, writable: true, configurable: true });
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
  });

  it('should not warn in interactive mode', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    warnNonInteractive('Test warning');
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('should warn in non-interactive mode', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    warnNonInteractive('Test warning');
    expect(consoleWarnSpy).toHaveBeenCalledWith('Warning: Test warning');
  });

  it('should not warn in quiet mode', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    process.env.STEROIDS_QUIET = '1';

    warnNonInteractive('Test warning');
    expect(consoleWarnSpy).not.toHaveBeenCalled();
  });

  it('should include CI hint when in CI', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });
    process.env.CI = '1';

    warnNonInteractive('Test warning');
    expect(consoleWarnSpy).toHaveBeenCalledWith('Warning: Test warning');
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      'Detected CI environment. Use explicit flags to avoid interactive prompts.'
    );
  });
});

describe('getEnvironmentInfo', () => {
  const originalStdinTTY = process.stdin.isTTY;
  const originalStdoutTTY = process.stdout.isTTY;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.CI;
    delete process.env.CONTINUOUS_INTEGRATION;
    delete process.env.GITHUB_ACTIONS;
    delete process.env.GITLAB_CI;
    delete process.env.CIRCLECI;
    delete process.env.TRAVIS;
    delete process.env.JENKINS_URL;
  });

  afterEach(() => {
    // Restore TTY state (keep configurable so other tests can redefine safely)
    Object.defineProperty(process.stdin, 'isTTY', { value: originalStdinTTY, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: originalStdoutTTY, writable: true, configurable: true });
  });

  afterAll(() => {
    Object.assign(process.env, originalEnv);
  });

  it('should return correct info for interactive mode', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, writable: true, configurable: true });

    const info = getEnvironmentInfo();
    expect(info.interactive).toBe(true);
    expect(info.ci).toBe(false);
    expect(info.stdinTTY).toBe(true);
    expect(info.stdoutTTY).toBe(true);
    expect(info.ciSystem).toBeUndefined();
  });

  it('should detect GitHub Actions', () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: false, writable: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: false, writable: true, configurable: true });
    process.env.GITHUB_ACTIONS = 'true';

    const info = getEnvironmentInfo();
    expect(info.interactive).toBe(false);
    expect(info.ci).toBe(true);
    expect(info.ciSystem).toBe('GitHub Actions');
  });

  it('should detect GitLab CI', () => {
    process.env.GITLAB_CI = 'true';
    const info = getEnvironmentInfo();
    expect(info.ciSystem).toBe('GitLab CI');
  });

  it('should detect CircleCI', () => {
    process.env.CIRCLECI = 'true';
    const info = getEnvironmentInfo();
    expect(info.ciSystem).toBe('CircleCI');
  });

  it('should detect Travis CI', () => {
    process.env.TRAVIS = 'true';
    const info = getEnvironmentInfo();
    expect(info.ciSystem).toBe('Travis CI');
  });

  it('should detect Jenkins', () => {
    process.env.JENKINS_URL = 'http://jenkins.local';
    const info = getEnvironmentInfo();
    expect(info.ciSystem).toBe('Jenkins');
  });

  it('should detect generic CI', () => {
    process.env.CI = '1';
    const info = getEnvironmentInfo();
    expect(info.ciSystem).toBe('Generic CI');
  });
});

