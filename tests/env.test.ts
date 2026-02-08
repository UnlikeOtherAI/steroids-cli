/**
 * Tests for environment variable support
 */

import {
  isTruthy,
  isFalsy,
  getEnv,
  isEnvTrue,
  isEnvFalse,
  getEnvString,
  isCI,
  getCISystem,
  shouldDisableColors,
  isAutoMigrateEnabled,
  getEnvSnapshot,
  ENV_VARS,
} from '../src/cli/env.js';

describe('Environment Variable Support', () => {
  // Save and restore env vars
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all Steroids env vars before each test
    for (const key of Object.keys(ENV_VARS)) {
      delete process.env[ENV_VARS[key as keyof typeof ENV_VARS]];
    }
  });

  afterAll(() => {
    // Restore env vars
    Object.assign(process.env, originalEnv);
  });

  describe('isTruthy', () => {
    it('should return true for "1"', () => {
      expect(isTruthy('1')).toBe(true);
    });

    it('should return true for "true" (case-insensitive)', () => {
      expect(isTruthy('true')).toBe(true);
      expect(isTruthy('TRUE')).toBe(true);
      expect(isTruthy('True')).toBe(true);
    });

    it('should return true for "yes"', () => {
      expect(isTruthy('yes')).toBe(true);
      expect(isTruthy('YES')).toBe(true);
    });

    it('should return true for "on"', () => {
      expect(isTruthy('on')).toBe(true);
      expect(isTruthy('ON')).toBe(true);
    });

    it('should return false for "0"', () => {
      expect(isTruthy('0')).toBe(false);
    });

    it('should return false for "false"', () => {
      expect(isTruthy('false')).toBe(false);
      expect(isTruthy('FALSE')).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isTruthy(undefined)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isTruthy('')).toBe(false);
    });

    it('should return false for random text', () => {
      expect(isTruthy('random')).toBe(false);
    });
  });

  describe('isFalsy', () => {
    it('should return true for "0"', () => {
      expect(isFalsy('0')).toBe(true);
    });

    it('should return true for "false" (case-insensitive)', () => {
      expect(isFalsy('false')).toBe(true);
      expect(isFalsy('FALSE')).toBe(true);
      expect(isFalsy('False')).toBe(true);
    });

    it('should return true for "no"', () => {
      expect(isFalsy('no')).toBe(true);
      expect(isFalsy('NO')).toBe(true);
    });

    it('should return true for "off"', () => {
      expect(isFalsy('off')).toBe(true);
      expect(isFalsy('OFF')).toBe(true);
    });

    it('should return false for "1"', () => {
      expect(isFalsy('1')).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isFalsy(undefined)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(isFalsy('')).toBe(false);
    });
  });

  describe('getEnv', () => {
    it('should get STEROIDS_CONFIG', () => {
      process.env.STEROIDS_CONFIG = '/test/config.yaml';
      expect(getEnv('STEROIDS_CONFIG')).toBe('/test/config.yaml');
    });

    it('should get STEROIDS_JSON', () => {
      process.env.STEROIDS_JSON = '1';
      expect(getEnv('STEROIDS_JSON')).toBe('1');
    });

    it('should return undefined for unset variable', () => {
      expect(getEnv('STEROIDS_JSON')).toBeUndefined();
    });
  });

  describe('isEnvTrue', () => {
    it('should return true when STEROIDS_JSON=1', () => {
      process.env.STEROIDS_JSON = '1';
      expect(isEnvTrue('STEROIDS_JSON')).toBe(true);
    });

    it('should return true when STEROIDS_VERBOSE=true', () => {
      process.env.STEROIDS_VERBOSE = 'true';
      expect(isEnvTrue('STEROIDS_VERBOSE')).toBe(true);
    });

    it('should return false when variable not set', () => {
      expect(isEnvTrue('STEROIDS_JSON')).toBe(false);
    });

    it('should return false when STEROIDS_QUIET=0', () => {
      process.env.STEROIDS_QUIET = '0';
      expect(isEnvTrue('STEROIDS_QUIET')).toBe(false);
    });
  });

  describe('isEnvFalse', () => {
    it('should return true when STEROIDS_JSON=0', () => {
      process.env.STEROIDS_JSON = '0';
      expect(isEnvFalse('STEROIDS_JSON')).toBe(true);
    });

    it('should return true when STEROIDS_VERBOSE=false', () => {
      process.env.STEROIDS_VERBOSE = 'false';
      expect(isEnvFalse('STEROIDS_VERBOSE')).toBe(true);
    });

    it('should return false when variable not set', () => {
      expect(isEnvFalse('STEROIDS_JSON')).toBe(false);
    });
  });

  describe('getEnvString', () => {
    it('should return env value when set', () => {
      process.env.STEROIDS_CONFIG = '/custom/config.yaml';
      expect(getEnvString('STEROIDS_CONFIG', '/default')).toBe('/custom/config.yaml');
    });

    it('should return default when not set', () => {
      expect(getEnvString('STEROIDS_CONFIG', '/default')).toBe('/default');
    });
  });

  describe('isCI', () => {
    it('should return false when no CI env vars set', () => {
      expect(isCI()).toBe(false);
    });

    it('should return true when CI=1', () => {
      process.env.CI = '1';
      expect(isCI()).toBe(true);
    });

    it('should return true when GITHUB_ACTIONS=true', () => {
      process.env.GITHUB_ACTIONS = 'true';
      expect(isCI()).toBe(true);
    });

    it('should return true when GITLAB_CI=true', () => {
      process.env.GITLAB_CI = 'true';
      expect(isCI()).toBe(true);
    });

    it('should return true when CIRCLECI=true', () => {
      process.env.CIRCLECI = 'true';
      expect(isCI()).toBe(true);
    });

    it('should return true when TRAVIS=true', () => {
      process.env.TRAVIS = 'true';
      expect(isCI()).toBe(true);
    });

    it('should return true when JENKINS_URL is set', () => {
      process.env.JENKINS_URL = 'http://jenkins.example.com';
      expect(isCI()).toBe(true);
    });
  });

  describe('getCISystem', () => {
    it('should return null when no CI', () => {
      expect(getCISystem()).toBeNull();
    });

    it('should return "GitHub Actions" for GITHUB_ACTIONS', () => {
      process.env.GITHUB_ACTIONS = 'true';
      expect(getCISystem()).toBe('GitHub Actions');
    });

    it('should return "GitLab CI" for GITLAB_CI', () => {
      process.env.GITLAB_CI = 'true';
      expect(getCISystem()).toBe('GitLab CI');
    });

    it('should return "CircleCI" for CIRCLECI', () => {
      process.env.CIRCLECI = 'true';
      expect(getCISystem()).toBe('CircleCI');
    });

    it('should return "Travis CI" for TRAVIS', () => {
      process.env.TRAVIS = 'true';
      expect(getCISystem()).toBe('Travis CI');
    });

    it('should return "Jenkins" for JENKINS_URL', () => {
      process.env.JENKINS_URL = 'http://jenkins.example.com';
      expect(getCISystem()).toBe('Jenkins');
    });

    it('should return "Generic CI" for CI variable', () => {
      process.env.CI = 'true';
      expect(getCISystem()).toBe('Generic CI');
    });

    it('should prioritize specific systems over generic CI', () => {
      process.env.CI = 'true';
      process.env.GITHUB_ACTIONS = 'true';
      expect(getCISystem()).toBe('GitHub Actions');
    });
  });

  describe('shouldDisableColors', () => {
    it('should return false when no env vars set', () => {
      expect(shouldDisableColors()).toBe(false);
    });

    it('should return true when NO_COLOR is set (any value)', () => {
      process.env.NO_COLOR = '1';
      expect(shouldDisableColors()).toBe(true);
    });

    it('should return true when NO_COLOR is empty string', () => {
      process.env.NO_COLOR = '';
      expect(shouldDisableColors()).toBe(true);
    });

    it('should return true when STEROIDS_NO_COLOR=1', () => {
      process.env.STEROIDS_NO_COLOR = '1';
      expect(shouldDisableColors()).toBe(true);
    });

    it('should return true when STEROIDS_NO_COLOR=true', () => {
      process.env.STEROIDS_NO_COLOR = 'true';
      expect(shouldDisableColors()).toBe(true);
    });

    it('should return false when STEROIDS_NO_COLOR=0', () => {
      process.env.STEROIDS_NO_COLOR = '0';
      expect(shouldDisableColors()).toBe(false);
    });
  });

  describe('isAutoMigrateEnabled', () => {
    it('should return false when not set', () => {
      expect(isAutoMigrateEnabled()).toBe(false);
    });

    it('should return true when STEROIDS_AUTO_MIGRATE=1', () => {
      process.env.STEROIDS_AUTO_MIGRATE = '1';
      expect(isAutoMigrateEnabled()).toBe(true);
    });

    it('should return true when STEROIDS_AUTO_MIGRATE=true', () => {
      process.env.STEROIDS_AUTO_MIGRATE = 'true';
      expect(isAutoMigrateEnabled()).toBe(true);
    });

    it('should return false when STEROIDS_AUTO_MIGRATE=0', () => {
      process.env.STEROIDS_AUTO_MIGRATE = '0';
      expect(isAutoMigrateEnabled()).toBe(false);
    });
  });

  describe('getEnvSnapshot', () => {
    it('should return empty object when no env vars set', () => {
      expect(getEnvSnapshot()).toEqual({});
    });

    it('should return snapshot of set Steroids env vars', () => {
      process.env.STEROIDS_JSON = '1';
      process.env.STEROIDS_CONFIG = '/test/config.yaml';
      process.env.STEROIDS_VERBOSE = 'true';

      const snapshot = getEnvSnapshot();

      expect(snapshot).toHaveProperty('STEROIDS_JSON', '1');
      expect(snapshot).toHaveProperty('STEROIDS_CONFIG', '/test/config.yaml');
      expect(snapshot).toHaveProperty('STEROIDS_VERBOSE', 'true');
      expect(snapshot).not.toHaveProperty('STEROIDS_QUIET');
    });

    it('should include CI env vars when set', () => {
      process.env.CI = '1';
      process.env.GITHUB_ACTIONS = 'true';

      const snapshot = getEnvSnapshot();

      expect(snapshot).toHaveProperty('CI', '1');
      expect(snapshot).toHaveProperty('GITHUB_ACTIONS', 'true');
    });

    it('should include NO_COLOR when set', () => {
      process.env.NO_COLOR = '1';

      const snapshot = getEnvSnapshot();

      expect(snapshot).toHaveProperty('NO_COLOR', '1');
    });
  });

  describe('ENV_VARS constant', () => {
    it('should have all expected environment variables', () => {
      expect(ENV_VARS).toHaveProperty('STEROIDS_CONFIG');
      expect(ENV_VARS).toHaveProperty('STEROIDS_JSON');
      expect(ENV_VARS).toHaveProperty('STEROIDS_QUIET');
      expect(ENV_VARS).toHaveProperty('STEROIDS_VERBOSE');
      expect(ENV_VARS).toHaveProperty('STEROIDS_NO_HOOKS');
      expect(ENV_VARS).toHaveProperty('STEROIDS_NO_COLOR');
      expect(ENV_VARS).toHaveProperty('STEROIDS_AUTO_MIGRATE');
      expect(ENV_VARS).toHaveProperty('STEROIDS_TIMEOUT');
      expect(ENV_VARS).toHaveProperty('NO_COLOR');
      expect(ENV_VARS).toHaveProperty('CI');
    });

    it('should have correct values', () => {
      expect(ENV_VARS.STEROIDS_CONFIG).toBe('STEROIDS_CONFIG');
      expect(ENV_VARS.STEROIDS_JSON).toBe('STEROIDS_JSON');
      expect(ENV_VARS.NO_COLOR).toBe('NO_COLOR');
    });
  });
});
