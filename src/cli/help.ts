/**
 * Help system for Steroids CLI
 *
 * Provides templates and utilities for creating consistent,
 * comprehensive help text across all commands.
 */

import { colors } from './colors.js';
import { ErrorCode, ExitCode } from './errors.js';

/**
 * Help section structure
 */
export interface HelpSection {
  title: string;
  content: string;
}

/**
 * Command example
 */
export interface CommandExample {
  command: string;
  description: string;
}

/**
 * Option definition for help text
 */
export interface OptionDef {
  short?: string;
  long: string;
  description: string;
  values?: string;
  default?: string;
}

/**
 * Subcommand definition
 */
export interface SubcommandDef {
  name: string;
  description: string;
  args?: string;
}

/**
 * Related command reference
 */
export interface RelatedCommand {
  command: string;
  description: string;
}

/**
 * Help template configuration
 */
export interface HelpTemplate {
  /** Command name (e.g., 'tasks', 'sections') */
  command: string;
  /** Short one-line description */
  description: string;
  /** Detailed description (optional) */
  details?: string;
  /** Usage examples */
  usage?: string[];
  /** Subcommands */
  subcommands?: SubcommandDef[];
  /** Command-specific options */
  options?: OptionDef[];
  /** Examples with descriptions */
  examples?: CommandExample[];
  /** Related commands */
  related?: RelatedCommand[];
  /** Custom sections */
  sections?: HelpSection[];
  /** Whether to show global options (default: true) */
  showGlobalOptions?: boolean;
  /** Whether to show exit codes (default: true) */
  showExitCodes?: boolean;
  /** Whether to show environment variables (default: true) */
  showEnvVars?: boolean;
}

/**
 * Format an option for display
 */
function formatOption(opt: OptionDef): string {
  const flags = opt.short ? `-${opt.short}, --${opt.long}` : `    --${opt.long}`;
  const paddedFlags = flags.padEnd(24);

  let desc = opt.description;
  if (opt.values) {
    desc += `\n${' '.repeat(24)}Values: ${opt.values}`;
  }
  if (opt.default) {
    desc += `\n${' '.repeat(24)}Default: ${opt.default}`;
  }

  return `  ${paddedFlags}${desc}`;
}

/**
 * Format a subcommand for display
 */
function formatSubcommand(sub: SubcommandDef): string {
  const name = sub.args ? `${sub.name} ${sub.args}` : sub.name;
  const paddedName = name.padEnd(20);
  return `  ${paddedName}${sub.description}`;
}

/**
 * Format an example for display
 */
function formatExample(ex: CommandExample): string {
  return `  ${ex.command.padEnd(50)} # ${ex.description}`;
}

/**
 * Global options that apply to all commands
 */
const GLOBAL_OPTIONS: OptionDef[] = [
  { short: 'h', long: 'help', description: 'Show help' },
  { long: 'version', description: 'Show version' },
  { short: 'j', long: 'json', description: 'Output as JSON' },
  { short: 'q', long: 'quiet', description: 'Minimal output' },
  { short: 'v', long: 'verbose', description: 'Detailed output' },
  { long: 'no-color', description: 'Disable colored output' },
  { long: 'config', description: 'Custom config file path', values: '<path>' },
  { long: 'dry-run', description: 'Preview without executing' },
  { long: 'timeout', description: 'Command timeout', values: '<duration> (e.g., 30s, 5m, 1h)' },
  { long: 'no-hooks', description: 'Skip hook execution' },
  { long: 'no-wait', description: 'Don\'t wait for locks' },
];

/**
 * Environment variables section
 */
const ENV_VARS_SECTION = `
ENVIRONMENT VARIABLES:
  STEROIDS_CONFIG        Custom config path (--config)
  STEROIDS_JSON          Output as JSON (--json)
  STEROIDS_QUIET         Minimal output (--quiet)
  STEROIDS_VERBOSE       Detailed output (--verbose)
  STEROIDS_NO_HOOKS      Skip hooks (--no-hooks)
  STEROIDS_NO_COLOR      Disable colors (--no-color)
  STEROIDS_NO_WAIT       Don't wait for locks (--no-wait)
  STEROIDS_AUTO_MIGRATE  Auto-migrate database (1, true)
  STEROIDS_TIMEOUT       Command timeout (duration)
  NO_COLOR               Standard no-color variable
  CI                     CI environment detected
`;

/**
 * Exit codes section
 */
const EXIT_CODES_SECTION = `
EXIT CODES:
  0  Success
  1  General error
  2  Invalid arguments
  3  Configuration error or not initialized
  4  Resource not found
  5  Permission denied
  6  Resource locked
  7  Health check failed
`;

/**
 * Generate help text from template
 */
export function generateHelp(template: HelpTemplate): string {
  const lines: string[] = [];

  // Header
  lines.push(`steroids ${template.command} - ${template.description}`);
  lines.push('');

  // Usage
  if (template.usage && template.usage.length > 0) {
    lines.push('USAGE:');
    for (const usage of template.usage) {
      lines.push(`  ${usage}`);
    }
    lines.push('');
  } else {
    lines.push('USAGE:');
    lines.push(`  steroids ${template.command} [options]`);
    lines.push('');
  }

  // Detailed description
  if (template.details) {
    lines.push('DESCRIPTION:');
    const detailLines = template.details.trim().split('\n');
    for (const line of detailLines) {
      lines.push(line ? `  ${line}` : '');
    }
    lines.push('');
  }

  // Subcommands
  if (template.subcommands && template.subcommands.length > 0) {
    lines.push('SUBCOMMANDS:');
    for (const sub of template.subcommands) {
      lines.push(formatSubcommand(sub));
    }
    lines.push('');
  }

  // Command-specific options
  if (template.options && template.options.length > 0) {
    lines.push('OPTIONS:');
    for (const opt of template.options) {
      lines.push(formatOption(opt));
    }
    lines.push('');
  }

  // Global options
  if (template.showGlobalOptions !== false) {
    lines.push('GLOBAL OPTIONS:');
    for (const opt of GLOBAL_OPTIONS) {
      lines.push(formatOption(opt));
    }
    lines.push('');
  }

  // Examples
  if (template.examples && template.examples.length > 0) {
    lines.push('EXAMPLES:');
    for (const ex of template.examples) {
      lines.push(formatExample(ex));
    }
    lines.push('');
  }

  // Related commands
  if (template.related && template.related.length > 0) {
    lines.push('RELATED COMMANDS:');
    for (const rel of template.related) {
      lines.push(`  ${rel.command.padEnd(30)}${rel.description}`);
    }
    lines.push('');
  }

  // Custom sections
  if (template.sections && template.sections.length > 0) {
    for (const section of template.sections) {
      lines.push(`${section.title}:`);
      const sectionLines = section.content.trim().split('\n');
      for (const line of sectionLines) {
        lines.push(line ? `  ${line}` : '');
      }
      lines.push('');
    }
  }

  // Environment variables
  if (template.showEnvVars !== false) {
    lines.push(ENV_VARS_SECTION.trim());
    lines.push('');
  }

  // Exit codes
  if (template.showExitCodes !== false) {
    lines.push(EXIT_CODES_SECTION.trim());
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Quick help for simple commands
 *
 * Generates basic help text with just usage and options
 */
export function quickHelp(
  command: string,
  description: string,
  options: OptionDef[] = [],
  examples: CommandExample[] = []
): string {
  return generateHelp({
    command,
    description,
    options,
    examples,
  });
}

/**
 * Display error codes table
 */
export function showErrorCodes(): void {
  console.log('ERROR CODES AND EXIT CODES:\n');
  console.log('  Code                  Exit  Description');
  console.log('  ' + '─'.repeat(70));

  const codes = [
    ['SUCCESS', '0', 'Operation completed successfully'],
    ['GENERAL_ERROR', '1', 'Unspecified error'],
    ['INVALID_ARGUMENTS', '2', 'Bad command arguments'],
    ['CONFIG_ERROR', '3', 'Configuration problem'],
    ['NOT_FOUND', '4', 'Resource not found'],
    ['PERMISSION_DENIED', '5', 'Access denied'],
    ['RESOURCE_LOCKED', '6', 'Lock held by another'],
    ['HEALTH_FAILED', '7', 'Health check failed'],
    ['TASK_NOT_FOUND', '4', 'Task doesn\'t exist'],
    ['SECTION_NOT_FOUND', '4', 'Section doesn\'t exist'],
    ['TASK_LOCKED', '6', 'Task locked by runner'],
    ['NOT_INITIALIZED', '3', 'Steroids not initialized'],
    ['MIGRATION_REQUIRED', '3', 'Database needs migration'],
    ['HOOK_FAILED', '1', 'Hook execution failed'],
  ];

  for (const [code, exit, desc] of codes) {
    console.log(`  ${code.padEnd(20)} ${exit.padEnd(5)} ${desc}`);
  }
  console.log();
}

/**
 * Format a compact help hint for error messages
 */
export function helpHint(command?: string): string {
  if (command) {
    return `Run 'steroids ${command} --help' for usage information.`;
  }
  return `Run 'steroids --help' for usage information.`;
}

/**
 * Format a "Did you mean?" suggestion
 */
export function didYouMean(provided: string, options: string[]): string | null {
  // Simple Levenshtein distance for suggestions
  const distances = options.map(opt => ({
    option: opt,
    distance: levenshtein(provided.toLowerCase(), opt.toLowerCase()),
  }));

  distances.sort((a, b) => a.distance - b.distance);

  // Only suggest if distance is small enough (less than half the length)
  if (distances[0] && distances[0].distance <= provided.length / 2) {
    return `Did you mean '${distances[0].option}'?`;
  }

  return null;
}

/**
 * Simple Levenshtein distance for suggestions
 */
function levenshtein(a: string, b: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}
