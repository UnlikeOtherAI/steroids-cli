/**
 * Tests for the global flags parser
 */

import {
  parseGlobalFlags,
  parseDuration,
  getDefaultFlags,
  type GlobalFlags,
} from '../src/cli/flags.js';

describe('parseGlobalFlags', () => {
  // Save and restore env vars
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear relevant env vars before each test
    delete process.env.STEROIDS_JSON;
    delete process.env.STEROIDS_QUIET;
    delete process.env.STEROIDS_VERBOSE;
    delete process.env.STEROIDS_NO_HOOKS;
    delete process.env.STEROIDS_NO_COLOR;
    delete process.env.NO_COLOR;
    delete process.env.STEROIDS_CONFIG;
    delete process.env.STEROIDS_TIMEOUT;
  });

  afterAll(() => {
    // Restore env vars
    Object.assign(process.env, originalEnv);
  });

  describe('basic flag parsing', () => {
    it('should return defaults when no args provided', () => {
      const result = parseGlobalFlags([]);
      expect(result.flags).toEqual(getDefaultFlags());
      expect(result.remaining).toEqual([]);
    });

    it('should parse -j short flag', () => {
      const result = parseGlobalFlags(['-j']);
      expect(result.flags.json).toBe(true);
      expect(result.remaining).toEqual([]);
    });

    it('should parse --json long flag', () => {
      const result = parseGlobalFlags(['--json']);
      expect(result.flags.json).toBe(true);
    });

    it('should parse -q short flag', () => {
      const result = parseGlobalFlags(['-q']);
      expect(result.flags.quiet).toBe(true);
    });

    it('should parse --quiet long flag', () => {
      const result = parseGlobalFlags(['--quiet']);
      expect(result.flags.quiet).toBe(true);
    });

    it('should parse -v short flag', () => {
      const result = parseGlobalFlags(['-v']);
      expect(result.flags.verbose).toBe(true);
    });

    it('should parse --verbose long flag', () => {
      const result = parseGlobalFlags(['--verbose']);
      expect(result.flags.verbose).toBe(true);
    });

    it('should parse -h short flag', () => {
      const result = parseGlobalFlags(['-h']);
      expect(result.flags.help).toBe(true);
    });

    it('should parse --help long flag', () => {
      const result = parseGlobalFlags(['--help']);
      expect(result.flags.help).toBe(true);
    });

    it('should parse --version flag', () => {
      const result = parseGlobalFlags(['--version']);
      expect(result.flags.version).toBe(true);
    });

    it('should parse --no-color flag', () => {
      const result = parseGlobalFlags(['--no-color']);
      expect(result.flags.noColor).toBe(true);
    });

    it('should parse --dry-run flag', () => {
      const result = parseGlobalFlags(['--dry-run']);
      expect(result.flags.dryRun).toBe(true);
    });

    it('should parse --no-hooks flag', () => {
      const result = parseGlobalFlags(['--no-hooks']);
      expect(result.flags.noHooks).toBe(true);
    });
  });

  describe('flags with values', () => {
    it('should parse --config with space', () => {
      const result = parseGlobalFlags(['--config', '/path/to/config.yaml']);
      expect(result.flags.configPath).toBe('/path/to/config.yaml');
    });

    it('should parse --config=value syntax', () => {
      const result = parseGlobalFlags(['--config=/path/to/config.yaml']);
      expect(result.flags.configPath).toBe('/path/to/config.yaml');
    });

    it('should parse --timeout with space', () => {
      const result = parseGlobalFlags(['--timeout', '30s']);
      expect(result.flags.timeout).toBe(30000);
    });

    it('should parse --timeout=value syntax', () => {
      const result = parseGlobalFlags(['--timeout=5m']);
      expect(result.flags.timeout).toBe(300000);
    });

    it('should throw error when --config has no value', () => {
      expect(() => parseGlobalFlags(['--config'])).toThrow(
        '--config requires a path argument'
      );
    });

    it('should throw error when --timeout has no value', () => {
      expect(() => parseGlobalFlags(['--timeout'])).toThrow(
        '--timeout requires a duration argument'
      );
    });
  });

  describe('combined short flags', () => {
    it('should parse -jq combined flags', () => {
      const result = parseGlobalFlags(['-jq']);
      expect(result.flags.json).toBe(true);
      expect(result.flags.quiet).toBe(true);
    });

    it('should parse -jvh combined flags', () => {
      const result = parseGlobalFlags(['-jvh']);
      expect(result.flags.json).toBe(true);
      expect(result.flags.verbose).toBe(true);
      expect(result.flags.help).toBe(true);
    });
  });

  describe('remaining args', () => {
    it('should pass through non-global flags', () => {
      const result = parseGlobalFlags(['tasks', 'list', '--status', 'pending']);
      expect(result.remaining).toEqual(['tasks', 'list', '--status', 'pending']);
    });

    it('should extract global flags from mixed args', () => {
      const result = parseGlobalFlags(['-j', 'tasks', 'list', '--no-color']);
      expect(result.flags.json).toBe(true);
      expect(result.flags.noColor).toBe(true);
      expect(result.remaining).toEqual(['tasks', 'list']);
    });

    it('should handle global flags after command', () => {
      const result = parseGlobalFlags(['tasks', 'list', '-j', '-q']);
      expect(result.flags.json).toBe(true);
      expect(result.flags.quiet).toBe(true);
      expect(result.remaining).toEqual(['tasks', 'list']);
    });
  });

  describe('conflicting flags', () => {
    it('should throw error when --quiet and --verbose used together', () => {
      expect(() => parseGlobalFlags(['--quiet', '--verbose'])).toThrow(
        'Cannot use --quiet and --verbose together'
      );
    });
  });

  describe('environment variables', () => {
    it('should read STEROIDS_JSON env var', () => {
      process.env.STEROIDS_JSON = '1';
      const result = parseGlobalFlags([]);
      expect(result.flags.json).toBe(true);
    });

    it('should read STEROIDS_QUIET env var', () => {
      process.env.STEROIDS_QUIET = 'true';
      const result = parseGlobalFlags([]);
      expect(result.flags.quiet).toBe(true);
    });

    it('should read NO_COLOR env var', () => {
      process.env.NO_COLOR = '1';
      const result = parseGlobalFlags([]);
      expect(result.flags.noColor).toBe(true);
    });

    it('should read STEROIDS_CONFIG env var', () => {
      process.env.STEROIDS_CONFIG = '/custom/config.yaml';
      const result = parseGlobalFlags([]);
      expect(result.flags.configPath).toBe('/custom/config.yaml');
    });

    it('should read STEROIDS_TIMEOUT env var', () => {
      process.env.STEROIDS_TIMEOUT = '2m';
      const result = parseGlobalFlags([]);
      expect(result.flags.timeout).toBe(120000);
    });

    it('should override env var with CLI flag', () => {
      process.env.STEROIDS_JSON = '1';
      // The flag wins - but since it's also true, test with a value flag
      process.env.STEROIDS_CONFIG = '/env/config.yaml';
      const result = parseGlobalFlags(['--config', '/cli/config.yaml']);
      expect(result.flags.configPath).toBe('/cli/config.yaml');
    });
  });
});

describe('parseDuration', () => {
  it('should parse milliseconds', () => {
    expect(parseDuration('1000')).toBe(1000);
    expect(parseDuration('500ms')).toBe(500);
  });

  it('should parse seconds', () => {
    expect(parseDuration('30s')).toBe(30000);
    expect(parseDuration('1s')).toBe(1000);
  });

  it('should parse minutes', () => {
    expect(parseDuration('5m')).toBe(300000);
    expect(parseDuration('1m')).toBe(60000);
  });

  it('should parse hours', () => {
    expect(parseDuration('1h')).toBe(3600000);
    expect(parseDuration('2h')).toBe(7200000);
  });

  it('should throw error for invalid format', () => {
    expect(() => parseDuration('invalid')).toThrow('Invalid duration format');
    expect(() => parseDuration('10x')).toThrow('Invalid duration format');
  });
});

describe('getDefaultFlags', () => {
  it('should return all false/undefined defaults', () => {
    const defaults = getDefaultFlags();
    expect(defaults.json).toBe(false);
    expect(defaults.quiet).toBe(false);
    expect(defaults.verbose).toBe(false);
    expect(defaults.help).toBe(false);
    expect(defaults.version).toBe(false);
    expect(defaults.noColor).toBe(false);
    expect(defaults.configPath).toBeUndefined();
    expect(defaults.dryRun).toBe(false);
    expect(defaults.timeout).toBeUndefined();
    expect(defaults.noHooks).toBe(false);
  });
});
