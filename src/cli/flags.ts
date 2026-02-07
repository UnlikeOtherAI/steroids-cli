/**
 * Global flags parser for Steroids CLI
 *
 * Parses global flags that apply to all commands:
 * - Output format: --json, --quiet, --verbose
 * - Display: --no-color, --help
 * - Configuration: --config, --dry-run, --timeout, --no-hooks
 * - Version: --version
 */

/**
 * Parsed global options available to all commands
 */
export interface GlobalFlags {
  /** Output as JSON (-j, --json) */
  json: boolean;
  /** Minimal output (-q, --quiet) */
  quiet: boolean;
  /** Detailed output (-v, --verbose) */
  verbose: boolean;
  /** Show help (-h, --help) */
  help: boolean;
  /** Show version (--version) */
  version: boolean;
  /** Disable colors (--no-color) */
  noColor: boolean;
  /** Custom config path (--config) */
  configPath?: string;
  /** Preview without executing (--dry-run) */
  dryRun: boolean;
  /** Command timeout in milliseconds (--timeout) */
  timeout?: number;
  /** Skip hook execution (--no-hooks) */
  noHooks: boolean;
}

/**
 * Result of parsing global flags
 */
export interface ParsedArgs {
  /** Parsed global flags */
  flags: GlobalFlags;
  /** Remaining args after global flags are extracted */
  remaining: string[];
}

/**
 * Default values for global flags
 */
export function getDefaultFlags(): GlobalFlags {
  return {
    json: false,
    quiet: false,
    verbose: false,
    help: false,
    version: false,
    noColor: false,
    configPath: undefined,
    dryRun: false,
    timeout: undefined,
    noHooks: false,
  };
}

/**
 * Parse duration string to milliseconds
 * Supports: 30s, 5m, 1h, or plain number (ms)
 */
export function parseDuration(value: string): number {
  const match = value.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) {
    throw new Error(`Invalid duration format: ${value}. Use format: 30s, 5m, 1h, or milliseconds`);
  }

  const num = parseInt(match[1], 10);
  const unit = match[2] || 'ms';

  switch (unit) {
    case 'ms':
      return num;
    case 's':
      return num * 1000;
    case 'm':
      return num * 60 * 1000;
    case 'h':
      return num * 60 * 60 * 1000;
    default:
      return num;
  }
}

/**
 * Check if a value is truthy for boolean env vars
 */
function isTruthy(value: string | undefined): boolean {
  if (!value) return false;
  return value === '1' || value.toLowerCase() === 'true';
}

/**
 * Load flags from environment variables
 * Environment variables provide defaults that can be overridden by CLI flags
 */
export function loadEnvFlags(): Partial<GlobalFlags> {
  const env: Partial<GlobalFlags> = {};

  if (isTruthy(process.env.STEROIDS_JSON)) {
    env.json = true;
  }
  if (isTruthy(process.env.STEROIDS_QUIET)) {
    env.quiet = true;
  }
  if (isTruthy(process.env.STEROIDS_VERBOSE)) {
    env.verbose = true;
  }
  if (isTruthy(process.env.STEROIDS_NO_HOOKS)) {
    env.noHooks = true;
  }
  if (isTruthy(process.env.STEROIDS_NO_COLOR) || process.env.NO_COLOR !== undefined) {
    env.noColor = true;
  }
  if (process.env.STEROIDS_CONFIG) {
    env.configPath = process.env.STEROIDS_CONFIG;
  }
  if (process.env.STEROIDS_TIMEOUT) {
    try {
      env.timeout = parseDuration(process.env.STEROIDS_TIMEOUT);
    } catch {
      // Ignore invalid timeout from env
    }
  }

  return env;
}

/**
 * Parse global flags from command line arguments
 *
 * Global flags can appear anywhere in the args and are extracted,
 * leaving the remaining args for command-specific parsing.
 *
 * @param args - Command line arguments to parse
 * @returns Parsed flags and remaining arguments
 */
export function parseGlobalFlags(args: string[]): ParsedArgs {
  // Start with defaults, then apply env vars
  const flags: GlobalFlags = {
    ...getDefaultFlags(),
    ...loadEnvFlags(),
  };

  const remaining: string[] = [];
  let i = 0;

  while (i < args.length) {
    const arg = args[i];

    // Handle combined short flags like -jqv
    if (arg.match(/^-[jqvh]+$/) && arg.length > 2) {
      for (const char of arg.slice(1)) {
        switch (char) {
          case 'j':
            flags.json = true;
            break;
          case 'q':
            flags.quiet = true;
            break;
          case 'v':
            flags.verbose = true;
            break;
          case 'h':
            flags.help = true;
            break;
        }
      }
      i++;
      continue;
    }

    switch (arg) {
      case '-j':
      case '--json':
        flags.json = true;
        i++;
        break;

      case '-q':
      case '--quiet':
        flags.quiet = true;
        i++;
        break;

      case '-v':
      case '--verbose':
        flags.verbose = true;
        i++;
        break;

      case '-h':
      case '--help':
        flags.help = true;
        i++;
        break;

      case '--version':
        flags.version = true;
        i++;
        break;

      case '--no-color':
        flags.noColor = true;
        i++;
        break;

      case '--dry-run':
        flags.dryRun = true;
        i++;
        break;

      case '--no-hooks':
        flags.noHooks = true;
        i++;
        break;

      case '--config':
        if (i + 1 >= args.length) {
          throw new Error('--config requires a path argument');
        }
        flags.configPath = args[i + 1];
        i += 2;
        break;

      case '--timeout':
        if (i + 1 >= args.length) {
          throw new Error('--timeout requires a duration argument');
        }
        flags.timeout = parseDuration(args[i + 1]);
        i += 2;
        break;

      default:
        // Handle --config=value and --timeout=value syntax
        if (arg.startsWith('--config=')) {
          flags.configPath = arg.slice('--config='.length);
          i++;
        } else if (arg.startsWith('--timeout=')) {
          flags.timeout = parseDuration(arg.slice('--timeout='.length));
          i++;
        } else {
          // Not a global flag, pass through to remaining
          remaining.push(arg);
          i++;
        }
    }
  }

  // Validate conflicting flags
  if (flags.quiet && flags.verbose) {
    throw new Error('Cannot use --quiet and --verbose together');
  }

  return { flags, remaining };
}

/**
 * Apply global flags to affect runtime behavior
 * Call this after parsing to set up the environment
 */
export function applyGlobalFlags(flags: GlobalFlags): void {
  // Disable colors if requested
  if (flags.noColor) {
    process.env.NO_COLOR = '1';
  }
}
