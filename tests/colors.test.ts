/**
 * Tests for colored output support
 */

import { colors, markers, formatError, formatSuccess, formatWarning, formatInfo } from '../src/cli/colors.js';

describe('Color Support', () => {
  const originalEnv = { ...process.env };
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    // Reset environment
    delete process.env.NO_COLOR;
    delete process.env.STEROIDS_NO_COLOR;
    // Mock TTY
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });
  });

  afterAll(() => {
    // Restore environment
    Object.assign(process.env, originalEnv);
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
  });

  describe('colors', () => {
    it('should apply red color when colors are enabled', () => {
      const result = colors.red('error');
      expect(result).toContain('error');
      expect(result).toMatch(/\x1b\[31m.*\x1b\[0m/); // Red ANSI code
    });

    it('should apply green color when colors are enabled', () => {
      const result = colors.green('success');
      expect(result).toContain('success');
      expect(result).toMatch(/\x1b\[32m.*\x1b\[0m/); // Green ANSI code
    });

    it('should apply yellow color when colors are enabled', () => {
      const result = colors.yellow('warning');
      expect(result).toContain('warning');
      expect(result).toMatch(/\x1b\[33m.*\x1b\[0m/); // Yellow ANSI code
    });

    it('should not apply colors when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      const result = colors.red('error');
      expect(result).toBe('error');
      expect(result).not.toMatch(/\x1b/);
    });

    it('should not apply colors when STEROIDS_NO_COLOR is set to "1"', () => {
      process.env.STEROIDS_NO_COLOR = '1';
      const result = colors.green('success');
      expect(result).toBe('success');
      expect(result).not.toMatch(/\x1b/);
    });

    it('should not apply colors when STEROIDS_NO_COLOR is set to "true"', () => {
      process.env.STEROIDS_NO_COLOR = 'true';
      const result = colors.blue('info');
      expect(result).toBe('info');
      expect(result).not.toMatch(/\x1b/);
    });

    it('should not apply colors when stdout is not a TTY', () => {
      Object.defineProperty(process.stdout, 'isTTY', {
        value: false,
        configurable: true,
      });
      const result = colors.red('error');
      expect(result).toBe('error');
      expect(result).not.toMatch(/\x1b/);
    });
  });

  describe('markers', () => {
    it('should create success marker with checkmark', () => {
      const result = markers.success();
      expect(result).toContain('✓');
    });

    it('should create success marker with text', () => {
      const result = markers.success('Operation completed');
      expect(result).toContain('✓');
      expect(result).toContain('Operation completed');
    });

    it('should create error marker with X', () => {
      const result = markers.error();
      expect(result).toContain('✗');
    });

    it('should create warning marker with warning symbol', () => {
      const result = markers.warning('Be careful');
      expect(result).toContain('⚠');
      expect(result).toContain('Be careful');
    });

    it('should create info marker', () => {
      const result = markers.info('Information');
      expect(result).toContain('ℹ');
      expect(result).toContain('Information');
    });

    it('should create pending marker', () => {
      const result = markers.pending('Waiting');
      expect(result).toContain('○');
      expect(result).toContain('Waiting');
    });

    it('should create progress marker', () => {
      const result = markers.progress('In progress');
      expect(result).toContain('◐');
      expect(result).toContain('In progress');
    });

    it('should create completed marker', () => {
      const result = markers.completed('Done');
      expect(result).toContain('●');
      expect(result).toContain('Done');
    });

    it('should not apply colors to markers when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      const result = markers.success('test');
      expect(result).toContain('✓');
      expect(result).toContain('test');
      expect(result).not.toMatch(/\x1b/);
    });
  });

  describe('formatters', () => {
    it('should format error message in red', () => {
      const result = formatError('Something went wrong');
      expect(result).toContain('Error: Something went wrong');
      expect(result).toMatch(/\x1b\[31m.*\x1b\[0m/);
    });

    it('should format success message in green', () => {
      const result = formatSuccess('Operation succeeded');
      expect(result).toContain('Operation succeeded');
      expect(result).toMatch(/\x1b\[32m.*\x1b\[0m/);
    });

    it('should format warning message in yellow', () => {
      const result = formatWarning('Be careful');
      expect(result).toContain('Warning: Be careful');
      expect(result).toMatch(/\x1b\[33m.*\x1b\[0m/);
    });

    it('should format info message in blue', () => {
      const result = formatInfo('For your information');
      expect(result).toContain('For your information');
      expect(result).toMatch(/\x1b\[34m.*\x1b\[0m/);
    });

    it('should not apply colors to formatters when NO_COLOR is set', () => {
      process.env.NO_COLOR = '1';
      const result = formatError('error');
      expect(result).toBe('Error: error');
      expect(result).not.toMatch(/\x1b/);
    });
  });

  describe('bright colors', () => {
    it('should apply bright red color', () => {
      const result = colors.brightRed('critical');
      expect(result).toContain('critical');
      expect(result).toMatch(/\x1b\[91m.*\x1b\[0m/);
    });

    it('should apply bright green color', () => {
      const result = colors.brightGreen('excellent');
      expect(result).toContain('excellent');
      expect(result).toMatch(/\x1b\[92m.*\x1b\[0m/);
    });

    it('should apply bright yellow color', () => {
      const result = colors.brightYellow('important');
      expect(result).toContain('important');
      expect(result).toMatch(/\x1b\[93m.*\x1b\[0m/);
    });
  });

  describe('text styles', () => {
    it('should apply bold style', () => {
      const result = colors.bold('emphasized');
      expect(result).toContain('emphasized');
      expect(result).toMatch(/\x1b\[1m.*\x1b\[0m/);
    });

    it('should apply dim style', () => {
      const result = colors.dim('subtle');
      expect(result).toContain('subtle');
      expect(result).toMatch(/\x1b\[2m.*\x1b\[0m/);
    });

    it('should not apply styles when colors are disabled', () => {
      process.env.NO_COLOR = '1';
      const bold = colors.bold('text');
      const dim = colors.dim('text');
      expect(bold).toBe('text');
      expect(dim).toBe('text');
      expect(bold).not.toMatch(/\x1b/);
      expect(dim).not.toMatch(/\x1b/);
    });
  });

  describe('NO_COLOR standard compliance', () => {
    it('should respect NO_COLOR with any value', () => {
      process.env.NO_COLOR = '';
      const result = colors.red('test');
      expect(result).toBe('test');
      expect(result).not.toMatch(/\x1b/);
    });

    it('should respect NO_COLOR even if set to 0', () => {
      process.env.NO_COLOR = '0';
      const result = colors.green('test');
      expect(result).toBe('test');
      expect(result).not.toMatch(/\x1b/);
    });

    it('should prioritize NO_COLOR over TTY detection', () => {
      process.env.NO_COLOR = '1';
      Object.defineProperty(process.stdout, 'isTTY', {
        value: true,
        configurable: true,
      });
      const result = colors.blue('test');
      expect(result).toBe('test');
      expect(result).not.toMatch(/\x1b/);
    });
  });
});
