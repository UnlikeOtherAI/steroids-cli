/**
 * Integration tests for environment variable support
 *
 * Verifies that all documented environment variables work correctly
 * and integrate properly with the CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { parseGlobalFlags } from '../src/cli/flags.js';
import {
  isEnvTrue,
  shouldDisableColors,
  isAutoMigrateEnabled,
  isCI,
  getEnv,
} from '../src/cli/env.js';

describe('Environment Variable Integration', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Create a clean environment for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('STEROIDS_CONFIG', () => {
    it('should map to --config flag via env var', () => {
      process.env.STEROIDS_CONFIG = '/custom/config.yaml';
      const { flags } = parseGlobalFlags([]);
      expect(flags.configPath).toBe('/custom/config.yaml');
    });

    it('should be overridden by CLI flag', () => {
      process.env.STEROIDS_CONFIG = '/env/config.yaml';
      const { flags } = parseGlobalFlags(['--config', '/cli/config.yaml']);
      expect(flags.configPath).toBe('/cli/config.yaml');
    });
  });

  describe('STEROIDS_JSON', () => {
    it('should enable JSON output with value "1"', () => {
      process.env.STEROIDS_JSON = '1';
      const { flags } = parseGlobalFlags([]);
      expect(flags.json).toBe(true);
    });

    it('should enable JSON output with value "true"', () => {
      process.env.STEROIDS_JSON = 'true';
      const { flags } = parseGlobalFlags([]);
      expect(flags.json).toBe(true);
    });

    it('should not enable with other values', () => {
      process.env.STEROIDS_JSON = 'yes';
      const { flags } = parseGlobalFlags([]);
      expect(flags.json).toBe(false);
    });
  });

  describe('STEROIDS_QUIET', () => {
    it('should enable quiet mode', () => {
      process.env.STEROIDS_QUIET = '1';
      const { flags } = parseGlobalFlags([]);
      expect(flags.quiet).toBe(true);
    });

    it('should conflict with verbose flag', () => {
      process.env.STEROIDS_QUIET = '1';
      expect(() => parseGlobalFlags(['--verbose'])).toThrow(
        'Cannot use --quiet and --verbose together'
      );
    });
  });

  describe('STEROIDS_VERBOSE', () => {
    it('should enable verbose mode', () => {
      process.env.STEROIDS_VERBOSE = '1';
      const { flags } = parseGlobalFlags([]);
      expect(flags.verbose).toBe(true);
    });
  });

  describe('STEROIDS_NO_HOOKS', () => {
    it('should disable hooks', () => {
      process.env.STEROIDS_NO_HOOKS = '1';
      const { flags } = parseGlobalFlags([]);
      expect(flags.noHooks).toBe(true);
    });

    it('should work with true value', () => {
      process.env.STEROIDS_NO_HOOKS = 'true';
      const { flags } = parseGlobalFlags([]);
      expect(flags.noHooks).toBe(true);
    });
  });

  describe('STEROIDS_NO_COLOR', () => {
    it('should disable colors', () => {
      process.env.STEROIDS_NO_COLOR = '1';
      const { flags } = parseGlobalFlags([]);
      expect(flags.noColor).toBe(true);
    });

    it('should be detected by shouldDisableColors()', () => {
      process.env.STEROIDS_NO_COLOR = '1';
      expect(shouldDisableColors()).toBe(true);
    });
  });

  describe('STEROIDS_AUTO_MIGRATE', () => {
    it('should enable auto-migration', () => {
      process.env.STEROIDS_AUTO_MIGRATE = '1';
      expect(isAutoMigrateEnabled()).toBe(true);
    });

    it('should work with true value', () => {
      process.env.STEROIDS_AUTO_MIGRATE = 'true';
      expect(isAutoMigrateEnabled()).toBe(true);
    });

    it('should be disabled by default', () => {
      delete process.env.STEROIDS_AUTO_MIGRATE;
      expect(isAutoMigrateEnabled()).toBe(false);
    });
  });

  describe('STEROIDS_TIMEOUT', () => {
    it('should parse seconds', () => {
      process.env.STEROIDS_TIMEOUT = '30s';
      const { flags } = parseGlobalFlags([]);
      expect(flags.timeout).toBe(30000);
    });

    it('should parse minutes', () => {
      process.env.STEROIDS_TIMEOUT = '5m';
      const { flags } = parseGlobalFlags([]);
      expect(flags.timeout).toBe(300000);
    });

    it('should parse hours', () => {
      process.env.STEROIDS_TIMEOUT = '1h';
      const { flags } = parseGlobalFlags([]);
      expect(flags.timeout).toBe(3600000);
    });

    it('should parse milliseconds', () => {
      process.env.STEROIDS_TIMEOUT = '1500';
      const { flags } = parseGlobalFlags([]);
      expect(flags.timeout).toBe(1500);
    });

    it('should ignore invalid format', () => {
      process.env.STEROIDS_TIMEOUT = 'invalid';
      const { flags } = parseGlobalFlags([]);
      expect(flags.timeout).toBeUndefined();
    });
  });

  describe('NO_COLOR (standard)', () => {
    it('should disable colors when set', () => {
      process.env.NO_COLOR = '1';
      const { flags } = parseGlobalFlags([]);
      expect(flags.noColor).toBe(true);
    });

    it('should work with any value', () => {
      process.env.NO_COLOR = 'anything';
      expect(shouldDisableColors()).toBe(true);
    });
  });

  describe('CI', () => {
    it('should detect CI environment', () => {
      process.env.CI = '1';
      expect(isCI()).toBe(true);
    });

    it('should detect GITHUB_ACTIONS', () => {
      delete process.env.CI;
      process.env.GITHUB_ACTIONS = 'true';
      expect(isCI()).toBe(true);
    });

    it('should detect GITLAB_CI', () => {
      delete process.env.CI;
      delete process.env.GITHUB_ACTIONS;
      process.env.GITLAB_CI = 'true';
      expect(isCI()).toBe(true);
    });

    it('should detect CIRCLECI', () => {
      delete process.env.CI;
      process.env.CIRCLECI = 'true';
      expect(isCI()).toBe(true);
    });

    it('should detect TRAVIS', () => {
      delete process.env.CI;
      process.env.TRAVIS = 'true';
      expect(isCI()).toBe(true);
    });

    it('should detect JENKINS_URL', () => {
      delete process.env.CI;
      process.env.JENKINS_URL = 'http://jenkins.example.com';
      expect(isCI()).toBe(true);
    });
  });

  describe('Environment Variable Priority', () => {
    it('CLI flags should override env vars', () => {
      process.env.STEROIDS_JSON = '1';
      process.env.STEROIDS_NO_HOOKS = '1';

      // CLI flags can add to env vars
      const { flags } = parseGlobalFlags(['--verbose']);
      expect(flags.verbose).toBe(true); // From CLI
      expect(flags.json).toBe(true); // From env
      expect(flags.noHooks).toBe(true); // From env
    });

    it('should combine env vars and CLI flags', () => {
      process.env.STEROIDS_JSON = '1';
      process.env.STEROIDS_NO_COLOR = '1';

      const { flags } = parseGlobalFlags(['--verbose']);
      expect(flags.json).toBe(true);
      expect(flags.noColor).toBe(true);
      expect(flags.verbose).toBe(true);
    });
  });

  describe('All Environment Variables', () => {
    it('should support all documented env vars simultaneously', () => {
      process.env.STEROIDS_CONFIG = '/config.yaml';
      process.env.STEROIDS_JSON = '1';
      process.env.STEROIDS_QUIET = '1';
      process.env.STEROIDS_NO_HOOKS = '1';
      process.env.STEROIDS_NO_COLOR = '1';
      process.env.STEROIDS_TIMEOUT = '60s';

      const { flags } = parseGlobalFlags([]);

      expect(flags.configPath).toBe('/config.yaml');
      expect(flags.json).toBe(true);
      expect(flags.quiet).toBe(true);
      expect(flags.noHooks).toBe(true);
      expect(flags.noColor).toBe(true);
      expect(flags.timeout).toBe(60000);
    });
  });

  describe('getEnv helper', () => {
    it('should retrieve environment variables', () => {
      process.env.STEROIDS_CONFIG = '/test/path';
      expect(getEnv('STEROIDS_CONFIG')).toBe('/test/path');
    });

    it('should return undefined for unset variables', () => {
      delete process.env.STEROIDS_CONFIG;
      expect(getEnv('STEROIDS_CONFIG')).toBeUndefined();
    });
  });

  describe('isEnvTrue helper', () => {
    it('should detect "1" as true', () => {
      process.env.STEROIDS_JSON = '1';
      expect(isEnvTrue('STEROIDS_JSON')).toBe(true);
    });

    it('should detect "true" as true', () => {
      process.env.STEROIDS_JSON = 'true';
      expect(isEnvTrue('STEROIDS_JSON')).toBe(true);
    });

    it('should detect "yes" as true', () => {
      process.env.STEROIDS_JSON = 'yes';
      expect(isEnvTrue('STEROIDS_JSON')).toBe(true);
    });

    it('should be case-insensitive', () => {
      process.env.STEROIDS_JSON = 'TRUE';
      expect(isEnvTrue('STEROIDS_JSON')).toBe(true);
    });

    it('should return false for other values', () => {
      process.env.STEROIDS_JSON = 'maybe';
      expect(isEnvTrue('STEROIDS_JSON')).toBe(false);
    });
  });
});
